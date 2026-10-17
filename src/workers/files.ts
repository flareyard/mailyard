import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { Env } from "../Bindings.ts"
import { sha256Hex } from "../inbound/parse.ts"
import { BlobStore, Ids } from "../kit/index.ts"
import { type Access, requireMailbox } from "../mail/access.ts"
import { verifyFileToken } from "../mail/files.ts"
import { callMailbox } from "../mail/rpc.ts"
import { authorize, problem } from "./auth.ts"
import { runtimeFor } from "./inbound.ts"

/** Uploads larger than this are refused; Email Service sends at most 5 MiB, bigger files go as links. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const UPLOAD_PATH = /^\/v1\/mailboxes\/([^/]+)\/uploads$/
export const RAW_PATH = /^\/v1\/mailboxes\/([^/]+)\/messages\/([^/]+)\/raw$/
export const ATTACHMENT_PATH = /^\/v1\/mailboxes\/([^/]+)\/messages\/([^/]+)\/attachments\/([^/]+)$/
export const FILE_PATH = /^\/v1\/files\/([^/]+)$/

/** RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name. */
const disposition = (kind: "attachment" | "inline", filename: string) => {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Bytes are served as files, never rendered as pages from our origin: no sniffing, a sandbox for anything inline. */
const serve = (body: Uint8Array, type: string, kind: "attachment" | "inline", filename: string) =>
  new Response(body, {
    headers: {
      "content-type": type,
      "content-disposition": disposition(kind, filename),
      "content-length": String(body.byteLength),
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      "cache-control": "private, max-age=300",
    },
  })

const gate = async (request: Request, env: Env, mailboxId: string, need: Access) => {
  const auth = await authorize(request, env)
  if (auth instanceof Response) return auth
  const granted = await runtimeFor(env).runPromise(
    Effect.result(requireMailbox(auth.caller, mailboxId, need)),
  )
  if (granted._tag === "Success") return { caller: auth.caller }
  const failure = granted.failure
  if (failure._tag === "MailboxMissing") return problem(404, `Mailbox ${mailboxId} not found.`)
  if (failure._tag === "MailboxAccessDenied") return problem(403, failure.message)
  return problem(500, "Could not check access.")
}

/** `POST /v1/mailboxes/{id}/uploads`: the request body is the file; name it with `?filename=`. */
export const handleUpload = async (request: Request, env: Env, mailboxId: string) => {
  if (request.method !== "POST") return problem(405, "Use POST with the file as the request body.")
  const allowed = await gate(request, env, mailboxId, "write")
  if (allowed instanceof Response) return allowed
  const url = new URL(request.url)
  const filename = (url.searchParams.get("filename") ?? request.headers.get("x-filename") ?? "").trim()
  if (!filename || filename.length > 255 || /[/\\\0]/.test(filename))
    return problem(400, "Name the file with ?filename= (no slashes).")
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_UPLOAD_BYTES)
    return problem(413, `Uploads are at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB.`)
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength === 0) return problem(400, "The upload is empty.")
  if (bytes.byteLength > MAX_UPLOAD_BYTES)
    return problem(413, `Uploads are at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB.`)
  const mimeType =
    (request.headers.get("content-type") ?? "application/octet-stream").split(";")[0]?.trim() ||
    "application/octet-stream"
  const result = await runtimeFor(env).runPromise(
    Effect.gen(function* () {
      const id = yield* (yield* Ids).next
      const key = `upl/${mailboxId}/${id}`
      yield* (yield* BlobStore).put(key, bytes, mimeType)
      return {
        key,
        filename,
        mimeType,
        size: bytes.byteLength,
        sha256: yield* Effect.promise(() => sha256Hex(bytes)),
      }
    }),
  )
  return Response.json(result, { status: 201 })
}

const messageOf = async (env: Env, mailboxId: string, messageId: string) =>
  runtimeFor(env).runPromise(
    callMailbox(mailboxId, (s) => s.message(messageId)).pipe(Effect.orElseSucceed(() => null)),
  )

const blob = async (env: Env, key: string) =>
  runtimeFor(env).runPromise(
    Effect.gen(function* () {
      return yield* (yield* BlobStore).get(key)
    }).pipe(Effect.orElseSucceed(() => Option.none())),
  )

/** `GET /v1/mailboxes/{id}/messages/{messageId}/raw`: the original `.eml`. */
export const handleRaw = async (request: Request, env: Env, mailboxId: string, messageId: string) => {
  const allowed = await gate(request, env, mailboxId, "read")
  if (allowed instanceof Response) return allowed
  const message = await messageOf(env, mailboxId, messageId)
  if (!message) return problem(404, `Message ${messageId} not found.`)
  const raw = await blob(env, message.rawKey)
  if (Option.isNone(raw)) return problem(404, "The original of this message is no longer stored.")
  return serve(raw.value.body, "message/rfc822", "attachment", `${messageId}.eml`)
}

/** `GET /v1/mailboxes/{id}/messages/{messageId}/attachments/{attachmentId}`. */
export const handleAttachment = async (
  request: Request,
  env: Env,
  mailboxId: string,
  messageId: string,
  attachmentId: string,
) => {
  const allowed = await gate(request, env, mailboxId, "read")
  if (allowed instanceof Response) return allowed
  const message = await messageOf(env, mailboxId, messageId)
  const attachment = message?.attachments.find((a) => a.id === attachmentId)
  if (!attachment) return problem(404, `Attachment ${attachmentId} not found.`)
  const file = await blob(env, attachment.r2Key)
  if (Option.isNone(file)) return problem(404, "This attachment is no longer stored.")
  return serve(
    file.value.body,
    attachment.mimeType,
    attachment.related ? "inline" : "attachment",
    attachment.filename ?? "attachment",
  )
}

/** `GET /v1/files/{token}`: a signed, expiring link. The token is the authorisation. */
export const handleFile = async (_request: Request, env: Env, token: string) => {
  const claim = await runtimeFor(env).runPromise(Effect.result(verifyFileToken(token)))
  if (claim._tag === "Failure") {
    return claim.failure.reason === "expired"
      ? problem(410, "This link has expired.")
      : problem(403, "This link isn't valid.")
  }
  const file = await blob(env, claim.success.k)
  if (Option.isNone(file)) return problem(404, "This file is no longer stored.")
  return serve(file.value.body, claim.success.t, claim.success.d, claim.success.n)
}

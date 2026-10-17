import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"

/**
 * Links to stored files that work without an API key: a browser's <img src>, a download button, or a
 * large attachment turned into a link in a sent message. The token carries the R2 key, the name and type
 * to serve it with, and an expiry, signed with HMAC-SHA256. R2's own presigned URLs need S3 credentials
 * the Worker doesn't hold, so the Worker signs and serves them itself at GET /v1/files/{token}.
 */
export interface FileClaim {
  /** R2 key. */
  readonly k: string
  /** File name for Content-Disposition. */
  readonly n: string
  /** Content-Type. */
  readonly t: string
  /** `attachment` to download, `inline` to show. */
  readonly d: "attachment" | "inline"
  /** Expiry, Unix seconds. */
  readonly e: number
}

export class FileLinkInvalid extends Schema.TaggedError<FileLinkInvalid>()("FileLinkInvalid", {
  reason: Schema.Literals(["malformed", "signature", "expired", "unconfigured"]),
}) {}

export const ATTACHMENT_LINK_TTL_SECONDS = 60 * 60
/** Large attachments sent as links stay downloadable for a week. */
export const LARGE_ATTACHMENT_LINK_TTL_SECONDS = 7 * 24 * 60 * 60

const enc = new TextEncoder()
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))

/**
 * The signing key: FILE_SIGNING_KEY, or one derived from ADMIN_KEY with HKDF when that secret isn't set,
 * so links keep working on a deploy that predates the secret. Rotating either invalidates every link.
 */
const signingKey = Effect.gen(function* () {
  const env = yield* Bindings
  const secret = env.FILE_SIGNING_KEY ?? env.ADMIN_KEY
  if (!secret) return yield* new FileLinkInvalid({ reason: "unconfigured" })
  return yield* Effect.promise(async () => {
    const raw = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"])
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("mailyard"), info: enc.encode("mailyard/files/v1") },
      raw,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    )
  })
})

export const signFileToken = Effect.fn("files.sign")(function* (
  claim: Omit<FileClaim, "e">,
  ttlSeconds: number,
) {
  const key = yield* signingKey
  const payload = b64url(
    enc.encode(JSON.stringify({ ...claim, e: Math.floor(Date.now() / 1000) + ttlSeconds })),
  )
  const signature = new Uint8Array(
    yield* Effect.promise(() => crypto.subtle.sign("HMAC", key, enc.encode(payload))),
  )
  return `${payload}.${b64url(signature)}`
})

export const fileUrl = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/v1/files/${token}`

export const verifyFileToken = Effect.fn("files.verify")(function* (token: string) {
  const [payload, signature, extra] = token.split(".")
  if (!payload || !signature || extra !== undefined)
    return yield* new FileLinkInvalid({ reason: "malformed" })
  const key = yield* signingKey
  let sig: Uint8Array
  let claim: FileClaim
  try {
    sig = fromB64url(signature)
    claim = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as FileClaim
  } catch {
    return yield* new FileLinkInvalid({ reason: "malformed" })
  }
  const valid = yield* Effect.promise(() => crypto.subtle.verify("HMAC", key, sig, enc.encode(payload)))
  if (!valid) return yield* new FileLinkInvalid({ reason: "signature" })
  if (typeof claim.e !== "number" || claim.e < Math.floor(Date.now() / 1000)) {
    return yield* new FileLinkInvalid({ reason: "expired" })
  }
  return claim
})

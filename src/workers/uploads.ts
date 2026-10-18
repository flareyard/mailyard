import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { createUpload, MAX_UPLOAD_BYTES } from "../imports/contactImport.ts"
import { authorize, problem, refuseUnless } from "./auth.ts"
import { runtimeFor } from "./inbound.ts"

export const UPLOADS_PATH = /^\/v1\/uploads$/

const MIB = 1024 * 1024

/**
 * `POST /v1/uploads?filename=`: the request body is the file (a CSV to import, at most 50 MiB). It is
 * stored in R2 and answered with an id that `POST /v1/imports/contacts` takes. Needs the admin scope.
 */
export const handleUploads = async (request: Request, env: Env) => {
  if (request.method !== "POST") return problem(405, "Use POST with the file as the request body.")
  const auth = await authorize(request, env)
  if (auth instanceof Response) return auth
  const refused = refuseUnless(auth.caller, "admin", "contacts.write")
  if (refused) return refused
  const filename = (
    new URL(request.url).searchParams.get("filename") ??
    request.headers.get("x-filename") ??
    ""
  ).trim()
  if (!filename || filename.length > 255 || /[/\\\0]/.test(filename))
    return problem(400, "Name the file with ?filename= (no slashes).")
  if (Number(request.headers.get("content-length") ?? "0") > MAX_UPLOAD_BYTES)
    return problem(413, `Uploads are at most ${MAX_UPLOAD_BYTES / MIB} MiB.`)
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength === 0) return problem(400, "The upload is empty.")
  if (bytes.byteLength > MAX_UPLOAD_BYTES)
    return problem(413, `Uploads are at most ${MAX_UPLOAD_BYTES / MIB} MiB.`)
  const mimeType =
    (request.headers.get("content-type") ?? "application/octet-stream").split(";")[0]?.trim() ||
    "application/octet-stream"
  const result = await runtimeFor(env).runPromise(
    Effect.result(createUpload({ bytes, filename, mimeType }, auth.caller.keyId)),
  )
  if (result._tag === "Failure") return problem(500, "Could not store the upload.")
  return Response.json(result.success, { status: 201 })
}

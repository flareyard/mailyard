import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { Env } from "../Bindings.ts"
import { auditCsv } from "../domain/auditLog.ts"
import { logoKey } from "../domain/brand.ts"
import { importErrorsCsv } from "../imports/contactImport.ts"
import { BlobStore } from "../kit/index.ts"
import { authorize, problem } from "./auth.ts"
import { runtimeFor } from "./inbound.ts"

/**
 * `GET /brand/logo/<sha256>.<ext>`: the workspace's logo, public (it appears in mail and on the
 * public pages), cached for good since the name is the content's hash.
 */
export const handleBrandLogo = async (request: Request, env: Env, file: string) => {
  if (request.method !== "GET" && request.method !== "HEAD") return problem(405, "Use GET.")
  const blob = await runtimeFor(env).runPromise(
    BlobStore.use((s) => s.get(logoKey(file))).pipe(Effect.orElseSucceed(() => Option.none())),
  )
  if (Option.isNone(blob)) return problem(404, "No such logo.")
  const ext = file.slice(file.lastIndexOf(".") + 1)
  const type = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext]
  return new Response(request.method === "HEAD" ? null : blob.value.body, {
    headers: {
      "content-type": type ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "access-control-allow-origin": "*",
    },
  })
}

/** `GET /v1/audit?format=csv`: the audit log as CSV, with the JSON route's filters. Admin keys only. */
export const handleAuditCsv = async (request: Request, env: Env) => {
  const auth = await authorize(request, env)
  if (auth instanceof Response) return auth
  if (auth.caller.kind !== "secret" || !auth.caller.scopes.includes("admin"))
    return problem(403, 'The audit log needs a secret key with the "admin" scope.', { required: "admin" })
  const q = new URL(request.url).searchParams
  const num = (k: string) => {
    const v = q.get(k)
    return v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined
  }
  const { csv, rows, truncated } = await runtimeFor(env).runPromise(
    auditCsv({
      actor: q.get("actor") ?? undefined,
      action: q.get("action") ?? undefined,
      target: q.get("target") ?? undefined,
      from: num("from"),
      to: num("to"),
    }).pipe(Effect.orDie),
  )
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="mailyard-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-rows": String(rows),
      "x-truncated": String(truncated),
    },
  })
}

export const IMPORT_ERRORS_PATH = /^\/v1\/imports\/([^/]+)\/errors\.csv$/

/** `GET /v1/imports/{id}/errors.csv`: every rejected row of a contact import (HAL-3371). */
export const handleImportErrorsCsv = async (request: Request, env: Env, id: string) => {
  if (request.method !== "GET") return problem(405, "Use GET.")
  const auth = await authorize(request, env)
  if (auth instanceof Response) return auth
  if (auth.caller.kind !== "secret" || !auth.caller.scopes.includes("read"))
    return problem(403, 'This needs a secret key with the "read" scope.', { required: "read" })
  const result = await runtimeFor(env).runPromise(Effect.result(importErrorsCsv(id)))
  if (result._tag === "Failure") {
    const tag = (result.failure as { _tag?: string })._tag
    return tag === "ImportNotFound"
      ? problem(404, `Import ${id} not found.`)
      : problem(500, "Couldn't read the errors.")
  }
  return new Response(result.success, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${id}-errors.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  })
}

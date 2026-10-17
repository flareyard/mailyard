import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { authenticate, type Caller } from "../domain/apiKeys.ts"
import { runtimeFor } from "./inbound.ts"

/** The subprotocol a browser asks for on a WebSocket; it carries the key as a second one, `bearer.<key>`. */
export const LIVE_PROTOCOL = "mailyard.v1"

export const problem = (status: number, message: string, extra: Readonly<Record<string, unknown>> = {}) =>
  Response.json(
    { error: { status, message, ...extra } },
    { status, headers: { "cache-control": "no-store" } },
  )

/**
 * The key on a request outside the JSON API: `Authorization: Bearer`, or for WebSockets (which can't
 * set headers in a browser) the subprotocol pair `mailyard.v1, bearer.<key>`. Never the URL, where
 * logs would keep it.
 */
export const credentials = (request: Request) => {
  const header = request.headers.get("authorization")
  if (header?.toLowerCase().startsWith("bearer ")) return { token: header.slice(7).trim(), protocol: null }
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  const bearer = offered.find((p) => p.startsWith("bearer."))
  if (offered.includes(LIVE_PROTOCOL) && bearer) return { token: bearer.slice(7), protocol: LIVE_PROTOCOL }
  return null
}

/** The calling key, or the 401 response to send back. */
export const authorize = async (
  request: Request,
  env: Env,
): Promise<{ caller: Caller; protocol: string | null } | Response> => {
  const auth = credentials(request)
  if (!auth)
    return problem(
      401,
      `Send Authorization: Bearer, or the subprotocols ${LIVE_PROTOCOL} and bearer.<key>.`,
      {
        reason: "missing",
      },
    )
  const result = await runtimeFor(env).runPromise(Effect.result(authenticate(auth.token)))
  if (result._tag === "Failure")
    return problem(401, result.failure.reason, {
      reason: result.failure.code,
      ...(result.failure.revokedAt !== undefined ? { revokedAt: result.failure.revokedAt } : {}),
    })
  return { caller: result.success, protocol: auth.protocol }
}

import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { authenticate, type Caller, type Scope } from "../domain/apiKeys.ts"
import { allowedRoles, can, type Permission } from "../domain/permissions.ts"
import { resolveSession, SESSION_COOKIE } from "../domain/sessions.ts"
import { authenticateAccessToken } from "../oauth/grants.ts"
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

/** The session cookie's token, if the request carries one. */
export const sessionToken = (request: Request) => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) return part.slice(at + 1).trim() || null
  }
  return null
}

/**
 * Whether a cookie-signed request came from this site: a write, and any WebSocket (whose handshake
 * is a GET a page on another site could open), must carry this origin (HAL-3358).
 */
const fromThisSite = (request: Request, publicOrigin: string | undefined) => {
  const origin = request.headers.get("origin")
  if (origin) {
    if (origin === new URL(request.url).origin) return true
    try {
      return publicOrigin !== undefined && origin === new URL(publicOrigin).origin
    } catch {
      return false
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin"
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"])

/** The clearing Set-Cookie for a session that no longer works. */
const CLEAR_COOKIE = `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`

/**
 * The calling key (by Bearer, WebSocket subprotocol or session cookie), or the response to send back.
 * `resources` are the audiences this route answers for; only a route that names some accepts an
 * OAuth access token (HAL-3462), and only one issued for one of them (RFC 8707).
 */
export const authorize = async (
  request: Request,
  env: Env,
  options: { readonly resources?: ReadonlyArray<string> } = {},
): Promise<{ caller: Caller; protocol: string | null } | Response> => {
  const auth = credentials(request)
  if (auth?.token.startsWith("oat_")) {
    if (!options.resources)
      return problem(401, "OAuth access tokens only work on /mcp, the resource they were issued for.", {
        reason: "wrong-resource",
      })
    const access = await runtimeFor(env).runPromise(authenticateAccessToken(auth.token, options.resources))
    if ("refused" in access)
      return problem(401, access.refused.message, {
        reason: access.refused.code === "wrong_resource" ? "wrong-resource" : "invalid-token",
      })
    return { caller: access.caller, protocol: auth.protocol }
  }
  if (!auth) {
    const token = sessionToken(request)
    if (!token)
      return problem(
        401,
        `Send Authorization: Bearer, the subprotocols ${LIVE_PROTOCOL} and bearer.<key>, or sign in at POST /v1/session.`,
        { reason: "missing" },
      )
    const session = await runtimeFor(env).runPromise(Effect.result(resolveSession(token)))
    if (session._tag === "Failure") {
      const response = problem(401, session.failure.message, { reason: "session-expired" })
      response.headers.append("set-cookie", CLEAR_COOKIE)
      return response
    }
    const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket"
    if ((websocket || !SAFE.has(request.method)) && !fromThisSite(request, env.MAILYARD_PUBLIC_ORIGIN))
      return problem(
        403,
        "This request was signed in by the session cookie but didn't come from this site, so it was refused.",
        { reason: "csrf" },
      )
    // A browser WebSocket signed in by cookie may still offer mailyard.v1; echo it back if so.
    const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim())
    return { caller: session.success, protocol: offered.includes(LIVE_PROTOCOL) ? LIVE_PROTOCOL : null }
  }
  const result = await runtimeFor(env).runPromise(Effect.result(authenticate(auth.token)))
  if (result._tag === "Failure")
    return problem(401, result.failure.reason, {
      reason: result.failure.code,
      ...(result.failure.revokedAt !== undefined ? { revokedAt: result.failure.revokedAt } : {}),
    })
  return { caller: result.success, protocol: auth.protocol }
}

/**
 * The raw routes' version of `requireScope`: a key needs `scope`, a signed-in person needs
 * `permission` from their role (HAL-3361). Null when allowed, else the 403 to send back.
 */
export const refuseUnless = (caller: Caller, scope: Scope, permission: Permission): Response | null => {
  if (caller.member)
    return can(caller, permission)
      ? null
      : problem(403, `Your role (${caller.member.role}) can't do this. Ask an owner or admin.`, {
          reason: "role",
          required: permission,
          role: caller.member.role,
          allowedRoles: [...allowedRoles(permission)],
        })
  if (caller.kind === "secret" && caller.scopes.includes(scope)) return null
  return problem(403, `This needs a secret key with the "${scope}" scope.`, {
    reason: caller.kind === "public" ? "public-key" : "insufficient-scope",
    required: scope,
  })
}

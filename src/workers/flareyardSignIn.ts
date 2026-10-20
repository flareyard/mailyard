import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { randomToken } from "../domain/crypto.ts"
import { callerFor, signInFromFlareyard } from "../domain/people.ts"
import { ROLE_SCOPES } from "../domain/permissions.ts"
import { clientOf, openSession, SESSION_COOKIE, SESSION_MAX_MS } from "../domain/sessions.ts"
import { problem } from "./auth.ts"
import { runtimeFor } from "./inbound.ts"

/**
 * "Open Mailyard" from Flareyard (HAL-3360, flareyard/flareyard#26). On an install the platform made,
 * the person who owns it arrives signed in instead of asking for an emailed link:
 *
 * 1. `GET /v1/session/flareyard/start?return=/path` keeps a PKCE verifier and a state in a
 *    ten-minute cookie and sends the browser to `${FLAREYARD_URL}/auth/app`.
 * 2. The platform signs them in, checks they own this install, and comes back to the callback with
 *    a two-minute, single-use code.
 * 3. `GET /v1/session/flareyard/callback` checks the state, exchanges the code with the verifier at
 *    `POST ${FLAREYARD_URL}/api/v1/installs/{id}/session`, checks the answer names this install, and
 *    opens a Mailyard session for them.
 *
 * Self-deployed installs have no FLAREYARD_URL: both routes answer 404 and /openapi.json leaves them
 * out, so the web app never offers the button.
 */
export const FLAREYARD_START_PATH = "/v1/session/flareyard/start"
export const FLAREYARD_CALLBACK_PATH = "/v1/session/flareyard/callback"

/** Paths /openapi.json lists only on installs Flareyard made. */
export const PLATFORM_ONLY_PATHS: ReadonlySet<string> = new Set([
  FLAREYARD_START_PATH,
  FLAREYARD_CALLBACK_PATH,
])

const FLOW_COOKIE = "__Host-mailyard_flareyard"
const FLOW_MS = 10 * 60_000

/** The platform's URL and this install's id, when Flareyard installed this deployment. */
export const flareyardSignIn = (env: Env) => {
  const url = env.FLAREYARD_URL?.trim().replace(/\/+$/, "")
  const install = env.FLAREYARD_INSTALL_ID?.trim()
  if (!url || !install) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") return null
  } catch {
    return null
  }
  return { url, install }
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  let s = ""
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** A path on this site to land on afterwards; anything else lands on the app's home. */
const safePath = (raw: string | null | undefined) =>
  raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\") && raw.length <= 2000 ? raw : "/"

const cookieOf = (request: Request, name: string) => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return null
}

const clearFlow = `${FLOW_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`

/** Back to the sign-in page with a reason the page can word, and the flow cookie gone. */
const toSignIn = (reason: string) =>
  new Response(null, {
    status: 303,
    headers: {
      location: `/sign-in?error=${encodeURIComponent(reason)}`,
      "cache-control": "no-store",
      "set-cookie": clearFlow,
    },
  })

const notHere = () =>
  problem(404, "This install wasn't made by Flareyard, so it signs in with an emailed link.", {
    reason: "flareyard-not-configured",
  })

export const handleFlareyardStart = async (request: Request, env: Env) => {
  const platform = flareyardSignIn(env)
  if (!platform) return notHere()
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } })
  const url = new URL(request.url)
  const state = randomToken(24)
  const verifier = randomToken(48)
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  const back = safePath(url.searchParams.get("return"))
  const target = new URL(`${platform.url}/auth/app`)
  target.searchParams.set("install", platform.install)
  // The host the browser is on: the callback must come back here, where the flow cookie is.
  target.searchParams.set("origin", url.origin)
  target.searchParams.set("state", state)
  target.searchParams.set("code_challenge", challenge)
  target.searchParams.set("code_challenge_method", "S256")
  const flow = `${state}.${verifier}.${b64url(new TextEncoder().encode(back))}`
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      "set-cookie": `${FLOW_COOKIE}=${flow}; Max-Age=${FLOW_MS / 1000}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    },
  })
}

type Exchanged =
  | {
      readonly ok: true
      readonly user: { id: string; email: string; name: string | null }
      readonly installation: string
    }
  | { readonly ok: false; readonly reason: string }

const exchange = async (
  platform: { url: string; install: string },
  code: string,
  verifier: string,
): Promise<Exchanged> => {
  try {
    const response = await fetch(
      `${platform.url}/api/v1/installs/${encodeURIComponent(platform.install)}/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier }),
        signal: AbortSignal.timeout(10_000),
      },
    )
    const body = (await response.json().catch(() => null)) as {
      user?: { id?: unknown; email?: unknown; name?: unknown }
      installation?: unknown
      error?: unknown
    } | null
    if (response.status === 400)
      return {
        ok: false,
        reason: body?.error === "invalid_grant" ? "flareyard_session_expired" : "flareyard_refused",
      }
    if (!response.ok || !body) return { ok: false, reason: "flareyard_unreachable" }
    const user = body.user
    if (
      typeof user?.id !== "string" ||
      typeof user.email !== "string" ||
      typeof body.installation !== "string"
    )
      return { ok: false, reason: "flareyard_refused" }
    return {
      ok: true,
      user: { id: user.id, email: user.email, name: typeof user.name === "string" ? user.name : null },
      installation: body.installation,
    }
  } catch {
    return { ok: false, reason: "flareyard_unreachable" }
  }
}

export const handleFlareyardCallback = async (request: Request, env: Env) => {
  const platform = flareyardSignIn(env)
  if (!platform) return notHere()
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } })
  const url = new URL(request.url)
  const denied = url.searchParams.get("error")
  if (denied) return toSignIn(denied === "access_denied" ? "flareyard_denied" : "flareyard_refused")
  const flow = cookieOf(request, FLOW_COOKIE)
  const [state, verifier, packedBack] = (flow ?? "").split(".")
  const code = url.searchParams.get("code") ?? ""
  // A callback this browser didn't start (or one that took over ten minutes) signs nobody in.
  if (!state || !verifier || !code || url.searchParams.get("state") !== state)
    return toSignIn("flareyard_state")
  const answer = await exchange(platform, code, verifier)
  if (!answer.ok) return toSignIn(answer.reason)
  if (answer.installation !== platform.install) return toSignIn("flareyard_wrong_install")
  const run = runtimeFor(env)
  const result = await run.runPromise(
    Effect.result(
      signInFromFlareyard(answer.user).pipe(
        Effect.flatMap(({ member }) =>
          openSession(
            { ...callerFor(member), scopes: ROLE_SCOPES[member.role] },
            clientOf(Object.fromEntries(request.headers)),
          ),
        ),
      ),
    ),
  )
  if (result._tag === "Failure") return toSignIn("flareyard_refused")
  let back = "/"
  try {
    back = safePath(
      new TextDecoder().decode(
        Uint8Array.from(atob((packedBack ?? "").replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    )
  } catch {
    back = "/"
  }
  const headers = new Headers({ location: back, "cache-control": "no-store" })
  headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${result.success.token}; Max-Age=${Math.floor(SESSION_MAX_MS / 1000)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
  )
  headers.append("set-cookie", clearFlow)
  return new Response(null, { status: 303, headers })
}

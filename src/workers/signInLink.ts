import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { callerFor, redeemSignInLinkFor } from "../domain/people.ts"
import { ROLE_SCOPES } from "../domain/permissions.ts"
import { clientOf, openSession, SESSION_COOKIE, SESSION_MAX_MS } from "../domain/sessions.ts"
import { publicLook } from "../public/look.ts"
import { escapeHtml as esc, glyph, shellPage } from "../public/shell.ts"
import { runtimeFor } from "./inbound.ts"

/**
 * `GET /v1/session/link/{token}`: where a sign-in link lands (HAL-3361). Mail scanners open links
 * before people do, so opening it signs nobody in: the page has one button, and the POST it sends
 * uses the link. The app's own screen can use `POST /v1/session/link/verify` instead.
 */
export const SIGN_IN_LINK_PATH = /^\/v1\/session\/link\/(?!verify$)([^/]+)$/

const fromThisSite = (request: Request, env: Env) => {
  const origin = request.headers.get("origin")
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin"
  if (origin === new URL(request.url).origin) return true
  try {
    return env.MAILYARD_PUBLIC_ORIGIN !== undefined && origin === new URL(env.MAILYARD_PUBLIC_ORIGIN).origin
  } catch {
    return false
  }
}

export const handleSignInLink = async (request: Request, env: Env, token: string) => {
  const run = runtimeFor(env)
  const look = await run.runPromise(publicLook)
  const page = (status: number, title: string, body: string) =>
    shellPage({
      theme: look.theme,
      title,
      status,
      postalAddress: look.postalAddress,
      privacyUrl: look.privacyUrl,
      body,
    })
  if (request.method === "GET" || request.method === "HEAD")
    return page(
      200,
      "Sign in",
      `${glyph(200, "info")}<h1>Sign in to Mailyard</h1><p class="lede">You opened a sign-in link. Continue to sign in on this device.</p><form method="post" action="/v1/session/link/${esc(encodeURIComponent(token))}"><button type="submit">Sign in</button></form><p class="muted">The link works once, for 15 minutes.</p>`,
    )
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } })
  // Signing someone in with a link from another site would sign them in as the sender of that link.
  if (!fromThisSite(request, env))
    return page(
      403,
      "Sign in",
      `${glyph(403, "danger")}<h1>Open the link again</h1><p class="lede">This sign-in didn't come from this site. Open the link from your email again.</p>`,
    )
  const result = await run.runPromise(
    Effect.result(
      redeemSignInLinkFor(token).pipe(
        Effect.flatMap(({ member, returnTo }) => {
          const caller = callerFor(member)
          return openSession(
            { ...caller, scopes: ROLE_SCOPES[member.role] },
            clientOf(Object.fromEntries(request.headers)),
          ).pipe(Effect.map((opened) => ({ ...opened, returnTo })))
        }),
      ),
    ),
  )
  if (result._tag === "Failure") {
    const reason = (result.failure as { reason?: string }).reason
    return page(
      reason === "unknown" ? 400 : 410,
      "Sign in",
      `${glyph(410, "warning")}<h1>${reason === "used" ? "This link was already used" : reason === "expired" ? "This link expired" : "This link isn't valid"}</h1><p class="lede">Sign-in links work once, for 15 minutes. Ask for a new one from the sign-in page.</p><p><a class="button" href="/">Go to sign in</a></p>`,
    )
  }
  return new Response(null, {
    status: 303,
    headers: {
      // Back to the authorization that asked for the sign-in, if one did (HAL-3462).
      location: result.success.returnTo ?? "/",
      "cache-control": "no-store",
      "set-cookie": `${SESSION_COOKIE}=${result.success.token}; Max-Age=${Math.floor(SESSION_MAX_MS / 1000)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    },
  })
}

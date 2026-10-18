import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import type { Caller } from "../domain/apiKeys.ts"
import { requestSignInLink, safeReturn } from "../domain/people.ts"
import { resolveSession } from "../domain/sessions.ts"
import { isMcpResource, MCP_PATH } from "../mcp/handler.ts"
import {
  clientHost,
  findClient,
  type OAuthClient,
  OAuthError,
  redirectMatches,
  registerClient,
} from "../oauth/clients.ts"
import {
  exchangeCode,
  grantableMailboxes,
  grantableScopes,
  issueCode,
  type OAuthScope,
  parseScopes,
  refreshGrant,
  revokeToken,
} from "../oauth/grants.ts"
import { publicLook } from "../public/look.ts"
import { linkOrigin } from "../public/origin.ts"
import { escapeHtml as esc, glyph, notice, shellPage } from "../public/shell.ts"
import { sessionToken } from "./auth.ts"
import { runtimeFor } from "./inbound.ts"

/** A storage failure isn't an OAuth answer: it's a 500, like anywhere else. */
const oauthOnly = <A, E extends { readonly _tag: string }, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchIf(
      (e): e is Exclude<E, OAuthError> => e._tag !== "OAuthError",
      (e) => Effect.die(e),
    ),
  ) as Effect.Effect<A, Extract<E, OAuthError>, R>

/**
 * OAuth 2.1 for MCP clients (HAL-3462), as the MCP authorization spec (2026-07-28) asks: Mailyard
 * is both the protected resource (`/mcp`) and its authorization server, on one origin.
 * - RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata;
 * - `/oauth/authorize`: code flow, PKCE S256 only, `resource` (RFC 8707), `iss` in the answer
 *   (RFC 9207), and a consent page where the person picks scopes and mailboxes;
 * - `/oauth/token`: codes and refresh tokens (rotated, reuse revokes the grant);
 * - `/oauth/register` (RFC 7591) for clients without a metadata document; `/oauth/revoke` (RFC 7009).
 */
export const OAUTH_PATH =
  /^\/(?:\.well-known\/(oauth-protected-resource(?:\/mcp)?|oauth-authorization-server)|oauth\/(authorize|authorize\/sign-in|token|register|revoke))$/

/** What the OAuth endpoints are documented as in /openapi.json's raw routes. */
export const OAUTH_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/authorize",
  "/oauth/authorize/sign-in",
  "/oauth/token",
  "/oauth/register",
  "/oauth/revoke",
] as const

const issuerOf = (request: Request) => linkOrigin(request.url) ?? new URL(request.url).origin

/** The scopes a client gets offered when it asks for none, and the ones it may ask for. */
const ADVERTISED_SCOPES = ["read", "send"]
const ALL_SCOPES = ["read", "send", "admin"]

const SCOPE_TEXT: Record<OAuthScope, { readonly title: string; readonly detail: string }> = {
  read: {
    title: "Read mail",
    detail: "Search, list and read conversations and attachments in the mailboxes below.",
  },
  send: {
    title: "Send and reply",
    detail: "Draft, send and reply from the mailboxes below, within any limits and approvals set for agents.",
  },
  admin: {
    title: "Manage the workspace",
    detail: "Everything you can do as an admin: domains, people, keys and settings.",
  },
}

// -- Responses ---------------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
}

/** Discovery and the token endpoints are read by clients running in browsers too: open CORS, no cookies. */
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
      ...CORS,
      ...extra,
    },
  })

const oauthError = (e: OAuthError) =>
  json(
    { error: e.error, error_description: e.description },
    e.status ?? 400,
    e.error === "invalid_client" ? { "www-authenticate": 'Bearer error="invalid_client"' } : {},
  )

/** Form or JSON bodies: the token endpoints take form bodies by the spec, and JSON from looser clients. */
const readBody = async (request: Request): Promise<Record<string, string>> => {
  const type = request.headers.get("content-type") ?? ""
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>
      return Object.fromEntries(
        Object.entries(body ?? {}).filter(([, v]) => typeof v === "string") as Array<[string, string]>,
      )
    }
    const form = await request.formData()
    const out: Record<string, string> = {}
    for (const [k, v] of form.entries()) if (typeof v === "string" && !(k in out)) out[k] = v
    return out
  } catch {
    return {}
  }
}

/** All values of a repeated form field (checkboxes). */
const readForm = async (request: Request) => {
  try {
    return await request.formData()
  } catch {
    return new FormData()
  }
}

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

const limited = async (limiter: RateLimit | undefined, key: string) =>
  limiter ? !(await limiter.limit({ key })).success : false

const ipOf = (request: Request) => request.headers.get("cf-connecting-ip") ?? "unknown"

// -- Discovery ---------------------------------------------------------------------------------

const protectedResource = (request: Request) => {
  const issuer = issuerOf(request)
  return json({
    // The /mcp on the host the client asked: it checks the resource matches the URL it connected to.
    resource: `${new URL(request.url).origin}${MCP_PATH}`,
    authorization_servers: [issuer],
    scopes_supported: ADVERTISED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Mailyard",
    resource_documentation: `${issuer}/openapi.json`,
  })
}

const authorizationServer = (request: Request) => {
  const issuer = issuerOf(request)
  return json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: ALL_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/openapi.json`,
  })
}

// -- Authorization requests -------------------------------------------------------------------

interface AuthorizationRequest {
  readonly client: OAuthClient
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
  readonly resource: string
  readonly scopes: ReadonlyArray<OAuthScope>
}

type Checked =
  | { readonly ok: true; readonly value: AuthorizationRequest }
  /** Wrong before the redirect URI is trusted: shown on the page, never sent to the client. */
  | { readonly ok: false; readonly page: string }
  /** Wrong after it: sent back to the client as `error` (RFC 6749 §4.1.2.1). */
  | { readonly ok: false; readonly redirect: string }

const AUTH_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const

/** Where to send the person back, with the answer's parameters and the issuer. */
const backTo = (redirectUri: string, issuer: string, params: Record<string, string | undefined>) => {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  url.searchParams.set("iss", issuer)
  return url.toString()
}

const checkRequest = (request: Request, get: (name: string) => string | null) =>
  Effect.gen(function* () {
    const clientId = get("client_id") ?? ""
    const found = yield* Effect.result(oauthOnly(findClient(clientId)))
    if (found._tag === "Failure") return { ok: false, page: found.failure.description } as Checked
    const client = found.success
    const asked = get("redirect_uri")
    const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined)
    if (!redirectUri)
      return {
        ok: false,
        page: "redirect_uri is missing, and the client registered more than one.",
      } as Checked
    if (!redirectMatches(client.redirectUris, redirectUri))
      return { ok: false, page: `${redirectUri} isn't a redirect URI ${client.name} registered.` } as Checked
    const issuer = issuerOf(request)
    const state = get("state") ?? ""
    const fail = (error: string, description: string): Checked => ({
      ok: false,
      redirect: backTo(redirectUri, issuer, {
        error,
        error_description: description,
        state: state || undefined,
      }),
    })
    if (get("response_type") !== "code")
      return fail("unsupported_response_type", "Only response_type=code is supported.")
    if (!state) return fail("invalid_request", "state is required.")
    const challenge = get("code_challenge") ?? ""
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(challenge))
      return fail("invalid_request", "code_challenge is required: PKCE with S256.")
    if (get("code_challenge_method") !== "S256")
      return fail("invalid_request", "code_challenge_method must be S256.")
    const resource = get("resource") ?? ""
    if (!isMcpResource(resource, request))
      return fail("invalid_target", `resource must be ${issuer}${MCP_PATH}.`)
    const scopes = parseScopes(get("scope"))
    if (!scopes) return fail("invalid_scope", `Mailyard's scopes are ${ALL_SCOPES.join(", ")}.`)
    return {
      ok: true,
      value: { client, redirectUri, state, codeChallenge: challenge, resource, scopes },
    } as Checked
  })

/** The signed-in caller behind the session cookie, if any. */
const sessionCaller = async (request: Request, env: Env): Promise<Caller | null> => {
  const token = sessionToken(request)
  if (!token) return null
  const result = await runtimeFor(env).runPromise(Effect.result(resolveSession(token)))
  return result._tag === "Success" ? result.success : null
}

/** The grant's principal: the person, or `root` for the admin key's session. A key's session can't consent. */
const principalOf = (caller: Caller) =>
  caller.member ? caller.member.id : caller.keyId === "root" ? "root" : null

/** Where a redirect may go, for the consent page's `form-action`. */
const formActionFor = (redirectUri: string) => {
  const url = new URL(redirectUri)
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : url.protocol
}

const clientLine = (client: OAuthClient) => {
  const host = clientHost(client)
  return `<strong>${esc(client.name)}</strong>${host ? ` <span class="muted">(${esc(host)})</span>` : ""}`
}

const hidden = (get: (name: string) => string | null) =>
  AUTH_PARAMS.map((p) => {
    const v = get(p)
    return v === null ? "" : `<input type="hidden" name="${p}" value="${esc(v)}">`
  }).join("")

const authorizeQuery = (get: (name: string) => string | null) => {
  const q = new URLSearchParams()
  for (const p of AUTH_PARAMS) {
    const v = get(p)
    if (v !== null) q.set(p, v)
  }
  return `/oauth/authorize?${q.toString()}`
}

const handleAuthorize = async (request: Request, env: Env) => {
  const run = runtimeFor(env)
  const look = await run.runPromise(publicLook)
  const page = (status: number, title: string, body: string, formAction: ReadonlyArray<string> = []) =>
    shellPage({
      theme: look.theme,
      title,
      status,
      postalAddress: look.postalAddress,
      privacyUrl: look.privacyUrl,
      body,
      formAction,
    })
  const refusal = (message: string) =>
    page(
      400,
      "Can't connect",
      `${glyph(400, "danger")}<h1>This connection request can't be used</h1><p class="lede">${esc(message)}</p><p class="muted">Go back to the app that sent you here and try connecting again.</p>`,
    )
  const posted = request.method === "POST"
  if (!posted && request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } })
  if (posted && !fromThisSite(request, env))
    return page(
      403,
      "Can't connect",
      `${glyph(403, "danger")}<h1>Approve it from this page</h1><p class="lede">This approval didn't come from Mailyard's own page, so it was refused.</p>`,
    )
  const form = posted ? await readForm(request) : null
  const url = new URL(request.url)
  const get = (name: string) => {
    const v = form ? form.get(name) : url.searchParams.get(name)
    return typeof v === "string" ? v : null
  }
  const checked = await run.runPromise(checkRequest(request, get))
  if (!checked.ok)
    return "page" in checked
      ? refusal(checked.page)
      : new Response(null, {
          status: 303,
          headers: { location: checked.redirect, "cache-control": "no-store" },
        })
  const req = checked.value
  const issuer = issuerOf(request)
  const caller = await sessionCaller(request, env)
  if (!caller)
    return page(
      200,
      "Sign in to connect",
      `${glyph(200, "info")}<h1>Sign in to connect ${esc(req.client.name)}</h1><p class="lede">${clientLine(req.client)} wants to connect to your Mailyard. Sign in first: we'll email you a link that brings you back here.</p><form method="post" action="/oauth/authorize/sign-in"><input type="hidden" name="return" value="${esc(authorizeQuery(get))}"><div class="field"><label for="email">Your email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"></div><button type="submit">Email me a sign-in link</button></form><p class="fine">Already signed in to Mailyard in this browser? Reload this page.</p>`,
    )
  const principal = principalOf(caller)
  if (!principal)
    return page(
      403,
      "Sign in as a person",
      `${glyph(403, "warning")}<h1>Sign in as yourself</h1><p class="lede">This browser is signed in with an API key. Connecting an app needs a person to approve it: sign out, then sign in with your email.</p>`,
    )
  const allowed = grantableScopes(caller)
  const offered = req.scopes.filter((s) => allowed.includes(s))
  const notAllowed = req.scopes.filter((s) => !allowed.includes(s))
  const mailboxes = await run.runPromise(grantableMailboxes(caller))

  if (posted) {
    const deny = () =>
      new Response(null, {
        status: 303,
        headers: {
          location: backTo(req.redirectUri, issuer, {
            error: "access_denied",
            error_description: "The request was denied.",
            state: req.state,
          }),
          "cache-control": "no-store",
        },
      })
    if (form?.get("decision") !== "allow") return deny()
    const picked = new Set(form.getAll("grant_scope").filter((v): v is string => typeof v === "string"))
    const scopes = offered.filter((s) => picked.has(s))
    const boxes = new Set(form.getAll("grant_mailbox").filter((v): v is string => typeof v === "string"))
    const mailboxIds = mailboxes.filter((m) => boxes.has(m.id)).map((m) => m.id)
    if (scopes.length === 0) return deny()
    const code = await run.runPromise(
      issueCode({
        client: req.client,
        principal,
        redirectUri: req.redirectUri,
        codeChallenge: req.codeChallenge,
        resource: req.resource,
        scopes,
        mailboxIds,
      }),
    )
    return new Response(null, {
      status: 303,
      headers: {
        location: backTo(req.redirectUri, issuer, { code, state: req.state }),
        "cache-control": "no-store",
      },
    })
  }

  if (offered.length === 0)
    return new Response(null, {
      status: 303,
      headers: {
        location: backTo(req.redirectUri, issuer, {
          error: "access_denied",
          error_description: "Your role can't grant any of the scopes asked for.",
          state: req.state,
        }),
        "cache-control": "no-store",
      },
    })
  const who = caller.member ? `${caller.member.name} (${caller.member.email})` : "the admin key"
  const registered =
    req.client.kind === "dcr"
      ? notice(
          "warning",
          `This app registered itself, so Mailyard can't confirm who made it. Only continue if you started connecting from ${esc(clientHost(req.client) ?? "the app")} just now.`,
        )
      : ""
  const scopeBoxes = offered
    .map(
      (s, i) =>
        `<div class="field check"><input id="s-${i}" name="grant_scope" type="checkbox" value="${s}" checked><label for="s-${i}"><strong>${esc(SCOPE_TEXT[s].title)}</strong><span>${esc(SCOPE_TEXT[s].detail)}</span></label></div>`,
    )
    .join("")
  const sends = offered.includes("send")
  const mailboxBoxes = mailboxes
    .map(
      (m, i) =>
        `<div class="field check"><input id="m-${i}" name="grant_mailbox" type="checkbox" value="${esc(m.id)}" checked><label for="m-${i}"><strong>${esc(m.address)}</strong>${m.displayName ? `<span>${esc(m.displayName)}</span>` : ""}${sends && !m.canSend ? "<span>Read only: you can't send from this mailbox.</span>" : ""}</label></div>`,
    )
    .join("")
  const redirectHost = (() => {
    const u = new URL(req.redirectUri)
    return u.host || u.protocol
  })()
  return page(
    200,
    `Connect ${req.client.name}`,
    `${glyph(200, "info")}<h1>Connect ${esc(req.client.name)} to Mailyard</h1>
<p class="lede">${clientLine(req.client)} wants to use Mailyard as ${esc(who)}.</p>
${registered}
<form method="post" action="/oauth/authorize">
${hidden(get)}
<fieldset class="pick"><legend>What it may do</legend>${scopeBoxes}</fieldset>
${notAllowed.length ? `<p class="muted">It also asked to ${notAllowed.map((s) => esc(SCOPE_TEXT[s].title.toLowerCase())).join(" and ")}, which your role can't give.</p>` : ""}
${mailboxes.length ? `<fieldset class="pick"><legend>Which mailboxes</legend>${mailboxBoxes}</fieldset>` : `<p class="muted">You haven't been given any mailboxes yet, so it won't see any mail.</p>`}
<p class="fine">You'll go back to ${esc(redirectHost)}. Access lasts until you revoke it in Settings → Integrations.</p>
<div class="actions"><button type="submit" name="decision" value="allow">Allow</button>
<button class="secondary" type="submit" name="decision" value="deny">Deny</button></div>
</form>`,
    [formActionFor(req.redirectUri)],
  )
}

const handleSignIn = async (request: Request, env: Env) => {
  const run = runtimeFor(env)
  const look = await run.runPromise(publicLook)
  const page = (status: number, body: string) =>
    shellPage({
      theme: look.theme,
      title: "Sign in",
      status,
      postalAddress: look.postalAddress,
      privacyUrl: look.privacyUrl,
      body,
    })
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } })
  if (!fromThisSite(request, env))
    return page(
      403,
      `${glyph(403, "danger")}<h1>Ask from this page</h1><p class="lede">This sign-in didn't come from Mailyard's own page.</p>`,
    )
  if (await limited(env.AUTH_LIMITER, `oauth-sign-in:${ipOf(request)}`))
    return page(
      429,
      `${glyph(429, "warning")}<h1>Too many tries</h1><p class="lede">Wait a minute, then ask for a link again.</p>`,
    )
  const body = await readBody(request)
  const back = safeReturn(body.return)
  await run.runPromise(requestSignInLink(body.email ?? "", issuerOf(request), back))
  return page(
    200,
    `${glyph(200, "success")}<h1>Check your email</h1><p class="lede">If ${esc(body.email ?? "that address")} belongs to someone in this workspace, a sign-in link is on its way. It brings you back here to finish connecting, and works once, for 15 minutes.</p>${back ? `<p><a class="button secondary" href="${esc(back)}">Back</a></p>` : ""}`,
  )
}

// -- Token, registration, revocation ----------------------------------------------------------

const handleToken = async (request: Request, env: Env) => {
  if (request.method !== "POST")
    return json({ error: "invalid_request", error_description: "POST to /oauth/token." }, 405)
  if (await limited(env.AUTH_LIMITER, `oauth-token:${ipOf(request)}`))
    return json({ error: "slow_down", error_description: "Too many token requests; wait a minute." }, 429, {
      "retry-after": "60",
    })
  const body = await readBody(request)
  if (request.headers.get("authorization")?.toLowerCase().startsWith("basic "))
    return oauthError(
      new OAuthError({
        error: "invalid_client",
        description: "Mailyard's clients are public: send client_id, no secret.",
        status: 401,
      }),
    )
  const clientId = body.client_id ?? ""
  const run = runtimeFor(env)
  const client = await run.runPromise(Effect.result(oauthOnly(findClient(clientId))))
  if (client._tag === "Failure")
    return oauthError(
      new OAuthError({ error: "invalid_client", description: client.failure.description, status: 401 }),
    )
  const grant = body.grant_type
  const result =
    grant === "authorization_code"
      ? await run.runPromise(
          Effect.result(
            oauthOnly(
              exchangeCode({
                code: body.code ?? "",
                clientId,
                redirectUri: body.redirect_uri ?? "",
                codeVerifier: body.code_verifier ?? "",
                resource: body.resource ?? null,
              }),
            ),
          ),
        )
      : grant === "refresh_token"
        ? await run.runPromise(
            Effect.result(
              oauthOnly(
                refreshGrant({ refreshToken: body.refresh_token ?? "", clientId, scope: body.scope ?? null }),
              ),
            ),
          )
        : null
  if (!result)
    return oauthError(
      new OAuthError({
        error: "unsupported_grant_type",
        description: "grant_type must be authorization_code or refresh_token.",
        status: 400,
      }),
    )
  return result._tag === "Success" ? json(result.success) : oauthError(result.failure)
}

const handleRegister = async (request: Request, env: Env) => {
  if (request.method !== "POST")
    return json({ error: "invalid_request", error_description: "POST JSON to /oauth/register." }, 405)
  if (await limited(env.FORM_LIMITER, `oauth-register:${ipOf(request)}`))
    return json({ error: "slow_down", error_description: "Too many registrations; wait a minute." }, 429, {
      "retry-after": "60",
    })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return oauthError(
      new OAuthError({
        error: "invalid_client_metadata",
        description: "Send JSON client metadata.",
        status: 400,
      }),
    )
  }
  const result = await runtimeFor(env).runPromise(Effect.result(oauthOnly(registerClient(body))))
  return result._tag === "Success" ? json(result.success, 201) : oauthError(result.failure)
}

const handleRevoke = async (request: Request, env: Env) => {
  if (request.method !== "POST")
    return json({ error: "invalid_request", error_description: "POST to /oauth/revoke." }, 405)
  const body = await readBody(request)
  await runtimeFor(env).runPromise(revokeToken(body.token ?? "", body.client_id ?? null))
  // RFC 7009 §2.2: the same answer whether or not the token existed.
  return json({}, 200)
}

/** Every OAuth route. `match` is OAUTH_PATH's match on the path. */
export const handleOAuth = async (request: Request, env: Env, match: RegExpMatchArray): Promise<Response> => {
  const [, wellKnown, endpoint] = match
  if (request.method === "OPTIONS" && endpoint !== "authorize" && endpoint !== "authorize/sign-in")
    return new Response(null, { status: 204, headers: CORS })
  if (wellKnown) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return json({ error: "invalid_request", error_description: "GET this document." }, 405)
    return wellKnown === "oauth-authorization-server"
      ? authorizationServer(request)
      : protectedResource(request)
  }
  switch (endpoint) {
    case "authorize":
      return handleAuthorize(request, env)
    case "authorize/sign-in":
      return handleSignIn(request, env)
    case "token":
      return handleToken(request, env)
    case "register":
      return handleRegister(request, env)
    default:
      return handleRevoke(request, env)
  }
}

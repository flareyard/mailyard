import { env, exports } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { sha256 } from "../src/domain/crypto.ts"
import { safeReturn } from "../src/domain/people.ts"
import { ROLE_SCOPES } from "../src/domain/permissions.ts"
import { clientOf, openSession } from "../src/domain/sessions.ts"
import { clientIdUrlProblem, redirectMatches, redirectProblem } from "../src/oauth/clients.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "./dns.ts"
import { ADMIN, call, json } from "./helpers.ts"

/**
 * HAL-3462: OAuth 2.1 for MCP clients, end to end. A client publishes a metadata document on
 * https://client.example (served by a fake fetch), a person consents in a real session, and the
 * tokens drive the real /mcp.
 */
installDohFixture()

const ORIGIN = "https://mailyard.test"
const RESOURCE = `${ORIGIN}/mcp`
const COOKIE = "__Host-mailyard_session"
const CLIENT_ID = "https://client.example/oauth/client.json"
const REDIRECT = "https://client.example/callback"
const uid = () => crypto.randomUUID().slice(0, 8)

let document: unknown = {
  client_id: CLIENT_ID,
  client_name: "Example Agent",
  client_uri: "https://client.example",
  redirect_uris: [REDIRECT],
  token_endpoint_auth_method: "none",
}
let documentFetches = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  if (new URL(request.url).hostname !== "client.example") return realFetch(input, init)
  documentFetches++
  return Response.json(document)
}) as typeof fetch
afterEach(() => {
  document = {
    client_id: CLIENT_ID,
    client_name: "Example Agent",
    client_uri: "https://client.example",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
  }
})

const fetchWorker = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }))

/** A person with a role, signed in: their member id and session cookie. */
const person = async (role: "owner" | "admin" | "sender" | "agent" | "viewer") => {
  const id = `mem_${uid()}`
  const email = `${id}@people.test`
  await env.DB.prepare("insert into members (id, email, name, role, created_at) values (?, ?, ?, ?, ?)")
    .bind(id, email, `Person ${id}`, role, Date.now())
    .run()
  const opened = await runtimeFor(env).runPromise(
    openSession(
      {
        keyId: id,
        kind: "secret",
        scopes: ROLE_SCOPES[role],
        member: { id, role, email, name: `Person ${id}` },
      },
      clientOf({}),
    ),
  )
  return { id, email, cookie: `${COOKIE}=${opened.token}` }
}

/** A mailbox, with the person given it as `role`. */
const mailbox = async (memberId?: string, role: "owner" | "member" | "viewer" = "member") => {
  const domain = `oa-${uid()}.test`
  setDns(goodDomain(domain))
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  const box = await json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `team@${domain}`, kind: "shared" },
    }),
  )
  if (memberId)
    await env.DB.prepare(
      "insert into mailbox_people (mailbox_id, member_id, role, created_at) values (?, ?, ?, ?)",
    )
      .bind(box.id, memberId, role, Date.now())
      .run()
  return box
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  let s = ""
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
const pkce = async () => {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

type AuthParams = Record<string, string>
const authParams = (challenge: string, extra: AuthParams = {}): AuthParams => ({
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  state: `st-${uid()}`,
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: RESOURCE,
  scope: "read send",
  ...extra,
})

const authorizePage = (params: AuthParams, cookie?: string) =>
  fetchWorker(`/oauth/authorize?${new URLSearchParams(params)}`, { headers: cookie ? { cookie } : {} })

/** The consent page's answer, as the browser posts it. */
const consent = (
  params: AuthParams,
  cookie: string,
  choice: { scopes?: string[]; mailboxes?: string[]; decision?: string },
) => {
  const form = new URLSearchParams(params)
  form.set("decision", choice.decision ?? "allow")
  for (const s of choice.scopes ?? []) form.append("grant_scope", s)
  for (const m of choice.mailboxes ?? []) form.append("grant_mailbox", m)
  return fetchWorker("/oauth/authorize", {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  })
}

const token = (body: Record<string, string>) =>
  fetchWorker("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  })

type Tokens = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
}

/** The whole dance for one person: consent to what's chosen, and exchange the code. */
const connect = async (
  who: { cookie: string },
  choice: { scopes?: string[]; mailboxes?: string[] },
  ask: AuthParams = {},
) => {
  const { verifier, challenge } = await pkce()
  const params = authParams(challenge, ask)
  const answer = await consent(params, who.cookie, choice)
  expect(answer.status).toBe(303)
  const back = new URL(answer.headers.get("location") ?? "")
  expect(back.origin + back.pathname).toBe(REDIRECT)
  expect(back.searchParams.get("state")).toBe(params.state)
  expect(back.searchParams.get("iss")).toBe(ORIGIN)
  const code = back.searchParams.get("code") ?? ""
  const res = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    resource: RESOURCE,
  })
  expect(res.status).toBe(200)
  return { tokens: await json<Tokens>(res), code, verifier }
}

let n = 0
const mcp = (accessToken: string | null, method: string, params?: unknown) =>
  fetchWorker("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, ...(params ? { params } : {}) }),
  })

const mailboxesSeen = async (accessToken: string) => {
  const res = await mcp(accessToken, "tools/call", { name: "list_mailboxes", arguments: {} })
  expect(res.status).toBe(200)
  const body = await json<{ result: { structuredContent: { mailboxes: Array<{ id: string }> } } }>(res)
  return body.result.structuredContent.mailboxes.map((m) => m.id)
}

describe("discovery (RFC 9728, RFC 8414)", () => {
  it("publishes the protected-resource and authorization-server metadata, with open CORS", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await fetchWorker(path)
      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).toBe("*")
      expect(await res.json()).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [ORIGIN],
        scopes_supported: ["read", "send"],
        bearer_methods_supported: ["header"],
      })
    }
    const server = await json<Record<string, unknown>>(
      await fetchWorker("/.well-known/oauth-authorization-server"),
    )
    expect(server).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    })
    const preflight = await fetchWorker("/oauth/token", { method: "OPTIONS" })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST")
  })

  it("answers /mcp without a token with a Bearer challenge pointing at the metadata", async () => {
    const bare = await mcp(null, "ping")
    expect(bare.status).toBe(401)
    expect(bare.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="read send"`,
    )
    const bad = await mcp("oat_not-a-token", "ping")
    expect(bad.status).toBe(401)
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"')
  })
})

describe("connecting a client (HAL-3462)", () => {
  it("asks a signed-out person to sign in, and a signed-in one to consent, naming the client and its host", async () => {
    const { challenge } = await pkce()
    const params = authParams(challenge)
    const signedOut = await authorizePage(params)
    expect(signedOut.status).toBe(200)
    const signIn = await signedOut.text()
    expect(signIn).toContain('action="/oauth/authorize/sign-in"')
    expect(signIn).toContain("Example Agent")

    const sender = await person("sender")
    const box = await mailbox(sender.id)
    const page = await authorizePage(params, sender.cookie)
    expect(page.status).toBe(200)
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://client.example")
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    const html = await page.text()
    expect(html).toContain("Example Agent")
    expect(html).toContain("client.example")
    expect(html).toContain(`value="${box.id}"`)
    expect(html).toContain('value="send"')
  })

  it("issues tokens that work on /mcp only, limited to the mailboxes chosen", async () => {
    const sender = await person("sender")
    const chosen = await mailbox(sender.id)
    const other = await mailbox(sender.id)
    const { tokens } = await connect(sender, { scopes: ["read", "send"], mailboxes: [chosen.id] })
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read send" })
    expect(tokens.access_token).toMatch(/^oat_/)
    expect(tokens.refresh_token).toMatch(/^ort_/)

    expect(await mailboxesSeen(tokens.access_token)).toEqual([chosen.id])
    expect(await mailboxesSeen(tokens.access_token)).not.toContain(other.id)
    // The JSON API isn't the token's resource.
    const api = await call("/v1/mailboxes", { key: tokens.access_token })
    expect(api.status).toBe(401)

    // It shows on Integrations, to the person who approved it.
    const listed = await json<{
      oauth: { grants: Array<{ client: { name: string; host: string }; mailboxIds: string[] }> }
    }>(await fetchWorker("/v1/integrations", { headers: { cookie: sender.cookie, origin: ORIGIN } }))
    expect(listed.oauth.grants).toEqual([
      expect.objectContaining({
        client: expect.objectContaining({ name: "Example Agent", host: "client.example" }),
        mailboxIds: [chosen.id],
      }),
    ])
  })

  it("never lets a viewer hand out send, even when the form says so", async () => {
    const viewer = await person("viewer")
    await mailbox(viewer.id, "viewer")
    const { challenge } = await pkce()
    const html = await (await authorizePage(authParams(challenge), viewer.cookie)).text()
    expect(html).not.toContain('value="send"')
    expect(html).toContain("which your role can't give")
    const { tokens } = await connect(viewer, { scopes: ["read", "send"] })
    expect(tokens.scope).toBe("read")
  })

  it("answers insufficient_scope with every scope needed when a tool needs more", async () => {
    const sender = await person("sender")
    const box = await mailbox(sender.id)
    const { tokens } = await connect(sender, { scopes: ["read"], mailboxes: [box.id] })
    const res = await mcp(tokens.access_token, "tools/call", { name: "send_email", arguments: {} })
    expect(res.status).toBe(403)
    const challenge = res.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('scope="read send"')
  })

  it("sends a denial back to the client", async () => {
    const sender = await person("sender")
    const { challenge } = await pkce()
    const params = authParams(challenge)
    const res = await consent(params, sender.cookie, { decision: "deny" })
    expect(res.status).toBe(303)
    const back = new URL(res.headers.get("location") ?? "")
    expect(back.searchParams.get("error")).toBe("access_denied")
    expect(back.searchParams.get("state")).toBe(params.state)
    expect(back.searchParams.get("iss")).toBe(ORIGIN)
  })

  it("refuses consent posted from another site", async () => {
    const sender = await person("sender")
    const { challenge } = await pkce()
    const form = new URLSearchParams({ ...authParams(challenge), decision: "allow", grant_scope: "read" })
    const res = await fetchWorker("/oauth/authorize", {
      method: "POST",
      headers: {
        cookie: sender.cookie,
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    })
    expect(res.status).toBe(403)
  })
})

describe("what the authorization endpoint refuses", () => {
  it("shows an untrusted client or redirect on the page, and never redirects to it", async () => {
    const { challenge } = await pkce()
    const wrongRedirect = await authorizePage(
      authParams(challenge, { redirect_uri: "https://evil.example/cb" }),
    )
    expect(wrongRedirect.status).toBe(400)
    expect(wrongRedirect.headers.get("location")).toBeNull()
    const unknown = await authorizePage(authParams(challenge, { client_id: "oc_nobody" }))
    expect(unknown.status).toBe(400)
    document = { client_id: "https://client.example/someone-else.json", redirect_uris: [REDIRECT] }
    const mismatched = await authorizePage(
      authParams(challenge, { client_id: "https://client.example/oauth/other.json" }),
    )
    expect(mismatched.status).toBe(400)
  })

  it("sends PKCE, resource and scope problems back to the client", async () => {
    const { challenge } = await pkce()
    const errorOf = async (extra: AuthParams) => {
      const res = await authorizePage(authParams(challenge, extra))
      expect(res.status).toBe(303)
      return new URL(res.headers.get("location") ?? "").searchParams.get("error")
    }
    expect(await errorOf({ code_challenge: "" })).toBe("invalid_request")
    expect(await errorOf({ code_challenge_method: "plain" })).toBe("invalid_request")
    expect(await errorOf({ state: "" })).toBe("invalid_request")
    expect(await errorOf({ response_type: "token" })).toBe("unsupported_response_type")
    expect(await errorOf({ resource: "https://elsewhere.example/mcp" })).toBe("invalid_target")
    expect(await errorOf({ scope: "read everything" })).toBe("invalid_scope")
  })
})

describe("the token endpoint", () => {
  it("checks the verifier, and a replayed code revokes what it gave", async () => {
    const sender = await person("sender")
    const box = await mailbox(sender.id)
    const { tokens, code, verifier } = await connect(sender, { scopes: ["read"], mailboxes: [box.id] })
    expect((await mcp(tokens.access_token, "ping")).status).toBe(200)
    const replay = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    })
    expect(replay.status).toBe(400)
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" })
    expect((await mcp(tokens.access_token, "ping")).status).toBe(401)

    // A wrong verifier.
    const fresh = await pkce()
    const params = authParams(fresh.challenge)
    const answer = await consent(params, sender.cookie, { scopes: ["read"] })
    const wrong = await token({
      grant_type: "authorization_code",
      code: new URL(answer.headers.get("location") ?? "").searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      code_verifier: (await pkce()).verifier,
      client_id: CLIENT_ID,
    })
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" })
    expect(await (await token({ grant_type: "password", client_id: CLIENT_ID })).json()).toMatchObject({
      error: "unsupported_grant_type",
    })
  })

  it("rotates refresh tokens, and reusing a spent one revokes the grant", async () => {
    const sender = await person("sender")
    const box = await mailbox(sender.id)
    const { tokens } = await connect(sender, { scopes: ["read"], mailboxes: [box.id] })
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    })
    expect(refreshed.status).toBe(200)
    const next = await json<Tokens>(refreshed)
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect((await mcp(next.access_token, "ping")).status).toBe(200)
    // A refresh can't widen the grant.
    expect(
      await (
        await token({
          grant_type: "refresh_token",
          refresh_token: next.refresh_token,
          client_id: CLIENT_ID,
          scope: "read send",
        })
      ).json(),
    ).toMatchObject({ error: "invalid_scope" })

    const reused = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    })
    expect(await reused.json()).toMatchObject({ error: "invalid_grant" })
    expect((await mcp(next.access_token, "ping")).status).toBe(401)
    expect(
      (await token({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: CLIENT_ID }))
        .status,
    ).toBe(400)
  })

  it("revokes by token (RFC 7009) and from Integrations, and a removed person's grants stop", async () => {
    const sender = await person("sender")
    const box = await mailbox(sender.id)
    const a = await connect(sender, { scopes: ["read"], mailboxes: [box.id] })
    const revoke = await fetchWorker("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: a.tokens.refresh_token, client_id: CLIENT_ID }),
    })
    expect(revoke.status).toBe(200)
    expect((await mcp(a.tokens.access_token, "ping")).status).toBe(401)
    // Unknown tokens answer the same.
    expect(
      (
        await fetchWorker("/oauth/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: "ort_nothing" }),
        })
      ).status,
    ).toBe(200)

    const b = await connect(sender, { scopes: ["read"], mailboxes: [box.id] })
    const listed = await json<{ oauth: { grants: Array<{ id: string }> } }>(
      await fetchWorker("/v1/integrations", { headers: { cookie: sender.cookie, origin: ORIGIN } }),
    )
    const grantId = listed.oauth.grants[0]?.id ?? ""
    const someoneElse = await person("sender")
    expect(
      (
        await fetchWorker(`/v1/integrations/oauth-grants/${grantId}`, {
          method: "DELETE",
          headers: { cookie: someoneElse.cookie, origin: ORIGIN },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await fetchWorker(`/v1/integrations/oauth-grants/${grantId}`, {
          method: "DELETE",
          headers: { cookie: sender.cookie, origin: ORIGIN },
        })
      ).status,
    ).toBe(200)
    expect((await mcp(b.tokens.access_token, "ping")).status).toBe(401)

    const c = await connect(sender, { scopes: ["read"], mailboxes: [box.id] })
    await env.DB.prepare("update members set removed_at = ? where id = ?").bind(Date.now(), sender.id).run()
    expect((await mcp(c.tokens.access_token, "ping")).status).toBe(401)
  })
})

describe("client registration", () => {
  it("registers public clients (RFC 7591) and refuses confidential ones and unsafe redirects", async () => {
    const register = (body: unknown) =>
      fetchWorker("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const ok = await register({ client_name: "Desktop", redirect_uris: ["http://127.0.0.1:33418/callback"] })
    expect(ok.status).toBe(201)
    const client = await json<{ client_id: string; token_endpoint_auth_method: string }>(ok)
    expect(client.client_id).toMatch(/^oc_/)
    expect(client.token_endpoint_auth_method).toBe("none")
    expect(
      await (
        await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })
      ).json(),
    ).toMatchObject({
      error: "invalid_client_metadata",
    })
    expect(await (await register({ redirect_uris: ["http://client.example/cb"] })).json()).toMatchObject({
      error: "invalid_redirect_uri",
    })
    expect(await (await register({ redirect_uris: ["javascript:alert(1)"] })).json()).toMatchObject({
      error: "invalid_redirect_uri",
    })

    // A registered loopback client may come back on another port, and its consent page warns.
    const sender = await person("sender")
    const { challenge } = await pkce()
    const page = await authorizePage(
      authParams(challenge, { client_id: client.client_id, redirect_uri: "http://127.0.0.1:50211/callback" }),
      sender.cookie,
    )
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("registered itself")
  })

  it("checks redirect and client-id URLs by the rules", () => {
    expect(redirectProblem("https://app.example/cb")).toBeNull()
    expect(redirectProblem("cursor://anysphere.cursor/oauth")).toBeNull()
    expect(redirectProblem("https://app.example/cb#x")).not.toBeNull()
    expect(redirectProblem("data:text/html,x")).not.toBeNull()
    expect(redirectMatches(["http://localhost:1/cb"], "http://localhost:9999/cb")).toBe(true)
    expect(redirectMatches(["http://localhost:1/cb"], "http://localhost:9999/other")).toBe(false)
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb2")).toBe(false)
    expect(clientIdUrlProblem("https://client.example/c.json")).toBeNull()
    expect(clientIdUrlProblem("https://client.example/")).not.toBeNull()
    expect(clientIdUrlProblem("https://127.0.0.1/c.json")).not.toBeNull()
    expect(clientIdUrlProblem("https://intranet/c.json")).not.toBeNull()
    expect(clientIdUrlProblem("http://client.example/c.json")).not.toBeNull()
  })

  it("caches a metadata document for a day", async () => {
    const before = documentFetches
    const sender = await person("sender")
    const { challenge } = await pkce()
    await authorizePage(authParams(challenge), sender.cookie)
    await authorizePage(authParams(challenge), sender.cookie)
    expect(documentFetches - before).toBeLessThanOrEqual(1)
  })
})

describe("signing in from the consent page", () => {
  it("lands back on the authorization after the emailed link, and nowhere else", async () => {
    expect(safeReturn("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x")
    expect(safeReturn("https://evil.example/oauth/authorize?x")).toBeNull()
    expect(safeReturn("//evil.example/oauth/authorize?x")).toBeNull()
    expect(safeReturn("/v1/anything")).toBeNull()

    const someone = await person("sender")
    const linkToken = `tok${uid()}${uid()}`
    const back = "/oauth/authorize?client_id=https%3A%2F%2Fclient.example%2Foauth%2Fclient.json"
    await env.DB.prepare(
      "insert into sign_in_links (id, member_id, token_hash, created_at, expires_at, return_to) values (?, ?, ?, ?, ?, ?)",
    )
      .bind(`sil_${uid()}`, someone.id, await sha256(linkToken), Date.now(), Date.now() + 60_000, back)
      .run()
    const used = await fetchWorker(`/v1/session/link/${linkToken}`, {
      method: "POST",
      headers: { origin: ORIGIN },
    })
    expect(used.status).toBe(303)
    expect(used.headers.get("location")).toBe(back)
    expect(used.headers.get("set-cookie")).toContain(COOKIE)
  })
})

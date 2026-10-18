import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { ADMIN, call, createKey, json } from "./helpers.ts"

const ORIGIN = "https://mailyard.test"
const COOKIE = "__Host-mailyard_session"

type Me = {
  user: null
  role: null
  via: string
  key: { id: string; name: string; prefix: string } | null
  scopes: string[]
  permissions: string[]
  workspace: { id: string; name: string }
  workspaces: Array<{ id: string }>
  session: { id: string; expiresAt: number; absoluteExpiresAt: number } | null
}
type Refusal = { _tag: string; reason?: string; required?: string; scopes?: string[] }
type Session = { id: string; current: boolean; via: string; key: { id: string; name: string } | null }

/** Signs in with a key from this site; returns the cookie pair and the response body. */
const signIn = async (key: string, headers: Record<string, string> = { origin: ORIGIN }) => {
  const res = await call("/v1/session", { method: "POST", json: { key }, headers })
  const setCookie = res.headers.get("set-cookie") ?? ""
  const token = setCookie.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1]
  return { res, setCookie, cookie: token ? `${COOKIE}=${token}` : null, body: await res.json() }
}

/** A request signed in by the cookie alone (no Bearer), from this site unless told otherwise. */
const withCookie = (
  cookie: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
  origin = ORIGIN,
) =>
  call(path, {
    ...init,
    headers: { cookie, ...(origin ? { origin } : {}), ...(init.headers as Record<string, string>) },
  })

describe("browser sessions (HAL-3358)", () => {
  it("exchanges a key for an HTTP-only cookie and never stores the key", async () => {
    const { key, apiKey } = await createKey("secret", ["read", "send"])
    const { res, setCookie, cookie, body } = await signIn(key)
    expect(res.status).toBe(200)
    expect(setCookie).toContain(`${COOKIE}=`)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(setCookie).toMatch(/Path=\//)
    expect(setCookie).not.toContain(key)
    const me = body as Me
    expect(me).toMatchObject({
      user: null,
      role: null,
      via: "session-key",
      key: { id: apiKey.id, name: "secret test key" },
      scopes: ["read", "send"],
    })
    expect(me.permissions).toContain("mail.read")
    expect(me.permissions).toContain("mail.send")
    expect(me.permissions).not.toContain("settings.write")
    expect(me.workspaces).toEqual([me.workspace])
    expect(me.session?.absoluteExpiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000)

    // The cookie alone signs requests in; the stored row has the token's hash, not the key or token.
    const again = await withCookie(cookie as string, "/v1/me")
    expect(again.status).toBe(200)
    expect((await json<Me>(again)).session?.id).toBe(me.session?.id)
    const row = await env.DB.prepare("select * from sessions where id = ?").bind(me.session?.id).first()
    expect(JSON.stringify(row)).not.toContain(key)
    expect(JSON.stringify(row)).not.toContain((cookie as string).split("=")[1])
  })

  it("signs the admin key in as admin-key, and Bearer callers read /v1/me too", async () => {
    const { body } = await signIn(ADMIN)
    expect(body).toMatchObject({ via: "admin-key", key: null, scopes: ["send", "track", "read", "admin"] })
    expect((body as Me).permissions).toContain("keys.manage")
    const bearer = await json<Me>(await call("/v1/me", { key: ADMIN }))
    expect(bearer).toMatchObject({ via: "admin-key", session: null })
    const { key } = await createKey("secret", ["read"])
    expect(await json<Me>(await call("/v1/me", { key }))).toMatchObject({ via: "api-key", session: null })
  })

  it("needs the read scope, a secret key, and a real key to sign in", async () => {
    const sender = (await createKey("secret", ["send"])).key
    const noRead = await signIn(sender)
    expect(noRead.res.status).toBe(403)
    expect(noRead.body).toMatchObject({ reason: "insufficient-scope", required: "read", scopes: ["send"] })
    expect(noRead.setCookie).toBe("")
    const pk = (await createKey("public")).key
    expect((await signIn(pk)).body).toMatchObject({ reason: "public-key" })
    const unknown = await signIn(`sk_${"y".repeat(32)}`)
    expect(unknown.res.status).toBe(401)
    expect(unknown.body).toMatchObject({ _tag: "Unauthorized", reason: "unknown" })
  })

  it("refuses a sign-in posted from another site", async () => {
    const { key } = await createKey("secret", ["read"])
    const forged = await signIn(key, { origin: "https://evil.example" })
    expect(forged.res.status).toBe(403)
    expect(forged.body).toMatchObject({ _tag: "Forbidden", reason: "csrf" })
    expect(forged.setCookie).toBe("")
  })

  it("refuses a cookie-signed write from another site, but not a read", async () => {
    const { key } = await createKey("secret", ["read", "send", "track", "admin"])
    const { cookie } = await signIn(key)
    let n = 0
    const write = () => ({ method: "POST", json: { email: `csrf-${n++}@example.com` } })
    const crossSite = await withCookie(cookie as string, "/v1/contacts", write(), "https://evil.example")
    expect(crossSite.status).toBe(403)
    expect(await json<Refusal>(crossSite)).toMatchObject({ _tag: "Forbidden", reason: "csrf" })
    // No Origin and no Sec-Fetch-Site: refused too.
    expect((await withCookie(cookie as string, "/v1/contacts", write(), "")).status).toBe(403)
    // Sec-Fetch-Site: same-origin is enough when a browser omits Origin.
    const fetchSite = await withCookie(
      cookie as string,
      "/v1/contacts",
      { ...write(), headers: { "sec-fetch-site": "same-origin" } },
      "",
    )
    expect(fetchSite.status).toBeLessThan(300)
    expect((await withCookie(cookie as string, "/v1/contacts", write())).status).toBeLessThan(300)
    // The workspace's public origin (MAILYARD_PUBLIC_ORIGIN) counts as this site too.
    const publicOrigin = await withCookie(
      cookie as string,
      "/v1/contacts",
      write(),
      "https://app.mailyard.test",
    )
    expect(publicOrigin.status).toBeLessThan(300)
    // Reads need no Origin.
    expect((await withCookie(cookie as string, "/v1/contacts", {}, "")).status).toBe(200)
    // Bearer requests never need one: they can't be forged by a browser.
    expect(
      (await call("/v1/contacts", { method: "POST", key, json: { email: "bearer@example.com" } })).status,
    ).toBeLessThan(300)
  })

  it("narrows a session when its key is narrowed, and ends it when the key is revoked", async () => {
    const { key, apiKey } = await createKey("secret", ["read", "admin"])
    const { cookie } = await signIn(key)
    await env.DB.prepare("update api_keys set scopes = ? where id = ?").bind('["read"]', apiKey.id).run()
    const narrowed = await json<Me>(await withCookie(cookie as string, "/v1/me"))
    expect(narrowed.scopes).toEqual(["read"])
    const refused = await withCookie(cookie as string, "/v1/api-keys", {
      method: "POST",
      json: { name: "x", kind: "secret" },
    })
    expect(await json<Refusal>(refused)).toMatchObject({ reason: "insufficient-scope", required: "admin" })

    expect((await call(`/v1/api-keys/${apiKey.id}`, { method: "DELETE", key: ADMIN })).status).toBe(200)
    const ended = await withCookie(cookie as string, "/v1/me")
    expect(ended.status).toBe(401)
    expect(await json<Refusal>(ended)).toMatchObject({ _tag: "Unauthorized", reason: "session-expired" })
    expect(ended.headers.get("set-cookie")).toMatch(/Max-Age=0/i)
  })

  it("expires after 14 days unused and 30 days at most", async () => {
    const { key } = await createKey("secret", ["read"])
    const idle = await signIn(key)
    const idleId = (idle.body as Me).session?.id
    await env.DB.prepare("update sessions set expires_at = ? where id = ?")
      .bind(Date.now() - 1, idleId)
      .run()
    const idleRes = await withCookie(idle.cookie as string, "/v1/me")
    expect(idleRes.status).toBe(401)
    expect(await json<Refusal>(idleRes)).toMatchObject({ reason: "session-expired" })

    const old = await signIn(key)
    const oldId = (old.body as Me).session?.id
    // In use a minute ago, but opened 30 days ago: the sliding expiry stops at the cap.
    await env.DB.prepare(
      "update sessions set last_seen_at = ?, absolute_expires_at = ?, expires_at = ? where id = ?",
    )
      .bind(Date.now() - 120_000, Date.now() + 1_000, Date.now() + 1_000, oldId)
      .run()
    expect((await withCookie(old.cookie as string, "/v1/me")).status).toBe(200)
    const row = await env.DB.prepare("select expires_at, absolute_expires_at from sessions where id = ?")
      .bind(oldId)
      .first<{ expires_at: number; absolute_expires_at: number }>()
    expect(row?.expires_at).toBe(row?.absolute_expires_at)
  })

  it("slides the expiry forward on use, at most once a minute", async () => {
    const { key } = await createKey("secret", ["read"])
    const { cookie, body } = await signIn(key)
    const id = (body as Me).session?.id
    const stale = Date.now() - 5 * 86_400_000
    await env.DB.prepare("update sessions set last_seen_at = ?, expires_at = ? where id = ?")
      .bind(stale, stale + 14 * 86_400_000, id)
      .run()
    await withCookie(cookie as string, "/v1/me")
    const row = await env.DB.prepare("select last_seen_at, expires_at from sessions where id = ?")
      .bind(id)
      .first<{ last_seen_at: number; expires_at: number }>()
    expect(row?.last_seen_at).toBeGreaterThan(Date.now() - 60_000)
    expect(row?.expires_at).toBeGreaterThan(Date.now() + 13.9 * 86_400_000)
  })

  it("signs out (idempotently), and clears the cookie", async () => {
    const { key } = await createKey("secret", ["read"])
    const { cookie } = await signIn(key)
    const crossSite = await withCookie(
      cookie as string,
      "/v1/session",
      { method: "DELETE" },
      "https://evil.example",
    )
    expect(crossSite.status).toBe(403)
    const out = await withCookie(cookie as string, "/v1/session", { method: "DELETE" })
    expect(out.status).toBe(204)
    expect(out.headers.get("set-cookie")).toMatch(new RegExp(`${COOKIE}=;.*Max-Age=0`, "i"))
    expect((await withCookie(cookie as string, "/v1/me")).status).toBe(401)
    expect((await withCookie(cookie as string, "/v1/session", { method: "DELETE" })).status).toBe(204)
    expect((await call("/v1/session", { method: "DELETE" })).status).toBe(204)
  })

  it("lists your sessions, ends one, and signs out everywhere else", async () => {
    const { key, apiKey } = await createKey("secret", ["read"])
    const first = await signIn(key, { origin: ORIGIN, "user-agent": "Firefox", "cf-ipcountry": "NG" })
    const second = await signIn(key)
    const third = await signIn(key)
    const other = await signIn((await createKey("secret", ["read"])).key)

    const list = await json<{ sessions: Session[] }>(await withCookie(first.cookie as string, "/v1/sessions"))
    expect(list.sessions).toHaveLength(3)
    expect(list.sessions.filter((s) => s.current).map((s) => s.id)).toEqual([(first.body as Me).session?.id])
    expect(list.sessions.every((s) => s.key?.id === apiKey.id && s.via === "session-key")).toBe(true)
    expect(list.sessions.find((s) => s.current)).toMatchObject({ userAgent: "Firefox", location: "NG" })

    // Another key's session is not yours to see or end.
    const otherId = (other.body as Me).session?.id as string
    expect(list.sessions.map((s) => s.id)).not.toContain(otherId)
    const notYours = await withCookie(first.cookie as string, `/v1/sessions/${otherId}`, { method: "DELETE" })
    expect(notYours.status).toBe(404)

    const secondId = (second.body as Me).session?.id as string
    expect(
      (await withCookie(first.cookie as string, `/v1/sessions/${secondId}`, { method: "DELETE" })).status,
    ).toBe(204)
    expect((await withCookie(second.cookie as string, "/v1/me")).status).toBe(401)

    const everywhere = await withCookie(first.cookie as string, "/v1/sessions", { method: "DELETE" })
    expect(await json(everywhere)).toEqual({ ended: 1 })
    expect((await withCookie(third.cookie as string, "/v1/me")).status).toBe(401)
    expect((await withCookie(first.cookie as string, "/v1/me")).status).toBe(200)
    expect((await withCookie(other.cookie as string, "/v1/me")).status).toBe(200)
  })

  it("signs the raw routes in by cookie too, with the same CSRF rule for writes and WebSockets", async () => {
    const { key } = await createKey("secret", ["read", "send"])
    const { cookie } = await signIn(key)
    // A raw GET (a stats CSV) works on the cookie alone.
    const csv = await withCookie(cookie as string, "/v1/stats/volume.csv", {}, "")
    expect(csv.status).not.toBe(401)
    // A raw write from another site is refused.
    const upload = await withCookie(
      cookie as string,
      "/v1/uploads",
      { method: "POST", body: "x", headers: { "content-type": "text/plain" } },
      "https://evil.example",
    )
    expect(upload.status).toBe(403)
    expect(await json<{ error: { reason: string } }>(upload)).toMatchObject({ error: { reason: "csrf" } })
    // A WebSocket from another site is refused even though it's a GET.
    const ws = await withCookie(
      cookie as string,
      "/v1/mailboxes/mbx_nope/live",
      { headers: { upgrade: "websocket" } },
      "https://evil.example",
    )
    expect(ws.status).toBe(403)
    // An ended session is a 401 there as well, and clears the cookie.
    await withCookie(cookie as string, "/v1/session", { method: "DELETE" })
    const after = await withCookie(cookie as string, "/v1/stats/volume.csv", {}, "")
    expect(after.status).toBe(401)
    expect(await json<{ error: { reason: string } }>(after)).toMatchObject({
      error: { reason: "session-expired" },
    })
  })

  it("prunes sessions long past their end", async () => {
    const { key } = await createKey("secret", ["read"])
    const { body } = await signIn(key)
    const id = (body as Me).session?.id
    await env.DB.prepare("update sessions set expires_at = ? where id = ?")
      .bind(Date.now() - 31 * 86_400_000, id)
      .run()
    const { pruneSessions } = await import("../src/domain/sessions.ts")
    const { runtimeFor } = await import("../src/workers/inbound.ts")
    await runtimeFor(env).runPromise(pruneSessions())
    expect(await env.DB.prepare("select id from sessions where id = ?").bind(id).first()).toBeNull()
  })
})

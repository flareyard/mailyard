import { env, exports } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import type { Env } from "../src/Bindings.ts"
import { handleFlareyardCallback, handleFlareyardStart } from "../src/workers/flareyardSignIn.ts"
import { json } from "./helpers.ts"

/**
 * HAL-3360: "Open Mailyard" from Flareyard. The platform (flareyard/flareyard#26) is played by a fake
 * on https://platform.test that checks the PKCE verifier against the challenge it was sent, the way
 * the real one does, and answers with the install it was asked about.
 */
const ORIGIN = "https://mailyard.test"
const PLATFORM = "https://platform.test"
const INSTALL = "ins_mailyard_1"
const COOKIE = "__Host-mailyard_session"
const FLOW = "__Host-mailyard_flareyard"
const uid = () => crypto.randomUUID().slice(0, 8)

const installed = { ...env, FLAREYARD_URL: PLATFORM, FLAREYARD_INSTALL_ID: INSTALL } as unknown as Env

const b64url = (bytes: ArrayBuffer) => {
  let s = ""
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** What the fake platform hands out: one code per authorization, bound to its challenge. */
const codes = new Map<
  string,
  { challenge: string; user: { id: string; email: string; name: string }; installation: string }
>()
let answer: "ok" | "invalid_grant" | "down" = "ok"
const exchanged: Array<{ path: string; body: { code: string; code_verifier: string } }> = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== PLATFORM) return realFetch(input, init)
  if (answer === "down") throw new Error("unreachable")
  const body = (await request.json()) as { code: string; code_verifier: string }
  exchanged.push({ path: url.pathname, body })
  const issued = codes.get(body.code)
  const digest = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier)))
  if (answer === "invalid_grant" || !issued || issued.challenge !== digest) {
    codes.delete(body.code)
    return Response.json({ error: "invalid_grant" }, { status: 400 })
  }
  codes.delete(body.code)
  return Response.json({ user: issued.user, installation: issued.installation, app: "mailyard" })
}) as typeof fetch
afterEach(() => {
  answer = "ok"
  exchanged.length = 0
})

const flowCookie = (res: Response) => {
  const value = (res.headers.get("set-cookie") ?? "").match(new RegExp(`${FLOW}=([^;]+)`))?.[1]
  if (!value) throw new Error("no flow cookie")
  return `${FLOW}=${value}`
}

/** Starts the hand-off; the platform "approves" as `user` for `installation`. */
const begin = async (
  user: { id: string; email: string; name: string },
  options: { readonly back?: string; readonly installation?: string } = {},
) => {
  const start = await handleFlareyardStart(
    new Request(
      `${ORIGIN}/v1/session/flareyard/start${options.back ? `?return=${encodeURIComponent(options.back)}` : ""}`,
    ),
    installed,
  )
  expect(start.status).toBe(302)
  const to = new URL(start.headers.get("location") ?? "")
  const state = to.searchParams.get("state") ?? ""
  const code = `fyc_${uid()}`
  codes.set(code, {
    challenge: to.searchParams.get("code_challenge") ?? "",
    user,
    installation: options.installation ?? INSTALL,
  })
  return { to, state, code, cookie: flowCookie(start) }
}

const finish = (query: string, cookie: string | null) =>
  handleFlareyardCallback(
    new Request(`${ORIGIN}/v1/session/flareyard/callback?${query}`, { headers: cookie ? { cookie } : {} }),
    installed,
  )

const sessionOf = (res: Response) => {
  const token = (res.headers.get("set-cookie") ?? "").match(new RegExp(`${COOKIE}=([^;]+)`))?.[1]
  if (!token) throw new Error(`no session cookie (${res.status} ${res.headers.get("location")})`)
  return `${COOKIE}=${token}`
}

const me = async (cookie: string) =>
  json<{ user: { email: string } | null; role: string | null }>(
    await exports.default.fetch(new Request(`${ORIGIN}/v1/me`, { headers: { cookie } })),
  )

const person = () => {
  const id = uid()
  return { id: `fyu_${id}`, email: `owner-${id}@example.test`, name: `Owner ${id}` }
}

describe("signing in through Flareyard (HAL-3360)", () => {
  it("isn't offered, and isn't served, on an install Flareyard didn't make", async () => {
    const start = await exports.default.fetch(new Request(`${ORIGIN}/v1/session/flareyard/start`))
    expect(start.status).toBe(404)
    const doc = await json<{ paths: Record<string, unknown> }>(
      await exports.default.fetch(new Request(`${ORIGIN}/openapi.json`)),
    )
    expect(Object.keys(doc.paths)).not.toContain("/v1/session/flareyard/start")
    expect(Object.keys(doc.paths)).not.toContain("/v1/session/flareyard/callback")
    expect(Object.keys(doc.paths)).toContain("/v1/session/link/{token}")
  })

  it("sends the browser to Flareyard with PKCE, the install and this origin", async () => {
    const { to, cookie } = await begin(person())
    expect(to.origin + to.pathname).toBe(`${PLATFORM}/auth/app`)
    expect(to.searchParams.get("install")).toBe(INSTALL)
    expect(to.searchParams.get("origin")).toBe(ORIGIN)
    expect(to.searchParams.get("code_challenge_method")).toBe("S256")
    expect(to.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(to.searchParams.get("state")?.length).toBeGreaterThanOrEqual(20)
    // The verifier stays in an HttpOnly cookie on this host and never goes to the platform's URL.
    expect(cookie.startsWith(`${FLOW}=`)).toBe(true)
    expect(to.toString()).not.toContain(cookie.split(".")[1] ?? "verifier")
  })

  it("lets the install's owner claim an unclaimed workspace, then signs the next owner in as an admin", async () => {
    const first = person()
    const a = await begin(first, { back: "/mail" })
    const signedIn = await finish(`code=${a.code}&state=${a.state}`, a.cookie)
    expect(signedIn.status).toBe(303)
    expect(signedIn.headers.get("location")).toBe("/mail")
    expect(exchanged[0]).toMatchObject({
      path: `/api/v1/installs/${INSTALL}/session`,
      body: { code: a.code },
    })
    expect(await me(sessionOf(signedIn))).toMatchObject({ user: { email: first.email }, role: "owner" })
    // The flow cookie is gone.
    expect(signedIn.headers.get("set-cookie")).toContain(`${FLOW}=; Max-Age=0`)

    const second = person()
    const b = await begin(second)
    const joined = await finish(`code=${b.code}&state=${b.state}`, b.cookie)
    expect(joined.headers.get("location")).toBe("/")
    expect(await me(sessionOf(joined))).toMatchObject({ user: { email: second.email }, role: "admin" })

    // The first one again: the same member, still the owner.
    const c = await begin(first)
    const again = await finish(`code=${c.code}&state=${c.state}`, c.cookie)
    expect(await me(sessionOf(again))).toMatchObject({ user: { email: first.email }, role: "owner" })
    const audited = await env.DB.prepare(
      "select action from audit where action in ('workspace.claim', 'member.join') and actor like 'flareyard:%'",
    ).all<{ action: string }>()
    expect(audited.results.map((r) => r.action).sort()).toEqual(["member.join", "workspace.claim"])
  })

  it("signs nobody in without this browser's state, or with a spent or wrong code", async () => {
    const who = person()
    const a = await begin(who)
    const loc = async (res: Response | Promise<Response>) => (await res).headers.get("location")
    expect(await loc(finish(`code=${a.code}&state=${a.state}`, null))).toBe("/sign-in?error=flareyard_state")
    expect(await loc(finish(`code=${a.code}&state=forged`, a.cookie))).toBe("/sign-in?error=flareyard_state")
    expect(exchanged).toEqual([])

    answer = "invalid_grant"
    expect(await loc(finish(`code=${a.code}&state=${a.state}`, a.cookie))).toBe(
      "/sign-in?error=flareyard_session_expired",
    )
    answer = "down"
    const b = await begin(who)
    expect(await loc(finish(`code=${b.code}&state=${b.state}`, b.cookie))).toBe(
      "/sign-in?error=flareyard_unreachable",
    )
    answer = "ok"
    expect(await loc(finish("error=access_denied&state=x", null))).toBe("/sign-in?error=flareyard_denied")
  })

  it("refuses an answer that names another install", async () => {
    const a = await begin(person(), { installation: "ins_someone_else" })
    const res = await finish(`code=${a.code}&state=${a.state}`, a.cookie)
    expect(res.headers.get("location")).toBe("/sign-in?error=flareyard_wrong_install")
    expect(res.headers.get("set-cookie") ?? "").not.toContain(`${COOKIE}=`)
  })

  it("lands only on paths of this site", async () => {
    const a = await begin(person(), { back: "//evil.example/steal" })
    const res = await finish(`code=${a.code}&state=${a.state}`, a.cookie)
    expect(res.headers.get("location")).toBe("/")
  })
})

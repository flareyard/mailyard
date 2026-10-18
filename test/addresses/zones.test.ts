import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import type { Env } from "../../src/Bindings.ts"
import { createDomain, domainCandidates, fixDomain } from "../../src/domain/domains.ts"
import { runtimeFor } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

/** HAL-3365: zone details, changedAt, the checking state, fixing records and candidates. */
installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 6)

type Check = { id: string; status: string; changedAt?: number }
type Detail = {
  id: string
  name: string
  zoneId: string | null
  zoneStatus: string | null
  zoneName: string | null
  nameservers: Array<string> | null
  currentNameservers: Array<string> | null
  registrar: string | null
  dnssec: string | null
  complaints30d: number | null
  returnPath: string | null
  checks: Array<Check>
}

/** Cloudflare's API as the zone token sees it: one zone, its sending subdomain, and every write recorded. */
const writes: Array<{ method: string; path: string; body: unknown }> = []
const zones = new Map<string, { id: string; name: string }>()
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname !== "api.cloudflare.com") return realFetch(input, init)
  if (request.headers.get("authorization") !== "Bearer zone-token")
    return Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 })
  const path = url.pathname.replace("/client/v4", "")
  const ok = (result: unknown, info?: unknown) =>
    Response.json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) })
  const zoneOf = (z: { id: string; name: string }) => ({
    id: z.id,
    name: z.name,
    status: "active",
    name_servers: ["ashton.ns.cloudflare.com", "bailey.ns.cloudflare.com"],
    original_name_servers: ["launch1.spaceship.net"],
    original_registrar: "spaceship, inc. (id: 3862)",
  })
  if (request.method !== "GET") {
    writes.push({ method: request.method, path, body: await request.json().catch(() => null) })
    return ok({})
  }
  if (path === "/zones") {
    const name = url.searchParams.get("name")
    const all = [...zones.values()].map(zoneOf)
    return ok(name ? all.filter((z) => z.name === name) : all, { total_pages: 1 })
  }
  const m = /^\/zones\/([^/]+)\/(.*)$/.exec(path)
  const zone = [...zones.values()].find((z) => z.id === m?.[1])
  if (!zone) return Response.json({ success: false, errors: [{ message: "no zone" }] }, { status: 404 })
  if (m?.[2] === "dnssec") return ok({ status: "active" })
  if (m?.[2] === "email/sending/subdomains")
    return ok([{ id: `sub-${zone.id}`, name: zone.name, return_path_domain: `cf-bounce.${zone.name}` }])
  if (m?.[2]?.endsWith("/reputation/complaints")) {
    const from = Date.parse(url.searchParams.get("start_at") ?? "")
    const to = Date.parse(url.searchParams.get("end_at") ?? "")
    if (to - from > 7 * 86_400_000)
      return Response.json({ success: false, errors: [{ message: "window too long" }] }, { status: 400 })
    return ok({ complaints: 1 })
  }
  return Response.json({ success: false, errors: [{ message: `unknown ${path}` }] }, { status: 404 })
}) as typeof fetch

const withToken = { ...env, CLOUDFLARE_DNS_TOKEN: "zone-token" } as Env
// The API's handler is built once per isolate from the first env, so token cases run the domain
// functions on a runtime of their own, as test/suppressions.test.ts does.
// biome-ignore lint/suspicious/noExplicitAny: the app's services, provided by the runtime.
const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  runtimeFor(withToken).runPromise(effect as never) as Promise<A>
const encode = <A>(value: A) => JSON.parse(JSON.stringify(value))
const addWithToken = (name: string) => run(createDomain({ name }, "test")).then(encode) as Promise<Detail>
const fixWithToken = (id: string) =>
  run(
    fixDomain(id, "test").pipe(
      Effect.map((r) => ({ status: 200, body: encode(r) })),
      Effect.catchTag("DomainFixRefused", (e) => Effect.succeed({ status: 409, body: { reason: e.reason } })),
    ),
  )

const nsFor = (name: string) => ({
  [`NS ${name}`]: ["ashton.ns.cloudflare.com.", "bailey.ns.cloudflare.com."],
})

describe("domain zone details (HAL-3365)", () => {
  it("without a zone token: public nameservers, the rest null, and fixing refused with a reason", async () => {
    const name = `plain-${uid()}.test`
    setDns({ ...goodDomain(name), ...nsFor(name) })
    const d = await json<Detail>(await call("/v1/domains", { method: "POST", key: ADMIN, json: { name } }))
    expect(d).toMatchObject({
      zoneName: name,
      currentNameservers: ["ashton.ns.cloudflare.com", "bailey.ns.cloudflare.com"],
      nameservers: null,
      zoneStatus: null,
      registrar: null,
      dnssec: null,
      complaints30d: null,
      returnPath: `cf-bounce.${name}`,
    })
    const fix = await call(`/v1/domains/${d.id}/fix`, { method: "POST", key: ADMIN })
    expect(fix.status).toBe(409)
    expect(await json<{ reason: string }>(fix)).toMatchObject({ reason: "no_dns_token" })
    expect(await json(await call("/v1/domains/candidates", { key: ADMIN }))).toEqual({
      connected: false,
      candidates: [],
    })
  })

  it("keeps when each check last changed", async () => {
    const name = `drift-${uid()}.test`
    setDns({ ...goodDomain(name), ...nsFor(name) })
    const first = await json<Detail>(
      await call("/v1/domains", { method: "POST", key: ADMIN, json: { name } }),
    )
    const at = (d: Detail, id: string) => d.checks.find((c) => c.id === id)?.changedAt
    expect(at(first, "mx")).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 5))
    const same = await json<Detail>(
      await call(`/v1/domains/${first.id}/recheck`, { method: "POST", key: ADMIN }),
    )
    expect(at(same, "mx")).toBe(at(first, "mx"))
    setDns({ [`MX ${name}`]: [] })
    await new Promise((r) => setTimeout(r, 5))
    const broken = await json<Detail>(
      await call(`/v1/domains/${first.id}/recheck`, { method: "POST", key: ADMIN }),
    )
    expect(broken.checks.find((c) => c.id === "mx")?.status).toBe("fail")
    expect(at(broken, "mx")).toBeGreaterThan(at(first, "mx") ?? 0)
    expect(at(broken, "spf")).toBe(at(first, "spf"))
  })

  it("shows checks as checking while a recheck runs", async () => {
    const name = `slow-${uid()}.test`
    setDns({ ...goodDomain(name), ...nsFor(name) })
    const d = await json<Detail>(await call("/v1/domains", { method: "POST", key: ADMIN, json: { name } }))
    // Hold this domain's MX lookup until the stored checks have been read mid-recheck.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url)
      if (
        url.hostname === "cloudflare-dns.com" &&
        url.searchParams.get("name") === name &&
        url.searchParams.get("type") === "MX"
      )
        await held
      return inner(input, init)
    }) as typeof fetch
    try {
      const recheck = call(`/v1/domains/${d.id}/recheck`, { method: "POST", key: ADMIN })
      let seen: Array<string> = []
      for (let i = 0; i < 100 && !seen.includes("checking"); i++) {
        await new Promise((r) => setTimeout(r, 20))
        const row = await env.DB.prepare("select checks from domains where id = ?")
          .bind(d.id)
          .first<{ checks: string }>()
        seen = (JSON.parse(row?.checks ?? "[]") as Array<Check>).map((c) => c.status)
      }
      expect(seen.every((s) => s === "checking")).toBe(true)
      release()
      const done = await json<Detail>(await recheck)
      expect(done.checks.every((c) => c.status === "pass")).toBe(true)
    } finally {
      release()
      globalThis.fetch = inner
    }
  })

  it("with a zone token: status, nameservers, registrar, DNSSEC and 30 days of complaints", async () => {
    const name = `zoned-${uid()}.test`
    zones.set(name, { id: `z-${uid()}`, name })
    setDns({ ...goodDomain(name), ...nsFor(name) })
    const d = await addWithToken(name)
    expect(d).toMatchObject({
      zoneId: zones.get(name)?.id,
      zoneStatus: "active",
      zoneName: name,
      nameservers: ["ashton.ns.cloudflare.com", "bailey.ns.cloudflare.com"],
      registrar: "spaceship, inc. (id: 3862)",
      dnssec: "active",
      // Five windows of at most seven days, one complaint each.
      complaints30d: 5,
      returnPath: `cf-bounce.${name}`,
    })
    // Plain reads serve what the recheck stored.
    const read = await json<Detail>(await call(`/v1/domains/${d.id}`, { key: ADMIN }))
    expect(read.zoneStatus).toBe("active")
    const list = await json<{ domains: Array<{ id: string; zoneStatus: string | null }> }>(
      await call("/v1/domains", { key: ADMIN }),
    )
    expect(list.domains.find((x) => x.id === d.id)?.zoneStatus).toBe("active")
  })

  it("fixes failing records through Email Routing, Email Sending and a DMARC TXT, then rechecks", async () => {
    const name = `broken-${uid()}.test`
    const zoneId = `z-${uid()}`
    zones.set(name, { id: zoneId, name })
    const good = goodDomain(name)
    setDns({
      ...good,
      [`MX ${name}`]: [],
      [`MX cf-bounce.${name}`]: [],
      [`TXT _dmarc.${name}`]: [],
      ...nsFor(name),
    })
    const d = await addWithToken(name)
    expect(
      d.checks
        .filter((c) => c.status === "fail")
        .map((c) => c.id)
        .sort(),
    ).toEqual(["bounce-mx", "dmarc", "mx"])
    writes.length = 0
    // Cloudflare fixed it: the recheck after the fix passes.
    setDns(good)
    const res = await fixWithToken(d.id)
    expect(res.status).toBe(200)
    const fixed = res.body as {
      domain: Detail
      actions: Array<{ action: string; ok: boolean; checks: string[] }>
    }
    expect(fixed.actions.map((a) => [a.action, a.ok])).toEqual([
      ["enable_routing", true],
      ["fix_sending", true],
      ["add_dmarc", true],
    ])
    expect(writes).toEqual([
      { method: "POST", path: `/zones/${zoneId}/email/routing/dns`, body: { name } },
      { method: "POST", path: `/zones/${zoneId}/email/sending/subdomains/sub-${zoneId}/dns`, body: null },
      {
        method: "POST",
        path: `/zones/${zoneId}/dns_records`,
        body: {
          type: "TXT",
          name: `_dmarc.${name}`,
          content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${name}`,
          ttl: 1,
        },
      },
    ])
    expect(fixed.domain.checks.every((c) => c.status === "pass")).toBe(true)
    expect((await fixWithToken(d.id)).body).toMatchObject({ reason: "nothing_to_fix" })
  })

  it("leaves a wrong DMARC record for a person, and refuses a domain the token can't see", async () => {
    const name = `policy-${uid()}.test`
    zones.set(name, { id: `z-${uid()}`, name })
    setDns({ ...goodDomain(name), [`TXT _dmarc.${name}`]: ["v=DMARC1; p=bogus"], ...nsFor(name) })
    const d = await addWithToken(name)
    const fixed = (await fixWithToken(d.id)).body as { actions: Array<{ action: string; ok: boolean }> }
    expect(fixed.actions).toEqual([expect.objectContaining({ action: "manual", ok: false })])

    const elsewhere = `elsewhere-${uid()}.test`
    setDns({ [`MX ${elsewhere}`]: [] })
    const other = await addWithToken(elsewhere)
    // It has a failing MX, but no zone the token can see.
    expect(await fixWithToken(other.id)).toEqual({ status: 409, body: { reason: "zone_not_found" } })
  })

  it("lists the account's zones as candidates, with what's in the workspace and their MX", async () => {
    const fresh = `fresh-${uid()}.test`
    zones.set(fresh, { id: `z-${uid()}`, name: fresh })
    setDns({ [`MX ${fresh}`]: ["10 mx1.spacemail.com."] })
    const body = (await run(domainCandidates())) as {
      connected: boolean
      candidates: Array<{ name: string; inWorkspace: boolean; existingMx: string[]; zoneStatus: string }>
    }
    expect(body.connected).toBe(true)
    expect(body.candidates.find((c) => c.name === fresh)).toMatchObject({
      inWorkspace: false,
      existingMx: ["10 mx1.spacemail.com."],
      zoneStatus: "active",
    })
    const added = [...zones.keys()].find((z) => z.startsWith("zoned-"))
    if (added) expect(body.candidates.find((c) => c.name === added)?.inWorkspace).toBe(true)
  })
})

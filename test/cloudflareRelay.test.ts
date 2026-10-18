import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { afterEach, describe, expect, it } from "vitest"
import manifest from "../cloudflare-app.json"
import type { Env } from "../src/Bindings.ts"
import { clearUpstreamCache, upstreamRejections } from "../src/domain/routingAnalytics.ts"
import { CloudflareEmail } from "../src/services/CloudflareEmail.ts"
import { CloudflareZones } from "../src/services/CloudflareZones.ts"
import { cloudflareApi, DIRECT_API, relayRefusal } from "../src/services/cloudflareApi.ts"
import { runtimeFor } from "../src/workers/inbound.ts"

/**
 * HAL-3558: installed through Flareyard, every Cloudflare call goes to the relay with the install's
 * key, and every one of them is a route the manifest declares (contract v1.3). Checked both ways:
 * no call the relay would refuse as undeclared, and no declared route the code never makes.
 */
const RELAY = "https://relay.test/api/v1/installs/ins_1/cloudflare"
const ACCOUNT = "a".repeat(32)
const ZONE = "b".repeat(32)

type Call = { method: string; path: string; query: string; auth: string | null; host: string }
const calls: Array<Call> = []
let answer: (call: Call) => Response = (call) => ok(call)

const ok = (call: Call) => {
  if (call.path === "/zones")
    return Response.json({ success: true, result: [{ id: ZONE, name: "acme.test", status: "active" }] })
  if (call.path.endsWith("/queues"))
    return Response.json({ success: true, result: [{ queue_id: "q1", queue_name: "mailyard-email-events" }] })
  if (call.path.endsWith("/email/sending/subdomains") && call.method === "GET")
    return Response.json({ success: true, result: [{ id: "sub1", name: "acme.test" }] })
  if (call.path.endsWith("/dns_records") && call.method === "GET")
    return Response.json({
      success: true,
      result: [{ id: "rec1", type: "TXT", name: "_dmarc.acme.test", content: "v=DMARC1; p=none" }],
    })
  if (call.path.endsWith("/complaints")) return Response.json({ success: true, result: { complaints: 0 } })
  if (call.path.endsWith("/dnssec")) return Response.json({ success: true, result: { status: "active" } })
  if (call.path.endsWith("/suppressions/bulk"))
    return Response.json({
      success: true,
      result: { items: [{ email: "a@b.test", status: "processed", id: "s1" }] },
    })
  if (call.path.endsWith("/suppressions") && call.method === "POST")
    return Response.json({ success: true, result: { id: "s1" } })
  return Response.json({ success: true, result: [], result_info: { total_pages: 1 } })
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const relayed = request.url.startsWith(RELAY)
  if (!relayed && url.hostname !== "api.cloudflare.com") return realFetch(input, init)
  const call: Call = {
    method: request.method,
    path: relayed
      ? (request.url.slice(RELAY.length).split("?")[0] ?? "")
      : url.pathname.replace(/^\/client\/v4/, ""),
    query: url.search,
    auth: request.headers.get("authorization"),
    host: relayed ? "relay" : "direct",
  }
  calls.push(call)
  if (!relayed)
    return Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptiveGroups: [] }] } }, errors: null })
  return answer(call)
}) as typeof fetch
afterEach(() => {
  calls.length = 0
  answer = ok
  clearUpstreamCache()
})

/** On the platform: the relay's URL and key, the account var, and none of the pasted tokens. */
const platform = {
  ...env,
  FLAREYARD_CF_API: RELAY,
  FLAREYARD_CF_TOKEN: "relay-key",
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_EMAIL_READ_TOKEN: undefined,
  CLOUDFLARE_EMAIL_WRITE_TOKEN: undefined,
  CLOUDFLARE_DNS_TOKEN: undefined,
  CLOUDFLARE_ANALYTICS_TOKEN: "analytics-token",
} as unknown as Env

/** The manifest route a call matches, by the relay's own rules. */
const routeOf = (call: Call) =>
  manifest.cloudflareApi.routes.find((r) => {
    if (r.method !== call.method) return false
    const want = r.path.split("/")
    const got = call.path.split("/")
    if (want.length !== got.length) return false
    return want.every((w, i) => {
      const g = got[i] ?? ""
      if (w === "{account}") return g === ACCOUNT
      if (w === "{zone}") return /^[0-9a-f]{32}$/.test(g)
      if (w === "{id}") return g.length > 0 && !g.includes("/")
      return w === g
    })
  })

const everything = Effect.gen(function* () {
  const email = yield* CloudflareEmail
  yield* email.verifiedAddresses
  yield* email.limits
  yield* email.reputation
  yield* email.subscribedDomains
  yield* email.suppressions.page(null)
  yield* email.suppressions.find("a@b.test")
  yield* email.suppressions.create("a@b.test", "note")
  yield* email.suppressions.bulk([{ email: "a@b.test", note: "n" }])
  yield* email.suppressions.remove("s1")
  const zones = yield* CloudflareZones
  yield* zones.zoneFor("acme.test")
  yield* zones.zones
  yield* zones.dnssec(ZONE)
  yield* zones.sendingSubdomain(ZONE, "acme.test")
  yield* zones.complaints(ZONE, "sub1", 7)
  yield* zones.enableRouting(ZONE, "acme.test")
  yield* zones.fixSending(ZONE, "acme.test")
  yield* zones.fixSending(ZONE, "new.acme.test")
  yield* zones.createTxt(ZONE, "_dmarc.acme.test", "v=DMARC1; p=none")
  yield* zones.txtRecords(ZONE, "_dmarc.acme.test")
  yield* zones.updateTxt(ZONE, "rec1", "_dmarc.acme.test", "v=DMARC1; p=quarantine")
  yield* zones.routingRules(ZONE)
  yield* zones.routeToWorker(
    ZONE,
    { id: "rule1", matchers: [{ type: "literal", field: "to", value: "x@acme.test" }], actions: [] },
    "mailyard-api",
  )
  return { email: email.connected, zones: zones.connected }
})

describe("Cloudflare calls through Flareyard's relay (HAL-3558)", () => {
  it("picks the relay and its key when the platform sets them, and the pasted token otherwise", () => {
    expect(cloudflareApi(platform, "pasted")).toEqual({ base: RELAY, token: "relay-key", relayed: true })
    expect(cloudflareApi({ ...env, FLAREYARD_CF_API: undefined } as unknown as Env, "pasted")).toEqual({
      base: DIRECT_API,
      token: "pasted",
      relayed: false,
    })
  })

  it("sends every call to the relay with the install's key, each one a declared route, and uses every route", async () => {
    const connected = await runtimeFor(platform).runPromise(everything)
    expect(connected).toEqual({ email: true, zones: true })
    const relayed = calls.filter((c) => c.host === "relay")
    expect(relayed.length).toBeGreaterThan(20)
    for (const c of relayed) {
      expect({ call: `${c.method} ${c.path}`, auth: c.auth }).toEqual({
        call: `${c.method} ${c.path}`,
        auth: "Bearer relay-key",
      })
      expect({ call: `${c.method} ${c.path}`, declared: Boolean(routeOf(c)) }).toEqual({
        call: `${c.method} ${c.path}`,
        declared: true,
      })
    }
    const used = new Set(relayed.map((c) => routeOf(c)))
    const unused = manifest.cloudflareApi.routes
      .filter((r) => !used.has(r))
      .map((r) => `${r.method} ${r.path}`)
    expect(unused).toEqual([])
    expect(calls.filter((c) => c.host === "direct")).toEqual([])
  })

  it("looks zones up through the relay, and keeps GraphQL on Cloudflare with the analytics token", async () => {
    await env.DB.prepare(
      "insert into domains (id, name, zone_id, routing_enabled, sending_enabled, created_at, updated_at) values (?, ?, null, 1, 0, ?, ?)",
    )
      .bind(
        `dom_relay_${crypto.randomUUID().slice(0, 8)}`,
        `relay-${crypto.randomUUID().slice(0, 8)}.test`,
        Date.now(),
        Date.now(),
      )
      .run()
    await runtimeFor(platform).runPromise(upstreamRejections(["2026-10-18"], Date.UTC(2026, 9, 18, 12)))
    const lookups = calls.filter((c) => c.path === "/zones")
    expect(lookups.length).toBeGreaterThan(0)
    expect(lookups.every((c) => c.host === "relay" && c.auth === "Bearer relay-key")).toBe(true)
    const graphql = calls.filter((c) => c.path === "/graphql")
    expect(graphql.length).toBeGreaterThan(0)
    expect(graphql.every((c) => c.host === "direct" && c.auth === "Bearer analytics-token")).toBe(true)
  })

  it("words the relay's refusals for a person", async () => {
    expect(relayRefusal({ errors: [{ code: 10404, message: "scope not granted" }] })).toContain("Grant it")
    expect(relayRefusal({ errors: [{ code: 10402 }] })).toContain("Reconnect Cloudflare")
    expect(relayRefusal({ errors: [{ code: 1000 }] })).toBeNull()
    answer = () =>
      Response.json(
        { success: false, errors: [{ code: 10404, message: "scope dns.write not granted" }] },
        { status: 403 },
      )
    const outcome = await runtimeFor(platform).runPromise(
      Effect.gen(function* () {
        return yield* (yield* CloudflareZones).updateTxt(
          ZONE,
          "rec1",
          "_dmarc.acme.test",
          "v=DMARC1; p=reject",
        )
      }),
    )
    expect(outcome).toMatchObject({ ok: false, status: 403 })
    expect(outcome.ok ? "" : outcome.message).toContain("permission you haven't granted")
  })
})

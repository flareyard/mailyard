import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { afterEach, describe, expect, it } from "vitest"
import manifest from "../cloudflare-app.json"
import type { Env } from "../src/Bindings.ts"
import { changePolicy } from "../src/dmarc/reports.ts"
import { domainCandidates } from "../src/domain/domains.ts"
import { clearUpstreamCache, QUERY, upstreamRejections } from "../src/domain/routingAnalytics.ts"
import { pushSuppression } from "../src/domain/suppressions.ts"
import { CloudflareEmail } from "../src/services/CloudflareEmail.ts"
import { CloudflareZones } from "../src/services/CloudflareZones.ts"
import { cloudflareApi, DIRECT_API, relayRefusal, relayRefusalOf } from "../src/services/cloudflareApi.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { installDohFixture, setDns } from "./dns.ts"

/**
 * HAL-3558: installed through Flareyard, every Cloudflare call goes to the relay with the install's
 * key, and every one of them is a route the manifest declares (contract v1.3). Checked both ways:
 * no call the relay would refuse as undeclared, and no declared route the code never makes.
 */
installDohFixture()

const RELAY = "https://relay.test/api/v1/installs/ins_1/cloudflare"
const ACCOUNT = "a".repeat(32)
const ZONE = "b".repeat(32)

type Call = {
  method: string
  path: string
  query: string
  auth: string | null
  host: string
  body: string | null
}
const calls: Array<Call> = []
let answer: (call: Call) => Response = (call) => ok(call)

const GRAPHQL_DATA = { data: { viewer: { zones: [{ emailRoutingAdaptiveGroups: [] }] } }, errors: null }

const ok = (call: Call) => {
  if (call.path === "/graphql") return Response.json(GRAPHQL_DATA)
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
    body: request.method === "GET" ? null : await request.text(),
  }
  calls.push(call)
  return relayed ? answer(call) : ok(call)
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
  CLOUDFLARE_ANALYTICS_TOKEN: undefined,
} as unknown as Env

/** Self-hosted: no relay, the pasted analytics token. */
const selfHosted = {
  ...env,
  FLAREYARD_CF_API: undefined,
  FLAREYARD_CF_TOKEN: undefined,
  CLOUDFLARE_DNS_TOKEN: "dns-token",
  CLOUDFLARE_ANALYTICS_TOKEN: "analytics-token",
} as unknown as Env

const uid = () => crypto.randomUUID().slice(0, 8)

/** A receiving domain with no stored zone, so every path has to look its zone up. */
const receivingDomain = async () => {
  const id = `dom_relay_${uid()}`
  const name = `relay-${uid()}.test`
  await env.DB.prepare(
    "insert into domains (id, name, zone_id, routing_enabled, sending_enabled, created_at, updated_at) values (?, ?, null, 1, 0, ?, ?)",
  )
    .bind(id, name, Date.now(), Date.now())
    .run()
  return { id, name }
}

/** Every relayed call refused for a missing scope, the way the relay words it. */
const refuseScope = () =>
  Response.json(
    {
      success: false,
      errors: [
        {
          code: 10404,
          message: "This needs DNS: Edit (dns.write). Grant it from the app's page in Flareyard.",
        },
      ],
      messages: [],
      result: null,
    },
    { status: 403 },
  )
const SCOPE_REFUSAL = { reason: "scope_not_granted", code: 10404, scope: "dns.write" }

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

  it("looks zones up and sends the declared GraphQL query through the relay, word for word", async () => {
    await receivingDomain()
    const counted = await runtimeFor(platform).runPromise(
      upstreamRejections(["2026-10-18"], Date.UTC(2026, 9, 18, 12)),
    )
    expect(counted.connected).toBe(true)
    const lookups = calls.filter((c) => c.path === "/zones")
    expect(lookups.length).toBeGreaterThan(0)
    expect(lookups.every((c) => c.host === "relay" && c.auth === "Bearer relay-key")).toBe(true)
    const graphql = calls.filter((c) => c.path === "/graphql")
    expect(graphql.length).toBeGreaterThan(0)
    expect(graphql.every((c) => c.host === "relay" && c.auth === "Bearer relay-key")).toBe(true)
    // The relay sends only a declared query: the text sent is the manifest's, whitespace aside.
    const declared = manifest.cloudflareApi.graphql.find((q) => q.name === "MailyardRoutingRejections")
    const squash = (q: string) => q.replace(/\s+/g, " ").trim()
    for (const c of graphql) {
      const sent = JSON.parse(c.body ?? "{}") as { query: string; variables: Record<string, string> }
      expect(squash(sent.query)).toBe(squash(declared?.query ?? ""))
      expect(sent.variables[declared?.zoneVariable ?? ""]).toMatch(/^[0-9a-f]{32}$/)
    }
    expect(squash(declared?.query ?? "")).toBe(squash(QUERY))
    expect(manifest.scopes.optional.map((s) => s.scope)).toContain(declared?.scope)
    expect(manifest.secrets.map((s) => s.name)).not.toContain("CLOUDFLARE_ANALYTICS_TOKEN")
  })

  it("self-hosted, keeps GraphQL and the lookup on Cloudflare with the pasted token", async () => {
    await receivingDomain()
    await runtimeFor(selfHosted).runPromise(upstreamRejections(["2026-10-18"], Date.UTC(2026, 9, 18, 12)))
    const graphql = calls.filter((c) => c.path === "/graphql")
    expect(graphql.length).toBeGreaterThan(0)
    expect(graphql.every((c) => c.host === "direct" && c.auth === "Bearer analytics-token")).toBe(true)
    expect(calls.filter((c) => c.host === "relay")).toEqual([])
  })

  it("words the relay's refusals for a person", async () => {
    expect(relayRefusal({ errors: [{ code: 10404, message: "scope not granted" }] }, RELAY)).toContain(
      "Grant it",
    )
    expect(relayRefusal({ errors: [{ code: 10402 }] }, RELAY)).toContain("Reconnect Cloudflare")
    expect(relayRefusal({ errors: [{ code: 1000 }] }, RELAY)).toBeNull()
    // Cloudflare's own answers are never read as the relay's, whatever their code.
    expect(relayRefusal({ errors: [{ code: 10404 }] }, DIRECT_API)).toBeNull()
    expect(relayRefusalOf({ errors: [{ code: 10402, message: "x" }] }, RELAY)).toEqual({
      reason: "relay_disconnected",
      code: 10402,
    })
    answer = refuseScope
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
    expect(outcome).toMatchObject({ ok: false, status: 403, relay: SCOPE_REFUSAL })
    expect(outcome.ok ? "" : outcome.message).toContain("dns.write, which you haven't granted")
  })

  it("puts the relay's reason and scope beside the message wherever a refusal surfaces", async () => {
    answer = refuseScope
    const run = runtimeFor(platform)
    // Verified addresses.
    expect(await run.runPromise(CloudflareEmail.use((c) => c.verifiedAddresses))).toMatchObject({
      available: false,
      relay: SCOPE_REFUSAL,
    })
    // First run: the zone list.
    expect(await run.runPromise(domainCandidates())).toMatchObject({
      connected: false,
      candidates: [],
      relay: SCOPE_REFUSAL,
    })
    // DMARC: the zone lookup is refused.
    const domain = await receivingDomain()
    setDns({ [`TXT _dmarc.${domain.name}`]: ["v=DMARC1; p=none"] })
    const dmarc = await run.runPromise(
      Effect.flip(changePolicy({ domainId: domain.id, p: "reject", dryRun: false, actor: "test" })),
    )
    expect(dmarc).toMatchObject({
      _tag: "DmarcChangeRefused",
      reason: "zone_not_found",
      relay: SCOPE_REFUSAL,
    })
    // Suppression push: the list read is refused.
    const email = `relay-${uid()}@example.test`
    await env.DB.prepare(
      "insert into suppressions (email, reason, source, at, updated_at) values (?, 'manual', 'manual', ?, ?)",
    )
      .bind(email, Date.now(), Date.now())
      .run()
    const pushed = await run.runPromise(Effect.flip(pushSuppression(email, "test")))
    expect(pushed).toMatchObject({ _tag: "CloudflareUnavailable", reason: "refused", relay: SCOPE_REFUSAL })
    // Routing rejections on the overview.
    const upstream = await run.runPromise(upstreamRejections(["2026-10-18"], Date.UTC(2026, 9, 18, 12)))
    expect(upstream).toMatchObject({ connected: false, relay: SCOPE_REFUSAL })
  })
})

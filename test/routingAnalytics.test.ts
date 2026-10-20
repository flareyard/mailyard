import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import type { Env } from "../src/Bindings.ts"
import { inboundStats } from "../src/domain/overview.ts"
import { clearUpstreamCache, isRejection } from "../src/domain/routingAnalytics.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { ADMIN, call, json } from "./helpers.ts"

/**
 * HAL-3393: Email Routing's own rejections, from its GraphQL analytics. The fake answers in the shape
 * measured live on 2026-10-18 (`emailRoutingAdaptiveGroups` with `count` and `dimensions`).
 */
const uid = () => crypto.randomUUID().slice(0, 8)
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  clearUpstreamCache()
})

type Rejected = {
  total: number
  noSuchAddress: number
  dmarcFail: number | null
  authFail: number | null
  upstreamRejected: number | null
  rbl: number | null
  upstream: { connected: boolean; reason: string | null; zones: number; from: string | null }
}

const receivingDomain = async (zoneId: string | null) => {
  const id = `dom_ra_${uid()}`
  await env.DB.prepare(
    "insert into domains (id, name, zone_id, routing_enabled, sending_enabled, created_at, updated_at) values (?, ?, ?, 1, 0, ?, ?)",
  )
    .bind(id, `ra-${uid()}.test`, zoneId, Date.now(), Date.now())
    .run()
  return id
}

describe("Email Routing's rejections in the inbound stats (HAL-3393)", () => {
  it("stays null without a token, and says why", async () => {
    const stats = await json<{ rejected: Rejected }>(await call("/v1/stats/inbound?range=7d", { key: ADMIN }))
    expect(stats.rejected).toMatchObject({
      dmarcFail: null,
      authFail: null,
      upstreamRejected: null,
      rbl: null,
      upstream: { connected: false, zones: 0 },
    })
    expect(stats.rejected.upstream.reason).toContain("CLOUDFLARE_ANALYTICS_TOKEN")
  })

  it("adds up rejections per zone, DMARC failures apart, with a token", async () => {
    const zone = `zone_${uid()}`
    await receivingDomain(zone)
    const asked: Array<{ zone: string; from: string; to: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url !== "https://api.cloudflare.com/client/v4/graphql") return realFetch(input, init)
      expect(request.headers.get("authorization")).toBe("Bearer analytics-token")
      const body = (await request.json()) as { variables: { zone: string; from: string; to: string } }
      asked.push(body.variables)
      if (body.variables.zone !== zone)
        return Response.json({
          data: { viewer: { zones: [{ emailRoutingAdaptiveGroups: [] }] } },
          errors: null,
        })
      return Response.json({
        data: {
          viewer: {
            zones: [
              {
                emailRoutingAdaptiveGroups: [
                  { count: 17, dimensions: { status: "dropped", dmarc: "pass", spf: "pass" } },
                  { count: 1, dimensions: { status: "deliveryFailed", dmarc: "none", spf: "pass" } },
                  { count: 6, dimensions: { status: "rejected", dmarc: "fail", spf: "fail" } },
                  { count: 2, dimensions: { status: "rejected", dmarc: "none", spf: "fail" } },
                ],
              },
            ],
          },
        },
        errors: null,
      })
    }) as typeof fetch
    const bindings = { ...env, CLOUDFLARE_ANALYTICS_TOKEN: "analytics-token" } as Env
    const stats = await runtimeFor(bindings).runPromise(inboundStats("7d"))
    expect(stats.rejected).toMatchObject({ dmarcFail: 6, authFail: 2, upstreamRejected: 8, rbl: null })
    expect(stats.rejected.upstream).toMatchObject({ connected: true, reason: null })
    expect(stats.rejected.upstream.zones).toBeGreaterThanOrEqual(1)
    expect(asked.find((a) => a.zone === zone)?.from).toBe(stats.days[0]?.day)
  })

  it("starts 90-day ranges at Cloudflare's 31 days, and reports a failing token", async () => {
    await receivingDomain(`zone_${uid()}`)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url !== "https://api.cloudflare.com/client/v4/graphql") return realFetch(input, init)
      return Response.json({ data: null, errors: [{ message: "not authorized for that zone" }] })
    }) as typeof fetch
    const bindings = { ...env, CLOUDFLARE_ANALYTICS_TOKEN: "analytics-token" } as Env
    const stats = await runtimeFor(bindings).runPromise(inboundStats("90d"))
    expect(stats.rejected).toMatchObject({ dmarcFail: null, upstream: { connected: false } })
    expect(stats.rejected.upstream.reason).toContain("not authorized")
  })

  it("counts any status that names a rejection", () => {
    expect(isRejection("rejected")).toBe(true)
    expect(isRejection("Rejected")).toBe(true)
    expect(isRejection("dropped")).toBe(false)
    expect(isRejection(undefined)).toBe(false)
  })
})

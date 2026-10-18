/**
 * Every query the Overview makes, as query options so panels that read the same endpoint share one request and
 * one cache entry. Each path and parameter here is checked against src/api/schema.d.ts by the compiler.
 */
import { queryOptions } from "@tanstack/react-query"
import { api, type paths, unwrap } from "../api/client.ts"
import type { Range } from "./logic.ts"

export { usageQuery } from "../shell/QuotaMeter.tsx"

export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: () => unwrap(api.GET("/v1/health")),
})

export const domainsQuery = queryOptions({
  queryKey: ["domains"],
  queryFn: () => unwrap(api.GET("/v1/domains")),
})

export const domainQuery = (id: string) =>
  queryOptions({
    queryKey: ["domains", id],
    queryFn: () => unwrap(api.GET("/v1/domains/{id}", { params: { path: { id } } })),
  })

export const sendingEventsQuery = queryOptions({
  queryKey: ["sending", "events"],
  queryFn: () => unwrap(api.GET("/v1/sending/events")),
})

export const reputationQuery = queryOptions({
  queryKey: ["reputation"],
  queryFn: () => unwrap(api.GET("/v1/reputation")),
})

export const attentionQuery = queryOptions({
  queryKey: ["mail", "attention"],
  queryFn: () => unwrap(api.GET("/v1/mail/attention")),
})

export const deliveryQuery = (range: Range) =>
  queryOptions({
    queryKey: ["stats", "delivery", range],
    queryFn: () => unwrap(api.GET("/v1/stats/delivery", { params: { query: { range } } })),
  })

/** 24 h draws hourly bars (`by=hour`); 7 d and 30 d draw daily ones. */
export const volumeQuery = (range: Range) => {
  const by = range === "24h" ? ("hour" as const) : ("day" as const)
  return queryOptions({
    queryKey: ["stats", "volume", range, by],
    queryFn: () => unwrap(api.GET("/v1/stats/volume", { params: { query: { range, by } } })),
  })
}

export const inboundQuery = (range: Range) =>
  queryOptions({
    queryKey: ["stats", "inbound", range],
    queryFn: () => unwrap(api.GET("/v1/stats/inbound", { params: { query: { range } } })),
  })

export const audienceQuery = (range: Range) =>
  queryOptions({
    queryKey: ["stats", "audience", range],
    queryFn: () => unwrap(api.GET("/v1/stats/audience", { params: { query: { range } } })),
  })

export const activeCampaignsQuery = queryOptions({
  queryKey: ["campaigns", "list", "active"],
  queryFn: () => unwrap(api.GET("/v1/campaigns", { params: { query: { status: "active" } } })),
})

export const paceQuery = (id: string) =>
  queryOptions({
    queryKey: ["campaigns", id, "pace"],
    queryFn: () => unwrap(api.GET("/v1/campaigns/{id}/pace", { params: { path: { id } } })),
  })

export const automationsSummaryQuery = queryOptions({
  queryKey: ["automations", "summary"],
  queryFn: () => unwrap(api.GET("/v1/automations/summary")),
})

/** The table's per-automation counts; the API offers 24h, 7d and 30d, and the design reads the last 24 hours. */
export const automations24hQuery = queryOptions({
  queryKey: ["automations", "list", "24h"],
  queryFn: () => unwrap(api.GET("/v1/automations", { params: { query: { range: "24h" } } })),
})

export const activityQuery = queryOptions({
  queryKey: ["activity", "latest"],
  queryFn: () => unwrap(api.GET("/v1/activity", { params: { query: { limit: "8" } } })),
})

/** The 200 body of a GET path, straight from the generated OpenAPI types. */
export type Ok<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer R } } } }
}
  ? R
  : never

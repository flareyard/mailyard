/**
 * Analytics' queries. Keys never collide with the Overview's (it reads delivery without `by`), and every path
 * and parameter is checked against src/api/schema.d.ts by the compiler.
 */
import { queryOptions } from "@tanstack/react-query"
import { api, type paths, unwrap } from "../api/client.ts"
import { type Range, short } from "./logic.ts"

type R30 = "24h" | "7d" | "30d"

/** Totals, rates, delivery time and, past 24 hours, rates by day (`by=day`). */
export const deliveryQuery = (range: Range) => {
  const r = short(range)
  const query: { range: R30; by?: "day" } = r === "24h" ? { range: r } : { range: r, by: "day" }
  return queryOptions({
    queryKey: ["stats", "delivery", r, query.by ?? "-"],
    queryFn: () => unwrap(api.GET("/v1/stats/delivery", { params: { query } })),
  })
}

/** 24 hourly bars for 24h (`by=hour`), daily bars otherwise. */
export const volumeQuery = (range: Range) => {
  const r = short(range)
  const by = r === "24h" ? ("hour" as const) : ("day" as const)
  return queryOptions({
    queryKey: ["stats", "volume", r, by],
    queryFn: () => unwrap(api.GET("/v1/stats/volume", { params: { query: { range: r, by } } })),
  })
}

export const deferralsQuery = (range: Range) =>
  queryOptions({
    queryKey: ["stats", "deferrals", short(range)],
    queryFn: () => unwrap(api.GET("/v1/stats/deferrals", { params: { query: { range: short(range) } } })),
  })

export const providersQuery = (range: Range) =>
  queryOptions({
    queryKey: ["stats", "providers", short(range)],
    queryFn: () => unwrap(api.GET("/v1/stats/providers", { params: { query: { range: short(range) } } })),
  })

export const engagementQuery = (range: Range) =>
  queryOptions({
    queryKey: ["stats", "engagement", short(range)],
    queryFn: () => unwrap(api.GET("/v1/stats/engagement", { params: { query: { range: short(range) } } })),
  })

export const inboundQuery = (range: Range) =>
  queryOptions({
    queryKey: ["stats", "inbound", range],
    queryFn: () => unwrap(api.GET("/v1/stats/inbound", { params: { query: { range } } })),
  })

export const responseTimesQuery = (range: Range) =>
  queryOptions({
    queryKey: ["stats", "response-times", range],
    queryFn: () => unwrap(api.GET("/v1/stats/response-times", { params: { query: { range } } })),
  })

export const audienceQuery = (range: Range) =>
  queryOptions({
    queryKey: ["stats", "audience", range],
    queryFn: () => unwrap(api.GET("/v1/stats/audience", { params: { query: { range } } })),
  })

export const topicsQuery = queryOptions({
  queryKey: ["topics"],
  queryFn: () => unwrap(api.GET("/v1/topics")),
})

export const reputationQuery = queryOptions({
  queryKey: ["reputation"],
  queryFn: () => unwrap(api.GET("/v1/reputation")),
})

export const usageQuery = queryOptions({
  queryKey: ["usage"],
  queryFn: () => unwrap(api.GET("/v1/usage")),
})

export const storageQuery = queryOptions({
  queryKey: ["usage", "storage"],
  queryFn: () => unwrap(api.GET("/v1/usage/storage")),
})

export const forecastQuery = (recipients: number) =>
  queryOptions({
    queryKey: ["usage", "forecast", recipients],
    queryFn: () =>
      unwrap(api.GET("/v1/usage/forecast", { params: { query: { recipients: String(recipients) } } })),
  })

/** The 200 body of a GET path, straight from the generated OpenAPI types. */
export type Ok<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer R } } } }
}
  ? R
  : never

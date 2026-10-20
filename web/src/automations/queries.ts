/**
 * Automation reads, typed from the OpenAPI (HAL-3299). There's no workspace socket (HAL-3364), so the canvas
 * polls the automation every 30 s while it's open and again on focus, which refreshes the node counts.
 */
import { queryOptions } from "@tanstack/react-query"
import { api, unwrap } from "../api/client.ts"
import { arr } from "../audience/kit/queries.ts"
import type { Run } from "./logic.ts"

export type Range = "24h" | "7d" | "30d"
export const RANGES: readonly Range[] = ["24h", "7d", "30d"]
export const RANGE_WORDS: Record<Range, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" }
export const RANGE_SHORT: Record<Range, string> = { "24h": "24 h", "7d": "7 d", "30d": "30 d" }

export const automationsQuery = (range: Range) =>
  queryOptions({
    queryKey: ["automations", { range }],
    queryFn: () => unwrap(api.GET("/v1/automations", { params: { query: { range } } })),
  })

export const automationsSummaryQuery = queryOptions({
  queryKey: ["automations", "summary"],
  queryFn: () => unwrap(api.GET("/v1/automations/summary")),
  staleTime: 30_000,
})

export const automationQuery = (id: string) =>
  queryOptions({
    queryKey: ["automations", id],
    queryFn: () => unwrap(api.GET("/v1/automations/{id}", { params: { path: { id } } })),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

export const versionsQuery = (id: string) =>
  queryOptions({
    queryKey: ["automations", id, "versions"],
    queryFn: () => unwrap(api.GET("/v1/automations/{id}/versions", { params: { path: { id } } })),
  })

export type RunsFilter = { status?: Run["status"]; version?: string; cursor?: string }

export const runsQuery = (id: string, f: RunsFilter) =>
  queryOptions({
    queryKey: ["automations", id, "runs", f],
    queryFn: async () => {
      const r = await unwrap(
        api.GET("/v1/automations/{id}/runs", {
          params: {
            path: { id },
            query: {
              ...(f.status ? { status: f.status } : {}),
              ...(f.version ? { version: f.version } : {}),
              ...(f.cursor ? { cursor: f.cursor } : {}),
              limit: "50",
            },
          },
        }),
      )
      return { runs: arr<Run>(r?.runs), total: r?.total ?? 0, nextCursor: r?.nextCursor ?? null }
    },
  })

export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ["runs", id],
    queryFn: () => unwrap(api.GET("/v1/runs/{id}", { params: { path: { id } } })),
  })

export const templateQuery = (id: string) =>
  queryOptions({
    queryKey: ["templates", id],
    queryFn: () => unwrap(api.GET("/v1/templates/{id}", { params: { path: { id } } })),
    staleTime: 60_000,
  })

/** Contacts for the dry run's "Test with" picker: a search over the contact list. */
export const contactPickQuery = (q: string) =>
  queryOptions({
    queryKey: ["contacts", "pick", q],
    queryFn: async () => {
      const r = await unwrap(
        api.GET("/v1/contacts", {
          params: { query: { limit: "8", sort: "-lastActivityAt", ...(q ? { q } : {}) } },
        }),
      )
      return arr<{ id: string; email: string; name: string | null }>(r?.contacts)
    },
    staleTime: 30_000,
  })

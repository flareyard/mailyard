/**
 * Contacts' reads and writes, typed from the OpenAPI. Every key starts with `["contacts"]`, so any write
 * invalidates the list, the tab count and the open contact together.
 */
import { keepPreviousData, queryOptions } from "@tanstack/react-query"
import { api, unwrap } from "../../api/client.ts"
import type { Json } from "../kit/queries.ts"
import { apiQuery, type ContactsSearch } from "./logic.ts"

export type ContactsPage = Json<"/v1/contacts", "get">
export type ContactRow = ContactsPage["contacts"][number]
export type Contact = Json<"/v1/contacts/{id}", "get">
export type Timeline = Json<"/v1/contacts/{id}/timeline", "get">
export type TimelineItem = Timeline["items"][number]
export type BulkAnswer = Json<"/v1/contacts/bulk", "post">
export type BulkJob = Json<"/v1/contacts/bulk/{id}", "get">
export type ExportItem = Json<"/v1/exports/{id}", "get">

export const PAGE_SIZE = 50

export const contactsQuery = (s: ContactsSearch) =>
  queryOptions({
    queryKey: ["contacts", "list", apiQuery(s)],
    queryFn: () =>
      unwrap(api.GET("/v1/contacts", { params: { query: { ...apiQuery(s), limit: String(PAGE_SIZE) } } })),
    placeholderData: keepPreviousData,
    retry: (n, e) =>
      !(e && typeof e === "object" && "status" in e && (e as { status: number }).status === 400) && n < 2,
  })

/** How many contacts carry each status, for the multi-select's counts (one cheap `limit=1` read each). */
export const statusCountQuery = (status: string) =>
  queryOptions({
    queryKey: ["contacts", "count", "status", status],
    queryFn: () => unwrap(api.GET("/v1/contacts", { params: { query: { status, limit: "1" } } })),
    select: (r) => r?.total ?? null,
    staleTime: 60_000,
  })

export const contactQuery = (id: string) =>
  queryOptions({
    queryKey: ["contacts", "one", id],
    queryFn: () => unwrap(api.GET("/v1/contacts/{id}", { params: { path: { id } } })),
  })

export const timelineQuery = (id: string, kind?: string) =>
  queryOptions({
    queryKey: ["contacts", "one", id, "timeline", kind ?? "all"],
    queryFn: () =>
      unwrap(
        api.GET("/v1/contacts/{id}/timeline", {
          params: { path: { id }, query: { ...(kind ? { kind } : {}), limit: "50" } as never },
        }),
      ),
  })

export const prefsLinkQuery = (id: string) =>
  queryOptions({
    queryKey: ["contacts", "one", id, "preferences-link"],
    queryFn: () => unwrap(api.GET("/v1/contacts/{id}/preferences-link", { params: { path: { id } } })),
    staleTime: 10 * 60_000,
    retry: false,
  })

export const bulkJobQuery = (id: string) =>
  queryOptions({
    queryKey: ["contacts", "bulk", id],
    queryFn: () => unwrap(api.GET("/v1/contacts/bulk/{id}", { params: { path: { id } } })),
  })

export const exportsQuery = queryOptions({
  queryKey: ["exports"],
  queryFn: () => unwrap(api.GET("/v1/exports")),
  select: (r) => r?.exports ?? [],
  staleTime: 15_000,
})

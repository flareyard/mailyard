/**
 * Every query Transactional's messages, templates and quick start make, as query options so screens that read
 * the same endpoint share one request. Paths and parameters are checked against schema.d.ts by the compiler.
 */
import { queryOptions, useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { api, type paths, unwrap } from "../api/client.ts"
import { type LogSearch, logQuery } from "./logic.ts"

/** The 200 body of a GET path. */
export type Ok<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer R } } } }
}
  ? R
  : never

export type MessageRow = Ok<"/v1/messages">["messages"][number]
export type MessageDetail = Ok<"/v1/messages/{id}">
export type TemplateRow = Ok<"/v1/templates">["templates"][number]
export type TemplateDetail = Ok<"/v1/templates/{id}">

export const messagesQuery = (s: LogSearch) =>
  queryOptions({
    queryKey: ["messages", "list", logQuery(s)],
    queryFn: () => unwrap(api.GET("/v1/messages", { params: { query: logQuery(s) } })),
    // The first page is live: new sends appear without a reload. Older pages don't move.
    refetchInterval: s.cursor ? false : 15_000,
  })

export const messageQuery = (id: string) =>
  queryOptions({
    queryKey: ["messages", id],
    queryFn: () => unwrap(api.GET("/v1/messages/{id}", { params: { path: { id } } })),
  })

export const rawQuery = (id: string) =>
  queryOptions({
    queryKey: ["messages", id, "raw"],
    queryFn: async (): Promise<string> => {
      const { data } = await api.GET("/v1/messages/{id}/raw", { params: { path: { id } }, parseAs: "text" })
      const text = String(data ?? "")
      // Fixture mode answers with JSON; the live API with message/rfc822.
      return text.startsWith('"') ? (JSON.parse(text) as string) : text
    },
    staleTime: Number.POSITIVE_INFINITY,
  })

export const templatesQuery = (archived = false) =>
  queryOptions({
    queryKey: ["templates", "list", { archived }],
    queryFn: () =>
      unwrap(
        api.GET("/v1/templates", {
          params: { query: { include: "usage", ...(archived ? { archived: "true" as const } : {}) } },
        }),
      ),
  })

export const templateQuery = (id: string) =>
  queryOptions({
    queryKey: ["templates", id],
    queryFn: () => unwrap(api.GET("/v1/templates/{id}", { params: { path: { id } } })),
  })

export const keysQuery = queryOptions({
  queryKey: ["api-keys", "names"],
  queryFn: () => unwrap(api.GET("/v1/api-keys")),
  staleTime: 60_000,
  retry: false,
})

export const campaignsQuery = queryOptions({
  queryKey: ["campaigns", "list", "names"],
  queryFn: () => unwrap(api.GET("/v1/campaigns", { params: { query: { limit: "100" } } })),
  staleTime: 60_000,
  retry: false,
})

export const webhooksQuery = queryOptions({
  queryKey: ["webhooks", "tab-count"],
  queryFn: () => unwrap(api.GET("/v1/webhooks")),
  staleTime: 30_000,
  retry: false,
})

export const domainsQuery = queryOptions({
  queryKey: ["domains"],
  queryFn: () => unwrap(api.GET("/v1/domains")),
})

/** Key id → name and prefix, for "Sent by" and "saved by". Empty when the caller can't list keys. */
export function useKeyNames() {
  const q = useQuery(keysQuery)
  return useMemo(
    () => new Map((q.data?.keys ?? []).map((k) => [k.id, { name: k.name, prefix: k.prefix }])),
    [q.data],
  )
}

export function useCampaignNames() {
  const q = useQuery(campaignsQuery)
  return useMemo(() => new Map((q.data?.campaigns ?? []).map((c) => [c.id, c.name])), [q.data])
}

/** Template id → name, for the log's template column and the filter. */
export function useTemplateNames() {
  const q = useQuery(templatesQuery())
  return useMemo(() => new Map((q.data?.templates ?? []).map((t) => [t.id, t.name])), [q.data])
}

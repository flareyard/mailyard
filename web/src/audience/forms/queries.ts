/** Form reads: the list, one form, its stats, its embed snippets and the brand its hosted page wears. */
import { queryOptions } from "@tanstack/react-query"
import { api, unwrap } from "../../api/client.ts"
import { arr, type Json } from "../kit/queries.ts"

export type Form = Json<"/v1/forms/{id}", "get">
export type FormStats = Json<"/v1/forms/{id}/stats", "get">
export type Range = "7d" | "30d" | "90d"

export const formsQuery = queryOptions({
  queryKey: ["forms"],
  queryFn: () => unwrap(api.GET("/v1/forms")),
  select: (r) => arr<Form>(r?.forms),
  staleTime: 30_000,
})

export const formQuery = (id: string) =>
  queryOptions({
    queryKey: ["forms", id],
    queryFn: () => unwrap(api.GET("/v1/forms/{id}", { params: { path: { id } } })),
  })

export const formStatsQuery = (id: string, range: Range) =>
  queryOptions({
    queryKey: ["forms", id, "stats", range],
    queryFn: () => unwrap(api.GET("/v1/forms/{id}/stats", { params: { path: { id }, query: { range } } })),
    staleTime: 60_000,
  })

export const formEmbedQuery = (id: string) =>
  queryOptions({
    queryKey: ["forms", id, "embed"],
    queryFn: () => unwrap(api.GET("/v1/forms/{id}/embed", { params: { path: { id } } })),
  })

export const brandQuery = queryOptions({
  queryKey: ["settings", "brand"],
  queryFn: () => unwrap(api.GET("/v1/settings/brand")),
  staleTime: 5 * 60_000,
  retry: false,
})

/** Segment reads: one segment, the live preview, and the campaign names the rule tree picks from. */
import { queryOptions } from "@tanstack/react-query"
import { api, unwrap } from "../../api/client.ts"
import { arr, type Json } from "../kit/queries.ts"
import type { Rule } from "./logic.ts"

export type SegmentFull = Json<"/v1/segments/{id}", "get">
export type Preview = Json<"/v1/segments/preview", "post">

export const segmentQuery = (id: string) =>
  queryOptions({
    queryKey: ["segments", id],
    queryFn: () => unwrap(api.GET("/v1/segments/{id}", { params: { path: { id } } })),
  })

/** `POST /v1/segments/preview` for a tree; the key is the tree itself, so an unchanged tree isn't re-counted. */
export const previewQuery = (filter: Rule) =>
  queryOptions({
    queryKey: ["segments", "preview", JSON.stringify(filter)],
    queryFn: () => unwrap(api.POST("/v1/segments/preview", { body: { filter } })),
    staleTime: 30_000,
    retry: false,
  })

export const campaignNamesQuery = queryOptions({
  queryKey: ["campaigns", "names"],
  queryFn: async () =>
    arr<{ id: string; name: string }>((await unwrap(api.GET("/v1/campaigns")))?.campaigns).map((c) => ({
      id: c.id,
      name: c.name,
    })),
  staleTime: 60_000,
})

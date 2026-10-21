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

/**
 * Whether the assistant may turn a sentence into rules: a provider is configured (`available`) and an owner
 * turned segments on (`segments`). Settings → AI changes it, so it's re-read when the builder opens.
 */
export const assistantQuery = queryOptions({
  queryKey: ["settings", "assistant"],
  queryFn: () => unwrap(api.GET("/v1/settings/assistant")),
  staleTime: 60_000,
  retry: false,
})

export type FromText = Json<"/v1/segments/from-text", "post">

export const campaignNamesQuery = queryOptions({
  queryKey: ["campaigns", "names"],
  queryFn: () => unwrap(api.GET("/v1/campaigns")),
  select: (r) =>
    arr<{ id: string; name: string }>(r?.campaigns).map((c) => ({
      id: c.id,
      name: c.name,
    })),
  staleTime: 60_000,
})

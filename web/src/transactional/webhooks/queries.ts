/** Webhook queries and URL state: the deliveries filter, the cursor, the open delivery and sheet. */
import { queryOptions } from "@tanstack/react-query"
import { api, unwrap } from "../../api/client.ts"
import { fixtureParams } from "../keys/queries.ts"

export const hooksQuery = queryOptions({
  queryKey: ["webhooks", "list"],
  queryFn: () => unwrap(api.GET("/v1/webhooks")),
})

export const hookQuery = (id: string) =>
  queryOptions({
    queryKey: ["webhooks", id],
    queryFn: () => unwrap(api.GET("/v1/webhooks/{id}", { params: { path: { id } } })),
  })

export type DeliveryFilter = "pending" | "succeeded" | "retrying" | "dead" | "paused"

export const deliveriesQuery = (id: string, status?: DeliveryFilter, cursor?: string) =>
  queryOptions({
    queryKey: ["webhooks", id, "deliveries", status ?? "all", cursor ?? ""],
    queryFn: () =>
      unwrap(
        api.GET("/v1/webhooks/{id}/deliveries", {
          params: {
            path: { id },
            query: { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: "50" },
          },
        }),
      ),
  })

export type HooksSearch = { sheet?: "create"; state?: string; as?: string }
export function validateHooksSearch(s: Record<string, unknown>): HooksSearch {
  return { ...(s.sheet === "create" ? { sheet: "create" as const } : {}), ...fixtureParams(s) }
}

export type HookSearch = {
  status?: DeliveryFilter
  cursor?: string
  delivery?: string
  sheet?: "rotate" | "test" | "replay" | "edit" | "remove"
  state?: string
  as?: string
}
const SHEETS = ["rotate", "test", "replay", "edit", "remove"] as const
const isSheet = (v: unknown): v is (typeof SHEETS)[number] => (SHEETS as readonly unknown[]).includes(v)
export function validateHookSearch(s: Record<string, unknown>): HookSearch {
  const status = s.status
  return {
    ...(status === "pending" ||
    status === "succeeded" ||
    status === "retrying" ||
    status === "dead" ||
    status === "paused"
      ? { status }
      : {}),
    ...(typeof s.cursor === "string" && s.cursor ? { cursor: s.cursor } : {}),
    ...(typeof s.delivery === "string" && /^[A-Za-z0-9_]{3,64}$/.test(s.delivery)
      ? { delivery: s.delivery }
      : {}),
    ...(isSheet(s.sheet) ? { sheet: s.sheet } : {}),
    ...fixtureParams(s),
  }
}

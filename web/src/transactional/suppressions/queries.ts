/** Suppression queries and URL state. Filters, the cursor and the open sheet are all in the URL. */
import { queryOptions } from "@tanstack/react-query"
import { api, unwrap } from "../../api/client.ts"
import { fixturesEnabled } from "../../fixtures/mode.ts"
import { fixtureParams } from "../keys/queries.ts"
import { type Filters, parseFilters } from "./logic.ts"

export const supsQuery = (f: Filters) =>
  queryOptions({
    queryKey: [
      "suppressions",
      "list",
      f.reason ?? "",
      f.source ?? "",
      f.cloudflare ?? "",
      f.q ?? "",
      f.cursor ?? "",
    ],
    queryFn: () =>
      unwrap(
        api.GET("/v1/suppressions", {
          params: {
            query: {
              ...(f.reason ? { reason: f.reason } : {}),
              ...(f.source ? { source: f.source } : {}),
              ...(f.cloudflare ? { cloudflare: f.cloudflare } : {}),
              ...(f.q ? { q: f.q } : {}),
              ...(f.cursor ? { cursor: f.cursor } : {}),
              limit: "50",
            },
          },
        }),
      ),
  })

export const supQuery = (email: string) =>
  queryOptions({
    queryKey: ["suppressions", "one", email],
    queryFn: () => unwrap(api.GET("/v1/suppressions/{email}", { params: { path: { email } } })),
    retry: (n, e) =>
      !(e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) && n < 2,
  })

export const importQuery = (id: string) =>
  queryOptions({
    queryKey: ["suppressions", "import", id],
    queryFn: () => unwrap(api.GET("/v1/suppressions/imports/{id}", { params: { path: { id } } })),
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === "completed" || s === "failed" ? false : 1500
    },
  })

export const importsQuery = queryOptions({
  queryKey: ["suppressions", "imports"],
  queryFn: () => unwrap(api.GET("/v1/suppressions/imports", { params: { query: { limit: "5" } } })),
})

export type SupsSearch = Filters & { sheet?: "add"; state?: string; as?: string }
export function validateSupsSearch(s: Record<string, unknown>): SupsSearch {
  return { ...parseFilters(s), ...(s.sheet === "add" ? { sheet: "add" as const } : {}), ...fixtureParams(s) }
}

export type SupSearch = { sheet?: "edit" | "remove"; push?: string; state?: string; as?: string }
export function validateSupSearch(s: Record<string, unknown>): SupSearch {
  return {
    ...(s.sheet === "edit" || s.sheet === "remove" ? { sheet: s.sheet } : {}),
    ...fixtureParams(s),
    // Fixture mode only: picks which refusal the push answers with (suppression-push-errors).
    ...(fixturesEnabled() && typeof s.push === "string" ? { push: s.push } : {}),
  }
}

export type ImportSearch = { id?: string; state?: string; as?: string }
export function validateImportSearch(s: Record<string, unknown>): ImportSearch {
  return {
    ...(typeof s.id === "string" && /^[A-Za-z0-9_]{3,64}$/.test(s.id) ? { id: s.id } : {}),
    ...fixtureParams(s),
  }
}

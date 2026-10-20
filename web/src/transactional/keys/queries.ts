/**
 * Queries and URL state for API keys. Every list is a URL: `?purpose=` filters, and the open sheet is in the
 * search too (`?sheet=create`, `?rotate=key_…`, `?revoke=key_…`, `?limits=key_…`), so a sheet can be linked.
 */
import { queryOptions } from "@tanstack/react-query"
import { api, unwrap } from "../../api/client.ts"
import { fixturesEnabled } from "../../fixtures/mode.ts"

export type Purpose = "api" | "mcp"

export const keysQuery = (purpose?: Purpose) =>
  queryOptions({
    queryKey: ["api-keys", "list", purpose ?? "all", "usage"],
    queryFn: () =>
      unwrap(
        api.GET("/v1/api-keys", { params: { query: { include: "usage", ...(purpose ? { purpose } : {}) } } }),
      ),
  })

/** Counts for the All / api / mcp control come from the unfiltered list. */
export const allKeysQuery = keysQuery()

export const limitsQuery = (id: string) =>
  queryOptions({
    queryKey: ["api-keys", id, "limits"],
    queryFn: () => unwrap(api.GET("/v1/api-keys/{id}/limits", { params: { path: { id } } })),
  })

/** Fixture-only page parameters that pick a designed state; kept through navigation in fixture mode. */
export function fixtureParams(s: Record<string, unknown>): { state?: string; as?: string } {
  if (!fixturesEnabled()) return {}
  return {
    ...(typeof s.state === "string" ? { state: s.state } : {}),
    ...(typeof s.as === "string" ? { as: s.as } : {}),
  }
}

export type KeysSearch = {
  purpose?: Purpose
  sheet?: "create"
  rotate?: string
  revoke?: string
  limits?: string
  state?: string
  as?: string
}

const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_]{3,64}$/.test(v) ? v : undefined)

export function validateKeysSearch(s: Record<string, unknown>): KeysSearch {
  const rotate = id(s.rotate)
  const revoke = id(s.revoke)
  const limits = id(s.limits)
  return {
    ...(s.purpose === "api" || s.purpose === "mcp" ? { purpose: s.purpose } : {}),
    ...(s.sheet === "create" ? { sheet: "create" as const } : {}),
    ...(rotate ? { rotate } : {}),
    ...(revoke ? { revoke } : {}),
    ...(limits ? { limits } : {}),
    ...fixtureParams(s),
  }
}

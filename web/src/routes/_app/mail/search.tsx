import { createFileRoute } from "@tanstack/react-router"
import { SearchAll } from "../../../mail/search/SearchAll.tsx"
import type { SearchSort } from "../../../mail/types.ts"

export type SearchAllSearch = { q?: string; sort?: SearchSort }

/** `/mail/search?q=&sort=`: one search across every mailbox you can read (GET /v1/search/mail, HAL-3363). */
export const Route = createFileRoute("/_app/mail/search")({
  staticData: { title: "Search mail" },
  validateSearch: (s: Record<string, unknown>): SearchAllSearch => ({
    ...(typeof s.q === "string" && s.q.trim() ? { q: s.q } : {}),
    ...(s.sort === "relevance" ? { sort: "relevance" as const } : {}),
  }),
  component: SearchAll,
})

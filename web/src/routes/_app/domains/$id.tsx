import { createFileRoute } from "@tanstack/react-router"
import { DomainDetail } from "../../../domains/DomainDetail.tsx"

export type DomainSheet = "fix" | "disable"
export type DomainSearch = {
  /** An open sheet: `disable` (turn sending off) or `fix` (the fix results). */
  sheet?: DomainSheet
}

export const Route = createFileRoute("/_app/domains/$id")({
  staticData: { title: "Domain" },
  validateSearch: (s: Record<string, unknown>): DomainSearch =>
    s.sheet === "fix" || s.sheet === "disable" ? { sheet: s.sheet } : {},
  component: DomainDetail,
})

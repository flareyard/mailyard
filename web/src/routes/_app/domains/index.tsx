import { createFileRoute } from "@tanstack/react-router"
import { DomainList } from "../../../domains/DomainList.tsx"

export type DomainsSearch = {
  /** `?add=1` opens Add a domain. */
  add?: 1
}

export const Route = createFileRoute("/_app/domains/")({
  staticData: { title: "Domains" },
  validateSearch: (s: Record<string, unknown>): DomainsSearch =>
    s.add === 1 || s.add === "1" || s.add === true ? { add: 1 } : {},
  component: DomainList,
})

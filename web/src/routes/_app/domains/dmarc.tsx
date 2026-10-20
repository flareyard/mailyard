import { createFileRoute } from "@tanstack/react-router"
import { DmarcPage } from "../../../domains/Dmarc.tsx"

export type DmarcSearch = { domain?: string; range?: "7d" | "90d" }

export const Route = createFileRoute("/_app/domains/dmarc")({
  staticData: { title: "DMARC reports" },
  validateSearch: (s: Record<string, unknown>): DmarcSearch => ({
    ...(typeof s.domain === "string" && s.domain ? { domain: s.domain } : {}),
    ...(s.range === "7d" || s.range === "90d" ? { range: s.range } : {}),
  }),
  component: DmarcPage,
})

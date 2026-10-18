import { createFileRoute } from "@tanstack/react-router"
import { AnalyticsLayout } from "../../analytics/Layout.tsx"
import { parseSearch } from "../../analytics/logic.ts"
import { fixturesEnabled } from "../../fixtures/mode.ts"

/** Analytics (HAL-3309): every role, read-only. The range and the export sheet live in the URL. */
export const Route = createFileRoute("/_app/analytics")({
  staticData: { title: "Analytics" },
  validateSearch: (s: Record<string, unknown>) => parseSearch(s, fixturesEnabled()),
  component: AnalyticsLayout,
})

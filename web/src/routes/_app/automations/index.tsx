import { createFileRoute } from "@tanstack/react-router"
import { AutomationsList } from "../../../automations/List.tsx"
import type { Range } from "../../../automations/queries.ts"

export type AutomationsSearch = { range?: Range }

export const Route = createFileRoute("/_app/automations/")({
  staticData: { title: "Automations" },
  // 7d is the default and stays out of the URL.
  validateSearch: (s: Record<string, unknown>): AutomationsSearch =>
    s.range === "24h" || s.range === "30d" ? { range: s.range } : {},
  component: () => <AutomationsList range={Route.useSearch().range ?? "7d"} />,
})

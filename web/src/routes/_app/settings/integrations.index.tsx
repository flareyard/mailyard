import { createFileRoute, redirect } from "@tanstack/react-router"
import { Integrations } from "../../../settings/integrations/Integrations.tsx"
import { validateIntegrations } from "../../../settings/integrations/search.ts"

export const Route = createFileRoute("/_app/settings/integrations/")({
  staticData: { title: "Integrations" },
  validateSearch: validateIntegrations,
  // Creating an agent moved to the Agents section (2026-10-21).
  beforeLoad: ({ search }) => {
    if (search.sheet === "agent-new")
      throw redirect({ to: "/agents", search: { sheet: "agent-new" }, replace: true })
  },
  component: Integrations,
})

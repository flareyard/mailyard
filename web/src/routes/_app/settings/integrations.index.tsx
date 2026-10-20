import { createFileRoute } from "@tanstack/react-router"
import { Integrations } from "../../../settings/integrations/Integrations.tsx"
import { validateIntegrations } from "../../../settings/integrations/search.ts"

export const Route = createFileRoute("/_app/settings/integrations/")({
  staticData: { title: "Integrations" },
  validateSearch: validateIntegrations,
  component: Integrations,
})

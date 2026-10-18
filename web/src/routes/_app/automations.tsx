import { createFileRoute } from "@tanstack/react-router"
import { SectionPending } from "../../ui/SectionPending.tsx"

// TEMPORARY until HAL-3310 lands (see SectionPending).
export const Route = createFileRoute("/_app/automations")({
  staticData: { title: "Automations" },
  component: () => (
    <SectionPending
      title="Automations"
      issue="HAL-3310"
      icon="automations"
      what="Flows that send on triggers, with waits and branches."
    />
  ),
})

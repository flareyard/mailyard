import { createFileRoute } from "@tanstack/react-router"
import { SectionPending } from "../../ui/SectionPending.tsx"

// TEMPORARY until HAL-3309 lands (see SectionPending).
export const Route = createFileRoute("/_app/analytics")({
  staticData: { title: "Analytics" },
  component: () => (
    <SectionPending
      title="Analytics"
      issue="HAL-3309"
      icon="analytics"
      what="Volume, delivery, engagement and inbound over time."
    />
  ),
})

import { createFileRoute } from "@tanstack/react-router"
import { SectionPending } from "../../ui/SectionPending.tsx"

// TEMPORARY until HAL-3310 lands (see SectionPending).
export const Route = createFileRoute("/_app/campaigns")({
  staticData: { title: "Campaigns" },
  component: () => (
    <SectionPending
      title="Campaigns"
      issue="HAL-3310"
      icon="campaigns"
      what="Write, schedule and report on campaigns."
    />
  ),
})

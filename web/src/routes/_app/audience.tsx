import { createFileRoute } from "@tanstack/react-router"
import { SectionPending } from "../../ui/SectionPending.tsx"

// TEMPORARY until HAL-3310 lands (see SectionPending).
export const Route = createFileRoute("/_app/audience")({
  staticData: { title: "Audience" },
  component: () => (
    <SectionPending
      title="Audience"
      issue="HAL-3310"
      icon="audience"
      what="Contacts, topics, segments, forms and imports."
    />
  ),
})

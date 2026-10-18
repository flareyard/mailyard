import { createFileRoute } from "@tanstack/react-router"
import { SectionPending } from "../../ui/SectionPending.tsx"

// TEMPORARY until HAL-3309 lands (see SectionPending).
export const Route = createFileRoute("/_app/domains")({
  staticData: { title: "Domains" },
  component: () => (
    <SectionPending
      title="Domains"
      issue="HAL-3309"
      icon="domains"
      what="Sending and receiving domains, with their DNS checks."
    />
  ),
})

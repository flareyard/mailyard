import { createFileRoute } from "@tanstack/react-router"
import { SectionPending } from "../../ui/SectionPending.tsx"

// TEMPORARY until HAL-3309 lands (see SectionPending).
export const Route = createFileRoute("/_app/transactional")({
  staticData: { title: "Transactional" },
  component: () => (
    <SectionPending
      title="Transactional"
      issue="HAL-3309"
      icon="transactional"
      what="Templates, the message log, API keys and webhooks."
    />
  ),
})

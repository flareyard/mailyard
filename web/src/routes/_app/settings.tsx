import { createFileRoute } from "@tanstack/react-router"
import { SectionPending } from "../../ui/SectionPending.tsx"

// TEMPORARY until HAL-3309 lands (see SectionPending).
export const Route = createFileRoute("/_app/settings")({
  staticData: { title: "Settings" },
  component: () => (
    <SectionPending
      title="Settings"
      issue="HAL-3309"
      icon="settings"
      what="Mailboxes, people, brand, compliance and integrations."
    />
  ),
})

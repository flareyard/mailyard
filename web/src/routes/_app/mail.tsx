import { createFileRoute } from "@tanstack/react-router"
import { SectionPending } from "../../ui/SectionPending.tsx"

// TEMPORARY until HAL-3308 lands (see SectionPending).
export const Route = createFileRoute("/_app/mail")({
  staticData: { title: "Mail" },
  component: () => (
    <SectionPending
      title="Mail"
      issue="HAL-3308"
      icon="mail"
      what="Every mailbox, threads, the composer and search."
    />
  ),
})

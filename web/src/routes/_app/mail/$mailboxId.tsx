import { createFileRoute } from "@tanstack/react-router"
import { SectionPending } from "../../../ui/SectionPending.tsx"

// TEMPORARY until HAL-3308 lands (see SectionPending).
export const Route = createFileRoute("/_app/mail/$mailboxId")({
  staticData: { title: "Mail" },
  component: () => (
    <SectionPending title="Mail" issue="HAL-3308" icon="mail" what="Threads in this mailbox." />
  ),
})

import { createFileRoute } from "@tanstack/react-router"
import { MailHome } from "../../../mail/MailHome.tsx"

/** `/mail`: the default mailbox's inbox on a wide screen; on a phone, the root of the stack (its folders). */
export const Route = createFileRoute("/_app/mail/")({
  component: MailHome,
})

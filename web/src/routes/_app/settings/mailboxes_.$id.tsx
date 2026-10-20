import { createFileRoute } from "@tanstack/react-router"
import { MailboxDetail } from "../../../settings/mailboxes/MailboxDetail.tsx"

export const Route = createFileRoute("/_app/settings/mailboxes_/$id")({
  staticData: { title: "Mailbox" },
  component: function MailboxRoute() {
    const { id } = Route.useParams()
    return <MailboxDetail id={id} />
  },
})

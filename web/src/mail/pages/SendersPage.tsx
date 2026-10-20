/**
 * `/mail/$mailboxId/senders?list=allow|block|images` (senders.html): the allow and block lists on their own
 * page, and the senders whose remote images always show.
 */
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useMail } from "../context.tsx"
import { SendersPanel } from "./SendersPanel.tsx"
import { MailPage } from "./shared.tsx"

export function SendersPage() {
  const { local } = useMail()
  const search = useSearch({ from: "/_app/mail/$mailboxId/senders" })
  const navigate = useNavigate({ from: "/mail/$mailboxId/senders" })
  const list = search.list ?? "allow"
  return (
    <MailPage
      label="Senders"
      crumb={<span>Senders</span>}
      title="Senders"
      sub={`Who always reaches the Inbox, who always goes to Spam, and whose images always show in ${local}.`}
    >
      <SendersPanel
        list={list}
        titleLink={false}
        withImages
        onList={(l) =>
          navigate({ search: (p: Record<string, unknown>) => ({ ...p, list: l }) as never, replace: true })
        }
      />
    </MailPage>
  )
}

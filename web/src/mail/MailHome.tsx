/**
 * `/mail`: picks the mailbox to open (the last one you used, else the first that holds mail) and goes there.
 * On a phone it lands on that mailbox's folders, the root of the phone stack (HANDOFF-mail §3).
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { Icon } from "../ui/icons.tsx"
import { PanelError } from "../ui/Panel.tsx"
import { mailboxesQuery } from "./queries.ts"
import type { Mailbox } from "./types.ts"

const LAST = "mailyard-mailbox"

export function rememberMailbox(id: string) {
  try {
    localStorage.setItem(LAST, id)
  } catch {}
}

export function defaultMailbox(list: readonly Mailbox[] | undefined): Mailbox | undefined {
  const boxes = (list ?? []).filter((m) => m.holdsMail)
  let last: string | null = null
  try {
    last = localStorage.getItem(LAST)
  } catch {}
  return boxes.find((m) => m.id === last) ?? boxes.find((m) => m.kind === "shared") ?? boxes[0]
}

const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches

export function MailHome() {
  const boxes = useQuery(mailboxesQuery)
  const navigate = useNavigate()
  const target = defaultMailbox(boxes.data?.mailboxes)
  useEffect(() => {
    if (!target) return
    navigate({
      to: isPhone() ? "/mail/$mailboxId/folders" : "/mail/$mailboxId",
      params: { mailboxId: target.id },
      search: (prev: Record<string, unknown>) => prev as never,
      replace: true,
    })
  }, [target, navigate])

  if (boxes.isError)
    return (
      <div className="mpage">
        <div className="mpage-inner">
          <PanelError error={boxes.error} onRetry={() => boxes.refetch()} what="Your mailboxes didn’t load" />
        </div>
      </div>
    )
  if (boxes.isPending || target)
    return <div className="mail-boot" role="status" aria-busy="true" aria-label="Opening your mailbox" />
  return (
    <div className="mpage">
      <div className="mpage-inner">
        <div className="empty" style={{ marginTop: 24 }}>
          <span className="empty-icon">
            <Icon name="mailbox" />
          </span>
          <b>No mailboxes yet</b>
          <p className="t-small muted">
            A mailbox gives an address like support@ an inbox here: mail sent to it lands in Mail, and you
            reply from it. Create one, then import its old mail over IMAP if you like.
          </p>
          <div className="cluster" style={{ justifyContent: "center" }}>
            <Link className="btn btn-primary" to="/" search={{ setup: 1, step: "mailbox" }}>
              Create a mailbox
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

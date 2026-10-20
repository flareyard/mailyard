/**
 * Everything under /mail: the outlet, the composer window and Mail's toasts. `?compose=1` (the shell's
 * Compose button and C) opens the composer for the mailbox you're in, or your default one, then leaves the
 * URL so Back doesn't reopen it.
 */
import { useQuery } from "@tanstack/react-query"
import { Outlet, useNavigate, useRouterState, useSearch } from "@tanstack/react-router"
import { useEffect } from "react"
import { ComposerHost } from "./compose/ComposerHost.tsx"
import { openCompose } from "./compose/store.ts"
import { defaultMailbox } from "./MailHome.tsx"
import { mailboxesQuery } from "./queries.ts"
import { MailToasts } from "./toasts.tsx"
import "./mail.css"

export function MailRoot() {
  const search = useSearch({ strict: false }) as { compose?: 1; draft?: string }
  const params = useRouterState({ select: (s) => s.matches.at(-1)?.params as { mailboxId?: string } })
  const boxes = useQuery(mailboxesQuery)
  const navigate = useNavigate()
  const target = params?.mailboxId ?? defaultMailbox(boxes.data?.mailboxes)?.id
  useEffect(() => {
    if (search.compose !== 1 || !target) return
    openCompose({ mailboxId: target, mode: "new", ...(search.draft ? { draftId: search.draft } : {}) })
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => {
        const { compose: _drop, draft: _draft, ...rest } = prev
        return rest as never
      },
      replace: true,
    })
  }, [search.compose, search.draft, target, navigate])
  return (
    <>
      <Outlet />
      <ComposerHost />
      <MailToasts />
    </>
  )
}

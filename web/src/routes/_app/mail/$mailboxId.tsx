import { createFileRoute } from "@tanstack/react-router"
import { fixturesEnabled } from "../../../fixtures/mode.ts"
import { MailboxLayout } from "../../../mail/MailboxLayout.tsx"

export type MailSheet = "labels" | "smart-folders" | "rule" | "keys"
export type MailboxSearch = {
  /** A sheet over the mailbox: edit labels, smart folders, a rule from a message, the shortcuts. */
  sheet?: MailSheet
  /** For `sheet=rule`: the message the rule is made from. */
  message?: string
  /** For `sheet=smart-folders`: the search to save. */
  save?: string
  /** Fixture mode only: show a live-socket state the audit can't reach otherwise (reconnecting, offline, resumed, reset, new). */
  live?: "reconnecting" | "offline" | "resumed" | "reset" | "new"
}
const LIVE = ["reconnecting", "offline", "resumed", "reset", "new"] as const

const SHEETS: readonly MailSheet[] = ["labels", "smart-folders", "rule", "keys"]

export const Route = createFileRoute("/_app/mail/$mailboxId")({
  staticData: { title: "Mail" },
  validateSearch: (s: Record<string, unknown>): MailboxSearch => ({
    ...(SHEETS.includes(s.sheet as MailSheet) ? { sheet: s.sheet as MailSheet } : {}),
    ...(typeof s.message === "string" && s.message ? { message: s.message } : {}),
    ...(typeof s.save === "string" && s.save ? { save: s.save } : {}),
    ...(fixturesEnabled() && LIVE.includes(s.live as (typeof LIVE)[number])
      ? { live: s.live as (typeof LIVE)[number] }
      : {}),
  }),
  component: MailboxLayout,
})

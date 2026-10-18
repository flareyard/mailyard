import { createFileRoute } from "@tanstack/react-router"
import type { MailboxKind } from "../../../settings/logic.ts"
import { MailboxesPage } from "../../../settings/mailboxes/MailboxesPage.tsx"

const KINDS = ["user", "shared", "group", "alias", "catch_all"]

export type MailboxesSearch = {
  /** The New mailbox sheet: `1`, or a kind to start from (Add alias opens it on `alias`). */
  new?: "1" | MailboxKind
}

export const Route = createFileRoute("/_app/settings/mailboxes")({
  staticData: { title: "Mailboxes and addresses" },
  validateSearch: (s: Record<string, unknown>): MailboxesSearch =>
    s.new === "1" || s.new === 1
      ? { new: "1" }
      : typeof s.new === "string" && KINDS.includes(s.new)
        ? { new: s.new as MailboxKind }
        : {},
  component: MailboxesPage,
})

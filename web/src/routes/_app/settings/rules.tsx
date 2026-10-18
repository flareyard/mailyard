import { createFileRoute } from "@tanstack/react-router"
import { RulesPage } from "../../../settings/rules/RulesPage.tsx"

export type RulesSearch = {
  mailbox?: string
  /** The open editor: a rule id, or `new`. */
  rule?: string
  /** Apply a rule to existing mail. */
  apply?: string
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)

export const Route = createFileRoute("/_app/settings/rules")({
  staticData: { title: "Rules" },
  validateSearch: (s: Record<string, unknown>): RulesSearch => {
    const out: RulesSearch = {}
    const mailbox = str(s.mailbox)
    const rule = str(s.rule)
    const apply = str(s.apply)
    if (mailbox) out.mailbox = mailbox
    if (rule) out.rule = rule
    if (apply) out.apply = apply
    return out
  },
  component: RulesPage,
})

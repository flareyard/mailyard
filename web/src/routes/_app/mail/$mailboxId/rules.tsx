import { createFileRoute } from "@tanstack/react-router"
import { RulesPage } from "../../../../mail/pages/RulesPage.tsx"

export type RulesSearch = {
  /** Open “Apply to existing mail” for this rule. */
  apply?: string
  /** Open the new-rule sheet. */
  new?: 1
  /** Which sender list the Senders panel shows. */
  list?: "allow" | "block"
}

export const Route = createFileRoute("/_app/mail/$mailboxId/rules")({
  staticData: { title: "Rules and senders", mailPane: "thread", mailPage: true },
  validateSearch: (s: Record<string, unknown>): RulesSearch => ({
    ...(typeof s.apply === "string" && s.apply ? { apply: s.apply } : {}),
    ...(s.new === 1 || s.new === "1" ? { new: 1 as const } : {}),
    ...(s.list === "allow" || s.list === "block" ? { list: s.list } : {}),
  }),
  component: RulesPage,
})

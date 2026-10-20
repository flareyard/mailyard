import { createFileRoute } from "@tanstack/react-router"
import { SendersPage } from "../../../../mail/pages/SendersPage.tsx"

export type SendersSearch = { list?: "allow" | "block" | "images" }

export const Route = createFileRoute("/_app/mail/$mailboxId/senders")({
  staticData: { title: "Senders", mailPane: "thread", mailPage: true },
  validateSearch: (s: Record<string, unknown>): SendersSearch =>
    s.list === "allow" || s.list === "block" || s.list === "images" ? { list: s.list } : {},
  component: SendersPage,
})

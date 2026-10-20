import { createFileRoute } from "@tanstack/react-router"
import { ImportsPage } from "../../../../mail/pages/ImportsPage.tsx"

export const Route = createFileRoute("/_app/mail/$mailboxId/imports/")({
  staticData: { title: "Import and export", mailPane: "thread", mailPage: true },
  component: ImportsPage,
})

import { createFileRoute } from "@tanstack/react-router"
import { ExportPage } from "../../../../mail/pages/ExportPage.tsx"

export const Route = createFileRoute("/_app/mail/$mailboxId/export")({
  staticData: { title: "Export", mailPane: "thread", mailPage: true },
  component: ExportPage,
})

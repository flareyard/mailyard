import { createFileRoute } from "@tanstack/react-router"
import { ImportPage } from "../../../../mail/pages/ImportPage.tsx"

export type ImportSearch = { /** Open “Retry failed”, which asks for the password again. */ retry?: 1 }

export const Route = createFileRoute("/_app/mail/$mailboxId/imports/$importId")({
  staticData: { title: "Import", mailPane: "thread", mailPage: true },
  validateSearch: (s: Record<string, unknown>): ImportSearch =>
    s.retry === 1 || s.retry === "1" ? { retry: 1 } : {},
  component: function ImportRoute() {
    const { importId } = Route.useParams()
    return <ImportPage importId={importId} />
  },
})

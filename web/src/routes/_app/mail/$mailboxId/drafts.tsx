import { createFileRoute } from "@tanstack/react-router"
import { DraftsView } from "../../../../mail/DraftsView.tsx"

export type DraftsSearch = { draft?: string }

export const Route = createFileRoute("/_app/mail/$mailboxId/drafts")({
  staticData: { mailPane: "list" },
  validateSearch: (s: Record<string, unknown>): DraftsSearch =>
    typeof s.draft === "string" && s.draft ? { draft: s.draft } : {},
  component: () => <DraftsView status="draft" />,
})

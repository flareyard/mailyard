import { createFileRoute } from "@tanstack/react-router"
import { ListAndReader } from "../../../../mail/ListAndReader.tsx"
import { validateListSearch } from "../../../../mail/logic.ts"

/**
 * `/mail/$mailboxId/folders`: on a phone, this mailbox's folder pane on its own, the root of the phone stack.
 * Wider screens show the folder pane anyway, so they get the inbox beside it.
 */
export const Route = createFileRoute("/_app/mail/$mailboxId/folders")({
  staticData: { mailPane: "folders" },
  validateSearch: validateListSearch,
  component: () => <ListAndReader />,
})

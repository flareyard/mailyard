import { createFileRoute } from "@tanstack/react-router"
import { ListAndReader } from "../../../../mail/ListAndReader.tsx"
import { validateListSearch } from "../../../../mail/logic.ts"

/** `/mail/$mailboxId/search?q=&sort=`: this mailbox's search (GET …/search), results in the list pane. */
export const Route = createFileRoute("/_app/mail/$mailboxId/search")({
  staticData: { mailPane: "list" },
  validateSearch: validateListSearch,
  component: () => <ListAndReader />,
})

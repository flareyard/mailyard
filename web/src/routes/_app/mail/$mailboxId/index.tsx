import { createFileRoute } from "@tanstack/react-router"
import { ListAndReader } from "../../../../mail/ListAndReader.tsx"
import { validateListSearch } from "../../../../mail/logic.ts"

/** `/mail/$mailboxId?folder=&labelId=&unread=&starred=&assignee=&att=&q=`: a list, nothing open yet. */
export const Route = createFileRoute("/_app/mail/$mailboxId/")({
  staticData: { mailPane: "list" },
  validateSearch: validateListSearch,
  component: () => <ListAndReader />,
})

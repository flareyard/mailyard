import { createFileRoute } from "@tanstack/react-router"
import { ListAndReader } from "../../../../mail/ListAndReader.tsx"
import { validateListSearch, validateReaderSearch } from "../../../../mail/logic.ts"

/** `/mail/$mailboxId/threads/$threadId?folder=…`: the open thread is in the path, so the list keeps its query. */
export const Route = createFileRoute("/_app/mail/$mailboxId/threads/$threadId")({
  staticData: { mailPane: "thread" },
  validateSearch: (s: Record<string, unknown>) => ({ ...validateListSearch(s), ...validateReaderSearch(s) }),
  component: function ThreadRoute() {
    const { threadId } = Route.useParams()
    return <ListAndReader threadId={threadId} />
  },
})

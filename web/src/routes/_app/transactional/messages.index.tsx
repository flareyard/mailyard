import { createFileRoute } from "@tanstack/react-router"
import { parseLogSearch } from "../../../transactional/logic.ts"
import { MessageLog } from "../../../transactional/messages/MessageLog.tsx"

export const Route = createFileRoute("/_app/transactional/messages/")({
  staticData: { title: "Messages" },
  validateSearch: parseLogSearch,
  component: MessageLog,
})

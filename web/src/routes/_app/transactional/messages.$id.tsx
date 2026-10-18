import { createFileRoute } from "@tanstack/react-router"
import { MessageDetail } from "../../../transactional/messages/MessageDetail.tsx"

export type MessageSearch = { raw?: 1 }

export const Route = createFileRoute("/_app/transactional/messages/$id")({
  staticData: { title: "Message" },
  validateSearch: (s: Record<string, unknown>): MessageSearch =>
    s.raw === 1 || s.raw === "1" || s.raw === true ? { raw: 1 } : {},
  component: MessageDetail,
})

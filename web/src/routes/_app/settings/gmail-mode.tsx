import { createFileRoute } from "@tanstack/react-router"
import { GmailModePage } from "../../../settings/GmailMode.tsx"

export const Route = createFileRoute("/_app/settings/gmail-mode")({
  staticData: { title: "Gmail mode" },
  component: GmailModePage,
})

import { createFileRoute } from "@tanstack/react-router"
import { SessionsPage } from "../../../settings/Sessions.tsx"

export const Route = createFileRoute("/_app/settings/sessions")({
  staticData: { title: "Your sessions" },
  component: SessionsPage,
})

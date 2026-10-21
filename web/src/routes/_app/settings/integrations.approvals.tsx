/** The approval queue moved to Agents (2026-10-21); old links land there. */
import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/settings/integrations/approvals")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/agents/approvals", search: search as never, replace: true })
  },
})

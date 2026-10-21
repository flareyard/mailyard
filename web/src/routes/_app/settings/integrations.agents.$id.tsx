/** Agents moved to their own section (2026-10-21); old links land on the agent's new page. */
import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/settings/integrations/agents/$id")({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/agents/$id", params: { id: params.id }, search: search as never, replace: true })
  },
})

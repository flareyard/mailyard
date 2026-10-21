import { createFileRoute } from "@tanstack/react-router"
import { AgentsPage } from "../../../agents/AgentsPage.tsx"

export type AgentsSearch = { sheet?: "agent-new" }

export const Route = createFileRoute("/_app/agents/")({
  staticData: { title: "Agents" },
  validateSearch: (s: Record<string, unknown>): AgentsSearch => ({
    ...(s.sheet === "agent-new" ? { sheet: "agent-new" } : {}),
  }),
  component: AgentsPage,
})

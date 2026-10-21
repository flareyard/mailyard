import { createFileRoute } from "@tanstack/react-router"
import { AgentDetail } from "../../../settings/integrations/AgentDetail.tsx"

export type AgentSearch = { sheet?: "rotate" | "remove" | "wake" }

export const Route = createFileRoute("/_app/agents/$id")({
  staticData: { title: "Agent" },
  validateSearch: (s: Record<string, unknown>): AgentSearch => ({
    ...(s.sheet === "rotate" || s.sheet === "remove" || s.sheet === "wake" ? { sheet: s.sheet } : {}),
  }),
  component: AgentDetail,
})

import { createFileRoute } from "@tanstack/react-router"
import { AiPage } from "../../../settings/Ai.tsx"

export const Route = createFileRoute("/_app/settings/ai")({
  staticData: { title: "AI" },
  component: AiPage,
})

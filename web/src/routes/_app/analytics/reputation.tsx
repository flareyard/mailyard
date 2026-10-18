import { createFileRoute } from "@tanstack/react-router"
import { ReputationView } from "../../../analytics/ReputationView.tsx"

export const Route = createFileRoute("/_app/analytics/reputation")({
  staticData: { title: "Analytics" },
  component: ReputationView,
})

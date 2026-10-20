import { createFileRoute } from "@tanstack/react-router"
import { ReputationPage } from "../../../domains/Reputation.tsx"

export const Route = createFileRoute("/_app/domains/reputation")({
  staticData: { title: "Reputation" },
  component: ReputationPage,
})

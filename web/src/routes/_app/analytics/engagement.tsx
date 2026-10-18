import { createFileRoute } from "@tanstack/react-router"
import { Engagement } from "../../../analytics/Engagement.tsx"

export const Route = createFileRoute("/_app/analytics/engagement")({
  staticData: { title: "Analytics" },
  component: Engagement,
})

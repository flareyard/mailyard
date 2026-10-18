import { createFileRoute } from "@tanstack/react-router"
import { AudienceView } from "../../../analytics/AudienceView.tsx"

export const Route = createFileRoute("/_app/analytics/audience")({
  staticData: { title: "Analytics" },
  component: AudienceView,
})

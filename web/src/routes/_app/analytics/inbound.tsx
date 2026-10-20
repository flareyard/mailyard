import { createFileRoute } from "@tanstack/react-router"
import { Inbound } from "../../../analytics/Inbound.tsx"

export const Route = createFileRoute("/_app/analytics/inbound")({
  staticData: { title: "Analytics" },
  component: Inbound,
})

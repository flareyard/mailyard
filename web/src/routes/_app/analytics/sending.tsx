import { createFileRoute } from "@tanstack/react-router"
import { Sending } from "../../../analytics/Sending.tsx"

export const Route = createFileRoute("/_app/analytics/sending")({
  staticData: { title: "Analytics" },
  component: Sending,
})

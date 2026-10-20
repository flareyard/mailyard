import { createFileRoute } from "@tanstack/react-router"
import { TrackingPage } from "../../../settings/Tracking.tsx"

export const Route = createFileRoute("/_app/settings/tracking")({
  staticData: { title: "Tracking and compliance" },
  component: TrackingPage,
})

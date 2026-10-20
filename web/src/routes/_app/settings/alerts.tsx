import { createFileRoute } from "@tanstack/react-router"
import { AlertsPage } from "../../../settings/alerts/AlertsPage.tsx"

export const Route = createFileRoute("/_app/settings/alerts")({
  staticData: { title: "Alerts" },
  component: AlertsPage,
})

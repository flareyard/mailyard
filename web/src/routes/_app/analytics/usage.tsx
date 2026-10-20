import { createFileRoute } from "@tanstack/react-router"
import { Usage } from "../../../analytics/Usage.tsx"

export const Route = createFileRoute("/_app/analytics/usage")({
  staticData: { title: "Usage and cost" },
  component: Usage,
})

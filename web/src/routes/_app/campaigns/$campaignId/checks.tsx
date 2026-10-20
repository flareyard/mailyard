import { createFileRoute } from "@tanstack/react-router"
import { ChecksStep } from "../../../../campaigns/editor/ChecksStep.tsx"

export const Route = createFileRoute("/_app/campaigns/$campaignId/checks")({
  staticData: { title: "Campaigns" },
  validateSearch: (s: Record<string, unknown>): { focus?: string } =>
    typeof s.focus === "string" && s.focus ? { focus: s.focus } : {},
  component: function ChecksRoute() {
    const { focus } = Route.useSearch()
    return <ChecksStep focus={focus} />
  },
})

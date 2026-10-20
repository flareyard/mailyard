import { createFileRoute } from "@tanstack/react-router"
import { ScheduleStep } from "../../../../campaigns/editor/ScheduleStep.tsx"

export const Route = createFileRoute("/_app/campaigns/$campaignId/schedule")({
  staticData: { title: "Campaigns" },
  validateSearch: (s: Record<string, unknown>): { focus?: string } =>
    typeof s.focus === "string" && s.focus ? { focus: s.focus } : {},
  component: function ScheduleRoute() {
    const { focus } = Route.useSearch()
    return <ScheduleStep focus={focus} />
  },
})

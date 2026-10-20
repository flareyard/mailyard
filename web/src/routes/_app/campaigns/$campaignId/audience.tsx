import { createFileRoute } from "@tanstack/react-router"
import { AudienceStep } from "../../../../campaigns/editor/AudienceStep.tsx"

export const Route = createFileRoute("/_app/campaigns/$campaignId/audience")({
  staticData: { title: "Campaigns" },
  validateSearch: (s: Record<string, unknown>): { focus?: string } =>
    typeof s.focus === "string" && s.focus ? { focus: s.focus } : {},
  component: function AudienceRoute() {
    const { focus } = Route.useSearch()
    return <AudienceStep focus={focus} />
  },
})

import { createFileRoute } from "@tanstack/react-router"
import { ContentStep } from "../../../../campaigns/editor/ContentStep.tsx"

export const Route = createFileRoute("/_app/campaigns/$campaignId/content")({
  staticData: { title: "Campaigns" },
  validateSearch: (s: Record<string, unknown>): { focus?: string } =>
    typeof s.focus === "string" && s.focus ? { focus: s.focus } : {},
  component: function ContentRoute() {
    const { focus } = Route.useSearch()
    return <ContentStep focus={focus} />
  },
})

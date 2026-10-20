import { createFileRoute } from "@tanstack/react-router"
import { PreviewStep } from "../../../../campaigns/editor/PreviewStep.tsx"

export const Route = createFileRoute("/_app/campaigns/$campaignId/preview")({
  staticData: { title: "Campaigns" },
  validateSearch: (s: Record<string, unknown>): { focus?: string } =>
    typeof s.focus === "string" && s.focus ? { focus: s.focus } : {},
  component: function PreviewRoute() {
    const { focus } = Route.useSearch()
    return <PreviewStep focus={focus} />
  },
})

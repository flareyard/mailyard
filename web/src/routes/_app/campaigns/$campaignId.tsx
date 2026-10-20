import { createFileRoute } from "@tanstack/react-router"
import { CampaignLayout } from "../../../campaigns/CampaignLayout.tsx"

export const Route = createFileRoute("/_app/campaigns/$campaignId")({
  component: function CampaignRoute() {
    const { campaignId } = Route.useParams()
    return <CampaignLayout id={campaignId} />
  },
})

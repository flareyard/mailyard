import { createFileRoute } from "@tanstack/react-router"
import { CampaignLanding } from "../../../../campaigns/CampaignLayout.tsx"

/** `/campaigns/:id` opens where the campaign is: the editor, its schedule, the sending view or the report. */
export const Route = createFileRoute("/_app/campaigns/$campaignId/")({
  component: CampaignLanding,
})

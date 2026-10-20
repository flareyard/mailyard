import { createFileRoute } from "@tanstack/react-router"
import { isRecipientStatus } from "../../../../campaigns/logic.ts"
import type { RecipientStatus } from "../../../../campaigns/queries.ts"
import { CampaignReport } from "../../../../campaigns/report/CampaignReport.tsx"

export type ReportSearch = { status?: RecipientStatus; cursor?: string; resend?: 1 }

export const Route = createFileRoute("/_app/campaigns/$campaignId/report")({
  validateSearch: (s: Record<string, unknown>): ReportSearch => ({
    ...(isRecipientStatus(s.status) ? { status: s.status } : {}),
    ...(typeof s.cursor === "string" && s.cursor ? { cursor: s.cursor } : {}),
    ...(s.resend === 1 || s.resend === "1" ? { resend: 1 as const } : {}),
  }),
  component: function ReportRoute() {
    const { campaignId } = Route.useParams()
    const search = Route.useSearch()
    return <CampaignReport id={campaignId} {...search} />
  },
})

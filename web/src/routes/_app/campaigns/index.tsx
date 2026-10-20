import { createFileRoute } from "@tanstack/react-router"
import { CampaignsList } from "../../../campaigns/CampaignsList.tsx"
import { isListStatus } from "../../../campaigns/logic.ts"
import type { ListStatus } from "../../../campaigns/queries.ts"

export type CampaignsSearch = { status?: ListStatus; cursor?: string }

export const Route = createFileRoute("/_app/campaigns/")({
  validateSearch: (s: Record<string, unknown>): CampaignsSearch => ({
    ...(isListStatus(s.status) ? { status: s.status } : {}),
    ...(typeof s.cursor === "string" && s.cursor ? { cursor: s.cursor } : {}),
  }),
  component: function CampaignsRoute() {
    const { status, cursor } = Route.useSearch()
    return <CampaignsList status={status} cursor={cursor} />
  },
})

/**
 * Every read the campaign screens make, as query options, typed from the OpenAPI. Keys start with
 * `["campaigns", …]` so one invalidation refreshes the list, the counts and every open campaign; the Overview's
 * pace query shares its key with the sending view.
 */
import { queryOptions } from "@tanstack/react-query"
import { api, type paths, unwrap } from "../api/client.ts"
import { arr, type Body, type Json } from "../audience/kit/queries.ts"

export type CampaignListItem = Json<"/v1/campaigns", "get">["campaigns"][number]
export type Campaign = Json<"/v1/campaigns/{id}", "get">
export type CampaignStatus = Campaign["status"]
export type Counts = Json<"/v1/campaigns/counts", "get">
export type BlocksDoc = NonNullable<Campaign["bodyBlocks"]>
export type Block = BlocksDoc["blocks"][number]
export type BlockType = Block["type"]
export type Render = Json<"/v1/campaigns/{id}/render", "post">
export type RenderLink = Render["links"][number]
export type Checks = Json<"/v1/campaigns/{id}/checks", "get">
export type Check = Checks["checks"][number]
export type Fix = NonNullable<Check["fix"]>
export type AudiencePreview = Json<"/v1/campaigns/{id}/audience/preview", "post">
export type Pace = Json<"/v1/campaigns/{id}/pace", "get">
export type Report = Json<"/v1/campaigns/{id}/report", "get">
export type Recipients = Json<"/v1/campaigns/{id}/recipients", "get">
export type Recipient = Recipients["recipients"][number]
export type RecipientStatus = NonNullable<
  NonNullable<paths["/v1/campaigns/{id}/recipients"]["get"]["parameters"]["query"]>["status"]
>
export type ResendDryRun = Json<"/v1/campaigns/{id}/resend-non-openers", "get">
export type Forecast = Json<"/v1/usage/forecast", "get">
export type Compliance = Json<"/v1/settings/compliance", "get">
export type Governor = Json<"/v1/sending/governor", "get">
export type Reputation = Json<"/v1/reputation", "get">
export type Alert = Json<"/v1/alerts", "get">["alerts"][number]
export type Verified = Json<"/v1/verified-addresses", "get">
export type ContactLite = Json<"/v1/contacts", "get">["contacts"][number]
export type Patch = Body<"/v1/campaigns/{id}", "patch">

export type ListStatus = CampaignStatus | "active"

export const countsQuery = queryOptions({
  queryKey: ["campaigns", "counts"],
  queryFn: () => unwrap(api.GET("/v1/campaigns/counts")),
})

export const listQuery = (status: ListStatus | undefined, cursor: string | undefined) =>
  queryOptions({
    queryKey: ["campaigns", "list", status ?? "all", cursor ?? null],
    queryFn: () =>
      unwrap(
        api.GET("/v1/campaigns", {
          params: { query: { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: "50" } },
        }),
      ),
    select: (r) => ({ campaigns: arr<CampaignListItem>(r?.campaigns), nextCursor: r?.nextCursor ?? null }),
  })

export const campaignQuery = (id: string) =>
  queryOptions({
    queryKey: ["campaigns", id],
    queryFn: () => unwrap(api.GET("/v1/campaigns/{id}", { params: { path: { id } } })),
  })

export const checksQuery = (id: string) =>
  queryOptions({
    queryKey: ["campaigns", id, "checks"],
    queryFn: () => unwrap(api.GET("/v1/campaigns/{id}/checks", { params: { path: { id } } })),
  })

/** The audience preview counts the saved campaign, so its key carries the version it counted. */
export const previewQuery = (id: string, version: number | null) =>
  queryOptions({
    queryKey: ["campaigns", id, "audience-preview", version],
    queryFn: () => unwrap(api.POST("/v1/campaigns/{id}/audience/preview", { params: { path: { id } } })),
  })

export const renderQuery = (
  id: string,
  opts: { contactId?: string | undefined; variant: "a" | "b"; version: number | null },
) =>
  queryOptions({
    queryKey: ["campaigns", id, "render", opts.contactId ?? null, opts.variant, opts.version],
    queryFn: () =>
      unwrap(
        api.POST("/v1/campaigns/{id}/render", {
          params: { path: { id } },
          body: { variant: opts.variant, ...(opts.contactId ? { contactId: opts.contactId } : {}) },
        }),
      ),
  })

export const paceQuery = (id: string) =>
  queryOptions({
    queryKey: ["campaigns", id, "pace"],
    queryFn: () => unwrap(api.GET("/v1/campaigns/{id}/pace", { params: { path: { id } } })),
  })

export const reportQuery = (id: string) =>
  queryOptions({
    queryKey: ["campaigns", id, "report"],
    queryFn: () => unwrap(api.GET("/v1/campaigns/{id}/report", { params: { path: { id } } })),
  })

export const recipientsQuery = (
  id: string,
  status: RecipientStatus | undefined,
  cursor: string | undefined,
) =>
  queryOptions({
    queryKey: ["campaigns", id, "recipients", status ?? "all", cursor ?? null],
    queryFn: () =>
      unwrap(
        api.GET("/v1/campaigns/{id}/recipients", {
          params: {
            path: { id },
            query: { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: "50" },
          },
        }),
      ),
  })

export const resendDryRunQuery = (id: string, countMachine: boolean) =>
  queryOptions({
    queryKey: ["campaigns", id, "resend-dry-run", countMachine],
    queryFn: () =>
      unwrap(
        api.GET("/v1/campaigns/{id}/resend-non-openers", {
          params: { path: { id }, query: { countMachineOpensAsOpened: countMachine ? "true" : "false" } },
        }),
      ),
  })

export const forecastQuery = (recipients: number, startAt: number | null, campaignId: string) =>
  queryOptions({
    queryKey: ["usage", "forecast", recipients, startAt, campaignId],
    queryFn: () =>
      unwrap(
        api.GET("/v1/usage/forecast", {
          params: {
            query: {
              recipients: String(recipients),
              campaignId,
              ...(startAt !== null ? { startAt: String(startAt) } : {}),
            },
          },
        }),
      ),
  })

export const complianceQuery = queryOptions({
  queryKey: ["settings", "compliance"],
  queryFn: () => unwrap(api.GET("/v1/settings/compliance")),
  staleTime: 5 * 60_000,
})

export const governorQuery = queryOptions({
  queryKey: ["sending", "governor"],
  queryFn: () => unwrap(api.GET("/v1/sending/governor")),
})

export const reputationQuery = queryOptions({
  queryKey: ["reputation"],
  queryFn: () => unwrap(api.GET("/v1/reputation")),
})

export const pausedAlertsQuery = queryOptions({
  queryKey: ["alerts", "campaign_paused"],
  queryFn: () =>
    unwrap(api.GET("/v1/alerts", { params: { query: { kind: "campaign_paused", status: "open" } } })),
  select: (r) => arr<Alert>(r?.alerts),
})

export const verifiedQuery = queryOptions({
  queryKey: ["verified-addresses"],
  queryFn: () => unwrap(api.GET("/v1/verified-addresses")),
  staleTime: 5 * 60_000,
})

/** A few contacts to render the preview as. */
export const sampleContactsQuery = queryOptions({
  queryKey: ["contacts", "sample", 12],
  queryFn: () =>
    unwrap(api.GET("/v1/contacts", { params: { query: { limit: "12", sort: "-lastActivityAt" } } })),
  select: (r) => arr<ContactLite>(r?.contacts),
  staleTime: 5 * 60_000,
})

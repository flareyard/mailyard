import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { engagementStats, storageUsage } from "../domain/engagement.ts"
import {
  deferralStats,
  deliveryStats,
  forecast,
  health,
  providerStats,
  reputation,
  usage,
  volumeStats,
} from "../domain/insights.ts"
import { MailApi } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"

const read = <A, R>(effect: Effect.Effect<A, { readonly _tag: "DatabaseError" }, R>) =>
  requireScope("read", "analytics.read").pipe(
    Effect.andThen(effect),
    Effect.catchTag("DatabaseError", Effect.die),
  )

export const InsightsHandlers = HttpApiBuilder.group(
  MailApi,
  "insights",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      health: p(() => read(health())),
      usage: p(() => read(usage())),
      forecast: p(({ query }) =>
        read(
          forecast(query.recipients, { startAt: query.startAt, campaignId: query.campaignId }).pipe(
            // The governor is a Durable Object in this Worker; not reaching it is a fault, not input.
            Effect.catchTag("GovernorUnavailable", Effect.die),
          ),
        ),
      ),
      delivery: p(({ query }) => read(deliveryStats(query.range ?? "7d", query.by))),
      deferrals: p(({ query }) => read(deferralStats(query.range ?? "7d"))),
      engagement: p(({ query }) => read(engagementStats(query.range ?? "30d"))),
      storage: p(() => read(storageUsage())),
      volume: p(({ query }) => read(volumeStats(query.range ?? "30d", query.by ?? "day"))),
      providers: p(({ query }) => read(providerStats(query.range ?? "30d"))),
      reputation: p(() => read(reputation())),
    })
  }),
)

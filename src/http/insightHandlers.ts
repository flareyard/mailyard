import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import {
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
  requireScope("read").pipe(Effect.andThen(effect), Effect.catchTag("DatabaseError", Effect.die))

export const InsightsHandlers = HttpApiBuilder.group(
  MailApi,
  "insights",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      health: p(() => read(health())),
      usage: p(() => read(usage())),
      forecast: p(({ query }) => read(forecast(query.recipients))),
      delivery: p(({ query }) => read(deliveryStats(query.range ?? "7d"))),
      volume: p(({ query }) => read(volumeStats(query.range ?? "30d"))),
      providers: p(({ query }) => read(providerStats(query.range ?? "30d"))),
      reputation: p(() => read(reputation())),
    })
  }),
)

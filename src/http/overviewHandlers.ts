import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { activity, audienceStats, inboundStats, mailAttention, responseTimes } from "../domain/overview.ts"
import { MailApi } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"

export const OverviewHandlers = HttpApiBuilder.group(
  MailApi,
  "overview",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      attention: p(({ query }) =>
        requireScope("read", "mail.read").pipe(
          Effect.flatMap((caller) => mailAttention(caller, query)),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      inbound: p(({ query }) =>
        requireScope("read", "analytics.read").pipe(
          Effect.andThen(inboundStats(query.range ?? "7d")),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      audience: p(({ query }) =>
        requireScope("read", "analytics.read").pipe(
          Effect.andThen(audienceStats(query.range ?? "30d")),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      responseTimes: p(({ query }) =>
        requireScope("read", "analytics.read").pipe(
          Effect.flatMap((caller) => responseTimes(caller, query.range ?? "30d")),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      activity: p(({ query }) =>
        requireScope("read", "analytics.read").pipe(
          Effect.andThen(activity(query)),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
    })
  }),
)

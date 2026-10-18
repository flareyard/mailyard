import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { getInbound, type InboundNotFound, listInbound, reprocess } from "../inbound/pipeline.ts"
import type { DatabaseError } from "../services/Database.ts"
import { MailApi, NotFound } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"

const notFound = <A, E, R>(self: Effect.Effect<A, E | InboundNotFound, R>) =>
  Effect.catchTag(self, "InboundNotFound", (e) =>
    Effect.fail(new NotFound({ message: `Inbound message ${(e as InboundNotFound).id} not found.` })),
  ) as Effect.Effect<A, Exclude<E, InboundNotFound> | NotFound, R>

const dbDies = <A, E, R>(self: Effect.Effect<A, E | DatabaseError, R>) =>
  Effect.catchTag(self, "DatabaseError", Effect.die) as Effect.Effect<A, Exclude<E, DatabaseError>, R>

/** Reading the inbound ledger needs `read`; filing a message again needs `admin`. */
export const InboundHandlers = HttpApiBuilder.group(
  MailApi,
  "inbound",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ query }) =>
        requireScope("read", "settings.read").pipe(
          Effect.andThen(
            listInbound({ status: query.status, cursor: query.cursor, limit: query.limit ?? 50 }),
          ),
          dbDies,
        ),
      ),
      get: p(({ params }) =>
        requireScope("read", "settings.read").pipe(Effect.andThen(getInbound(params.id)), notFound, dbDies),
      ),
      reprocess: p(({ params }) =>
        requireScope("admin", "mail.manage").pipe(Effect.andThen(reprocess(params.id)), notFound, dbDies),
      ),
    })
  }),
)

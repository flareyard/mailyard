import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { listAlerts, resolveAlert } from "../domain/alerts.ts"
import { recordAudit } from "../domain/audit.ts"
import { eventCoverage } from "../domain/eventCoverage.ts"
import { getTestSend, startTestSend } from "../domain/testSend.ts"
import { CloudflareEmail } from "../services/CloudflareEmail.ts"
import { Governor } from "../services/Governor.ts"
import { GovernorUnreachable, InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { appContext, notWhileDeleting, provideTo, requireScope } from "./handlers.ts"

/** The governor being unreachable is a 503 the caller can retry, not a 500. */
const reachable = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.catchTag(
    self as Effect.Effect<A, E | { readonly _tag: "GovernorUnavailable" }, R>,
    "GovernorUnavailable",
    () =>
      Effect.fail(
        new GovernorUnreachable({ message: "The send scheduler didn't answer; try again shortly." }),
      ),
  ) as Effect.Effect<A, Exclude<E, { readonly _tag: "GovernorUnavailable" }> | GovernorUnreachable, R>

export const SendingHandlers = HttpApiBuilder.group(
  MailApi,
  "sending",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      startTestSend: p(({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("send", "email.send")
          yield* notWhileDeleting
          const result = yield* startTestSend(payload, caller.keyId)
          yield* recordAudit({
            actor: caller.keyId,
            action: "test_send.start",
            target: result.id,
            after: { from: result.from, to: result.to, probe: result.probe },
          })
          return result
        }).pipe(
          Effect.catchTag("TestSendInvalid", (e) =>
            Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
          ),
          Effect.catchTag("InvalidMessage", (e) =>
            Effect.fail(new InvalidRequest({ field: "from", message: e.reason })),
          ),
          // The test is written right after the send; a missing row here is a fault, not input.
          Effect.catchTag("TestSendNotFound", Effect.die),
          Effect.catchTags({
            DatabaseError: Effect.die,
            BlobStoreError: Effect.die,
            TrackingKeyMissing: Effect.die,
          }),
        ),
      ),
      getTestSend: p(({ params }) =>
        requireScope("read", "settings.read").pipe(
          Effect.andThen(getTestSend(params.id)),
          Effect.catchTag("TestSendNotFound", (e) =>
            Effect.fail(new NotFound({ message: `Test send ${e.id} not found.` })),
          ),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      verifiedAddresses: p(() =>
        requireScope("read", "settings.read").pipe(
          Effect.andThen(CloudflareEmail.use((c) => c.verifiedAddresses)),
        ),
      ),
      governor: p(() =>
        requireScope("read", "analytics.read").pipe(
          Effect.andThen(Governor.use((g) => g.overview)),
          reachable,
        ),
      ),
      events: p(() =>
        requireScope("read", "settings.read").pipe(
          Effect.andThen(eventCoverage()),
          Effect.map((domains) => ({ domains })),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      getSettings: p(() =>
        requireScope("read", "settings.read").pipe(
          Effect.andThen(Governor.use((g) => g.overview)),
          Effect.map((o) => o.config),
          reachable,
        ),
      ),
      putSettings: p(({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "settings.write")
          const governor = yield* Governor
          const before = (yield* governor.overview).config
          const after = yield* governor.configure(payload as Parameters<typeof governor.configure>[0])
          yield* recordAudit({
            actor: caller.keyId,
            action: "settings.sending",
            target: "governor",
            before,
            after,
          })
          return after
        }).pipe(reachable),
      ),
    })
  }),
)

export const AlertsHandlers = HttpApiBuilder.group(
  MailApi,
  "alerts",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ query }) =>
        requireScope("read", "settings.read").pipe(
          Effect.andThen(listAlerts(query)),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      resolve: p(({ params }) =>
        requireScope("admin", "settings.write").pipe(
          Effect.flatMap((caller) => resolveAlert(params.id, caller.keyId)),
          Effect.catchTag("AlertNotFound", (e) =>
            Effect.fail(new NotFound({ message: `Alert ${e.id} not found.` })),
          ),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
    })
  }),
)

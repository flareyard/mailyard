import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
  automationSummary,
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  listVersions,
  publishAutomation,
  restoreVersion,
  setPaused,
  updateAutomation,
} from "../automations/automations.ts"
import { Conflict, InvalidRequest, MailApi, NotFound, NotReady } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"

const notFound = (e: { readonly id: string }) =>
  Effect.fail(new NotFound({ message: `Automation ${e.id} not found.` }))
const invalid = (e: { readonly field: string; readonly message: string }) =>
  Effect.fail(new InvalidRequest({ field: e.field, message: e.message }))

export const AutomationsHandlers = HttpApiBuilder.group(
  MailApi,
  "automations",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ query }) =>
        requireScope("read").pipe(
          Effect.andThen(listAutomations(query.range ?? "7d")),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      summary: p(() =>
        requireScope("read").pipe(
          Effect.andThen(automationSummary()),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => createAutomation(payload, caller.keyId)),
          Effect.catchTags({
            AutomationInvalid: invalid,
            AutomationNotFound: Effect.die,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      get: p(({ params }) =>
        requireScope("read").pipe(
          Effect.andThen(getAutomation(params.id)),
          Effect.catchTags({ AutomationNotFound: notFound, DatabaseError: Effect.die }),
        ),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => updateAutomation(params.id, payload, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationInvalid: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => deleteAutomation(params.id, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationBusy: (e) => Effect.fail(new Conflict({ message: e.message })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
      publish: p(({ params, payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => publishAutomation(params.id, payload.note ?? null, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationNotReady: (e) =>
              Effect.fail(
                new NotReady({
                  message: `${e.issues.length} thing(s) to fix before publishing.`,
                  issues: e.issues,
                }),
              ),
            DatabaseError: Effect.die,
          }),
        ),
      ),
      versions: p(({ params }) =>
        requireScope("read").pipe(
          Effect.andThen(listVersions(params.id)),
          Effect.catchTags({ AutomationNotFound: notFound, DatabaseError: Effect.die }),
        ),
      ),
      restore: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => restoreVersion(params.id, params.version, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationInvalid: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      pause: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => setPaused(params.id, true, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationInvalid: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      resume: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => setPaused(params.id, false, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationInvalid: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
    })
  }),
)

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
import { eventKeys, testWebhookStep } from "../automations/builderTools.ts"
import { dryRun } from "../automations/dryRun.ts"
import {
  automationWebhookSecret,
  enterAutomation,
  exitRun,
  getRun,
  listRuns,
  retryRun,
} from "../automations/runs.ts"
import { redactGraph } from "../automations/secrets.ts"
import { can } from "../domain/permissions.ts"
import { Conflict, InvalidRequest, MailApi, NotFound, NotReady } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

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
        requireScope("read", "automations.read").pipe(
          Effect.andThen(listAutomations(query.range ?? "7d")),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      summary: p(() =>
        requireScope("read", "automations.read").pipe(
          Effect.andThen(automationSummary()),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.flatMap((caller) => createAutomation(payload, caller.keyId)),
          Effect.catchTags({
            AutomationInvalid: invalid,
            AutomationNotFound: Effect.die,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      get: p(({ params }) =>
        requireScope("read", "automations.read").pipe(
          Effect.flatMap((caller) =>
            getAutomation(params.id).pipe(
              // Secrets in step configs are for admins, who can change them (HAL-3412).
              Effect.map((a) => (can(caller, "automations.write") ? a : { ...a, ...redactGraph(a.graph) })),
            ),
          ),
          Effect.catchTags({ AutomationNotFound: notFound, DatabaseError: Effect.die }),
        ),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.flatMap((caller) => updateAutomation(params.id, payload, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationInvalid: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.flatMap((caller) => deleteAutomation(params.id, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationBusy: (e) => Effect.fail(new Conflict({ message: e.message })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
      publish: p(({ params, payload, request }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.flatMap((caller) =>
            publishAutomation(params.id, payload.note ?? null, caller.keyId, originOf(request)),
          ),
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
        requireScope("read", "automations.read").pipe(
          Effect.andThen(listVersions(params.id)),
          Effect.catchTags({ AutomationNotFound: notFound, DatabaseError: Effect.die }),
        ),
      ),
      restore: p(({ params }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.flatMap((caller) => restoreVersion(params.id, params.version, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationInvalid: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      pause: p(({ params }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.flatMap((caller) => setPaused(params.id, true, caller.keyId)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationInvalid: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      testStep: p(({ params, payload }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.andThen(
            testWebhookStep({
              automationId: params.id,
              nodeId: params.nodeId,
              version: payload.version,
              contactId: payload.contactId,
            }),
          ),
          Effect.catchTags({
            AutomationNotFound: notFound,
            StepNotTestable: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      eventKeys: p(({ params }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("read", "automations.read")
          return yield* eventKeys({ name: params.name, withExamples: can(caller, "contacts.read") })
        }).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
      dryRun: p(({ params, payload }) =>
        requireScope("read", "automations.read").pipe(
          Effect.andThen(dryRun(params.id, payload)),
          Effect.catchTags({
            AutomationNotFound: notFound,
            AutomationNotReady: (e) =>
              Effect.fail(
                new NotReady({ message: "Fix the graph's structure before a dry run.", issues: e.issues }),
              ),
            DatabaseError: Effect.die,
          }),
          Effect.catchDefect((defect) =>
            Effect.fail(
              new InvalidRequest({
                field: "template",
                message: defect instanceof Error ? defect.message : String(defect),
              }),
            ),
          ),
        ),
      ),
      enter: p(({ params, payload }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.andThen(getAutomation(params.id)),
          Effect.andThen(enterAutomation(params.id, payload.contactId, payload.data ?? null)),
          Effect.map((result) => ({ result })),
          Effect.catchTags({ AutomationNotFound: notFound, DatabaseError: Effect.die }),
        ),
      ),
      runs: p(({ params, query }) =>
        requireScope("read", "automations.read").pipe(
          Effect.andThen(getAutomation(params.id)),
          Effect.andThen(listRuns(params.id, query)),
          Effect.catchTags({ AutomationNotFound: notFound, DatabaseError: Effect.die }),
        ),
      ),
      webhookSecret: p(({ params }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.andThen(getAutomation(params.id)),
          Effect.andThen(automationWebhookSecret(params.id)),
          Effect.map((secret) => ({ secret })),
          Effect.catchTags({ AutomationNotFound: notFound, DatabaseError: Effect.die }),
        ),
      ),
      resume: p(({ params }) =>
        requireScope("admin", "automations.write").pipe(
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

const runNotFound = (e: { readonly id: string }) =>
  Effect.fail(new NotFound({ message: `Run ${e.id} not found.` }))

export const RunsHandlers = HttpApiBuilder.group(
  MailApi,
  "runs",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      get: p(({ params }) =>
        requireScope("read", "automations.read").pipe(
          Effect.andThen(getRun(params.id)),
          Effect.catchTags({ RunNotFound: runNotFound, DatabaseError: Effect.die }),
        ),
      ),
      exit: p(({ params }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.flatMap((caller) => exitRun(params.id, caller.keyId)),
          Effect.catchTags({
            RunNotFound: runNotFound,
            RunInvalid: (e) => Effect.fail(new Conflict({ message: e.message })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
      retry: p(({ params }) =>
        requireScope("admin", "automations.write").pipe(
          Effect.flatMap((caller) => retryRun(params.id, caller.keyId)),
          Effect.catchTags({
            RunNotFound: runNotFound,
            RunInvalid: (e) => Effect.fail(new Conflict({ message: e.message })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
    })
  }),
)

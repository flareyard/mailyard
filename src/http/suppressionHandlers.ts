import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
  addSuppression,
  getSuppression,
  listSuppressions,
  pushSuppression,
  removeSuppression,
  syncWithCloudflare,
  updateSuppression,
} from "../domain/suppressions.ts"
import {
  getSuppressionImport,
  listSuppressionImports,
  startSuppressionImport,
} from "../imports/suppressionImport.ts"
import {
  CloudflareNotConnected,
  CloudflareRefused,
  Conflict,
  InvalidRequest,
  MailApi,
  NotFound,
} from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"

const invalid = (e: { readonly field: string; readonly message: string }) =>
  Effect.fail(new InvalidRequest({ field: e.field, message: e.message }))
const missing = (e: { readonly email: string }) =>
  Effect.fail(new NotFound({ message: `${e.email} isn't on the suppression list.` }))
const notFound = (what: string) => (e: { readonly id: string }) =>
  Effect.fail(new NotFound({ message: `${what} ${e.id} not found.` }))

export const SuppressionsHandlers = HttpApiBuilder.group(
  MailApi,
  "suppressions",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ query }) =>
        requireScope("read", "contacts.read").pipe(
          Effect.andThen(listSuppressions(query)),
          Effect.catchTags({ SuppressionInvalid: invalid, DatabaseError: Effect.die }),
        ),
      ),
      add: p(({ payload }) =>
        requireScope("admin", "contacts.write").pipe(
          Effect.flatMap((caller) => addSuppression(payload, caller.keyId)),
          Effect.catchTags({
            SuppressionInvalid: invalid,
            SuppressionNotFound: Effect.die,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      import: p(({ payload }) =>
        requireScope("admin", "contacts.write").pipe(
          Effect.flatMap((caller) => startSuppressionImport(payload, caller.keyId)),
          Effect.catchTags({
            UploadNotFound: notFound("Upload"),
            ImportNotFound: notFound("Import"),
            ImportInvalid: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      imports: p(({ query }) =>
        requireScope("read", "contacts.read").pipe(
          Effect.andThen(listSuppressionImports(query)),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      getImport: p(({ params }) =>
        requireScope("read", "contacts.read").pipe(
          Effect.andThen(getSuppressionImport(params.id)),
          Effect.catchTags({ ImportNotFound: notFound("Import"), DatabaseError: Effect.die }),
        ),
      ),
      sync: p(() =>
        requireScope("admin", "contacts.write").pipe(
          Effect.andThen(syncWithCloudflare()),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      get: p(({ params }) =>
        requireScope("read", "contacts.read").pipe(
          Effect.andThen(getSuppression(params.email)),
          Effect.catchTags({ SuppressionNotFound: missing, DatabaseError: Effect.die }),
        ),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin", "contacts.write").pipe(
          Effect.flatMap((caller) => updateSuppression(params.email, payload, caller.keyId)),
          Effect.catchTags({
            SuppressionNotFound: missing,
            SuppressionInvalid: invalid,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      remove: p(({ params, payload }) =>
        requireScope("admin", "contacts.erase").pipe(
          Effect.flatMap((caller) => removeSuppression(params.email, payload, caller.keyId)),
          Effect.catchTags({
            SuppressionNotFound: missing,
            SuppressionInvalid: invalid,
            SuppressionRefused: (e) => Effect.fail(new Conflict({ reason: e.reason, message: e.message })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
      push: p(({ params }) =>
        requireScope("admin", "contacts.write").pipe(
          Effect.flatMap((caller) => pushSuppression(params.email, caller.keyId)),
          Effect.catchTags({
            SuppressionNotFound: missing,
            SuppressionRefused: (e) => Effect.fail(new Conflict({ reason: e.reason, message: e.message })),
            CloudflareUnavailable: (e) =>
              e.reason === "not-connected"
                ? Effect.fail(new CloudflareNotConnected({ message: e.message }))
                : Effect.fail(new CloudflareRefused({ status: e.status, message: e.message })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
    })
  }),
)

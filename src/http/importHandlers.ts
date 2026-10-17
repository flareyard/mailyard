import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { getContactImport, listContactImports, startContactImport } from "../imports/contactImport.ts"
import { InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"

const notFound = (what: string) => (e: { readonly id: string }) =>
  Effect.fail(new NotFound({ message: `${what} ${e.id} not found.` }))

export const ImportsHandlers = HttpApiBuilder.group(
  MailApi,
  "imports",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      contacts: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => startContactImport(payload, caller.keyId)),
          Effect.catchTags({
            UploadNotFound: notFound("Upload"),
            ImportNotFound: notFound("Import"),
            ImportInvalid: (e) => Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
      list: p(({ query }) =>
        requireScope("read").pipe(
          Effect.andThen(listContactImports(query)),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      get: p(({ params }) =>
        requireScope("read").pipe(
          Effect.andThen(getContactImport(params.id)),
          Effect.catchTags({ ImportNotFound: notFound("Import"), DatabaseError: Effect.die }),
        ),
      ),
    })
  }),
)

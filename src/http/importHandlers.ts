import * as Effect from "effect/Effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
  cancelContactImport,
  getContactImport,
  importErrorsCsv,
  listContactImports,
  startContactImport,
} from "../imports/contactImport.ts"
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
        requireScope("admin", "contacts.write").pipe(
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
        requireScope("read", "contacts.read").pipe(
          Effect.andThen(listContactImports(query)),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      get: p(({ params }) =>
        requireScope("read", "contacts.read").pipe(
          Effect.andThen(getContactImport(params.id)),
          Effect.catchTags({ ImportNotFound: notFound("Import"), DatabaseError: Effect.die }),
        ),
      ),
      errorsCsv: p(({ params }) =>
        requireScope("read", "contacts.read").pipe(
          Effect.andThen(importErrorsCsv(params.id)),
          Effect.map((csv) =>
            HttpServerResponse.text(csv, {
              contentType: "text/csv; charset=utf-8",
              headers: {
                "content-disposition": `attachment; filename="${params.id}-errors.csv"`,
                "cache-control": "private, no-store",
                "x-content-type-options": "nosniff",
              },
            }),
          ),
          Effect.catchTags({ ImportNotFound: notFound("Import"), DatabaseError: Effect.die }),
        ),
      ),
      cancel: p(({ params }) =>
        requireScope("admin", "contacts.write").pipe(
          Effect.flatMap((caller) => cancelContactImport(params.id, caller.keyId)),
          Effect.catchTags({
            ImportNotFound: notFound("Import"),
            ImportInvalid: (e) => Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
    })
  }),
)

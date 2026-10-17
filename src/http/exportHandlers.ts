import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { Bindings } from "../Bindings.ts"
import { createContactExport, getExport, listExports } from "../exports/contactExport.ts"
import { InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

export const ExportsHandlers = HttpApiBuilder.group(
  MailApi,
  "exports",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      create: p(({ payload, request }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("read")
          const { CONTACT_EXPORT_WORKFLOW } = yield* Bindings
          return yield* createContactExport(
            { filter: payload.filter ?? {}, fields: payload.fields },
            caller.keyId,
            originOf(request),
            async (exportId) => {
              const instance = await CONTACT_EXPORT_WORKFLOW.create({
                id: `contact-export-${exportId}`,
                params: { exportId },
              })
              ;(instance as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
            },
          )
        }).pipe(
          Effect.catchTags({
            ExportInvalid: (e) => Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            SegmentInvalid: (e) => Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            SegmentNotFound: (e) => Effect.fail(new NotFound({ message: `Segment ${e.id} not found.` })),
            // The export was just written, so not finding it again is a fault, not the caller's 404.
            ExportNotFound: Effect.die,
            DatabaseError: Effect.die,
            BlobStoreError: Effect.die,
          }),
        ),
      ),
      list: p(({ query }) =>
        requireScope("read").pipe(
          Effect.andThen(listExports(query)),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      get: p(({ params, request }) =>
        requireScope("read").pipe(
          Effect.andThen(getExport(params.id, originOf(request))),
          Effect.catchTags({
            ExportNotFound: (e) => Effect.fail(new NotFound({ message: `Export ${e.id} not found.` })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
    })
  }),
)

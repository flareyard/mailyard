import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
  cancelImport,
  createExport,
  createImport,
  getExport,
  getImport,
  listExports,
  listImports,
} from "../imports/manage.ts"
import { requireMailbox } from "../mail/access.ts"
import { MailApi } from "./Api.ts"
import { CurrentCaller, Forbidden } from "./Auth.ts"
import { appContext, provideTo } from "./handlers.ts"
import { mailErrors, originOf } from "./mailHandlers.ts"

/** Importing into or exporting a whole mailbox is for its owner or an admin key. */
const owner = (mailboxId: string) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller
    const granted = yield* requireMailbox(caller, mailboxId, "write")
    if (granted.role !== "admin" && granted.role !== "owner") {
      return yield* new Forbidden({
        message: "Imports and exports take the mailbox's owner or an admin key.",
      })
    }
    return { caller, ...granted }
  })

export const TransfersHandlers = HttpApiBuilder.group(
  MailApi,
  "transfers",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      createImport: p(({ params, payload }) =>
        Effect.gen(function* () {
          const { caller } = yield* owner(params.id)
          return yield* createImport(params.id, payload, caller.keyId)
        }).pipe(mailErrors),
      ),
      imports: p(({ params }) =>
        Effect.gen(function* () {
          yield* owner(params.id)
          return { imports: yield* listImports(params.id) }
        }).pipe(mailErrors),
      ),
      import: p(({ params }) =>
        Effect.gen(function* () {
          yield* owner(params.id)
          return yield* getImport(params.id, params.importId)
        }).pipe(mailErrors),
      ),
      cancelImport: p(({ params }) =>
        Effect.gen(function* () {
          const { caller } = yield* owner(params.id)
          return yield* cancelImport(params.id, params.importId, caller.keyId)
        }).pipe(mailErrors),
      ),
      createExport: p(({ params, request }) =>
        Effect.gen(function* () {
          const { caller } = yield* owner(params.id)
          return yield* createExport(params.id, caller.keyId, originOf(request))
        }).pipe(mailErrors),
      ),
      exports: p(({ params }) =>
        Effect.gen(function* () {
          yield* owner(params.id)
          return { exports: yield* listExports(params.id) }
        }).pipe(mailErrors),
      ),
      export: p(({ params, request }) =>
        Effect.gen(function* () {
          yield* owner(params.id)
          return yield* getExport(params.id, params.exportId, originOf(request))
        }).pipe(mailErrors),
      ),
    })
  }),
)

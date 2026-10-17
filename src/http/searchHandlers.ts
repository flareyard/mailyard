import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { RESULT_TYPES, type ResultType, searchMail, searchWorkspace } from "../domain/workspaceSearch.ts"
import { InvalidRequest, MailApi } from "./Api.ts"
import { CurrentCaller, Forbidden } from "./Auth.ts"
import { appContext, provideTo } from "./handlers.ts"

const readKey = Effect.gen(function* () {
  const caller = yield* CurrentCaller
  if (caller.kind === "public")
    return yield* new Forbidden({ message: "Public keys can't search.", reason: "public-key" })
  return caller
})

export const SearchHandlers = HttpApiBuilder.group(
  MailApi,
  "search",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      workspace: p(({ query }) =>
        Effect.gen(function* () {
          const caller = yield* readKey
          const types = query.types
            ? query.types
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined
          const unknown = types?.filter((t) => !(RESULT_TYPES as ReadonlyArray<string>).includes(t)) ?? []
          if (unknown.length)
            return yield* new InvalidRequest({
              field: "types",
              message: `Unknown type: ${unknown.join(", ")}. Use ${RESULT_TYPES.join(", ")}.`,
            })
          return yield* searchWorkspace(caller, {
            q: query.q,
            types: types as Array<ResultType> | undefined,
            limit: query.limit,
          })
        }).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
      mail: p(({ query }) =>
        Effect.gen(function* () {
          const caller = yield* readKey
          return yield* searchMail(caller, query.q, { limit: query.limit, sort: query.sort })
        }).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
    })
  }),
)

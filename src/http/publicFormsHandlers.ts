import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { Bindings, type Env } from "../Bindings.ts"
import { handleFormSubmit } from "../workers/public.ts"
import { MailApi } from "./Api.ts"

/**
 * The signup form's submit, declared in the API so it's in the spec (HAL-3472). The Worker's router
 * serves it first (it must answer CORS preflights and form posts the API layer doesn't see); this
 * handler runs the same code for a request that reaches the API, so both paths answer the same.
 */
export const PublicFormsHandlers = HttpApiBuilder.group(
  MailApi,
  "publicForms",
  Effect.fn(function* (handlers) {
    const env = (yield* Bindings) as unknown as Env
    return handlers.handleRaw("submit", ({ request, params }) =>
      Effect.gen(function* () {
        const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie)
        const response = yield* Effect.promise(() => handleFormSubmit(web, env, params.id))
        return HttpServerResponse.fromWeb(response)
      }),
    )
  }),
)

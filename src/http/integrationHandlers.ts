import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { describeIntegrations } from "../domain/integrations.ts"
import { can } from "../domain/permissions.ts"
import { MailApi } from "./Api.ts"
import { infraDies } from "./addressHandlers.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

/** `GET /v1/integrations` (HAL-3466): anyone who reads settings sees it; key details need `keys.manage`. */
export const IntegrationsHandlers = HttpApiBuilder.group(
  MailApi,
  "integrations",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      get: p(({ request }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("read", "settings.read")
          return yield* describeIntegrations({
            origin: originOf(request),
            showKeys: can(caller, "keys.manage"),
          })
        }).pipe(infraDies),
      ),
    })
  }),
)

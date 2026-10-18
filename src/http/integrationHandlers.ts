import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { describeIntegrations } from "../domain/integrations.ts"
import { can } from "../domain/permissions.ts"
import { listGrants, revokeGrant } from "../oauth/grants.ts"
import { MailApi, NotFound } from "./Api.ts"
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
            principal: caller.member?.id ?? (caller.keyId === "root" ? "root" : null),
          })
        }).pipe(infraDies),
      ),
      revokeOAuthGrant: p(({ params }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("read", "settings.read")
          const grant = (yield* listGrants()).find((g) => g.id === params.id)
          const own =
            grant !== undefined && caller.member !== undefined && grant.grantedBy.id === caller.member.id
          if (!grant || (!can(caller, "keys.manage") && !own))
            return yield* new NotFound({ message: `No OAuth connection ${params.id}.` })
          yield* revokeGrant(grant.id, "revoked-in-settings", caller.keyId)
          return { id: grant.id, revoked: true as const }
        }).pipe(infraDies),
      ),
    })
  }),
)

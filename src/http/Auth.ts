import * as Context from "effect/Context"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity"
import * as Schema from "effect/Schema"
import type { Caller } from "../domain/apiKeys.ts"

export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()("mailyard/CurrentCaller") {}

/** Why a key was refused, so a sign-in screen can say which: not a key at all, unknown, or revoked. */
export const UnauthorizedReason = Schema.Literals([
  "missing",
  "format",
  "unknown",
  "revoked",
  "session-expired",
])

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {
    message: Schema.String,
    reason: Schema.optionalKey(UnauthorizedReason),
    /** When the key was revoked, for `reason: "revoked"`. */
    revokedAt: Schema.optionalKey(Schema.Number),
  },
  { httpApiStatus: 401 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    message: Schema.String,
    /** `public-key`: a pk_ key, which can only track. `insufficient-scope`: the key lacks `required`. */
    reason: Schema.optionalKey(Schema.Literals(["public-key", "insufficient-scope"])),
    required: Schema.optionalKey(Schema.String),
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    keyName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  },
  { httpApiStatus: 403 },
) {}

/** Too many failed attempts from one address: wait `retryAfter` seconds. */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { message: Schema.String, retryAfter: Schema.Number },
  { httpApiStatus: 429 },
) {}

/**
 * `Authorization: Bearer <key>`, where the key is a secret (sk_…), public (pk_…) or the deploy-time
 * ADMIN_KEY. Same header format as Plunk. Scopes are checked per endpoint.
 */
export class ApiKeyAuth extends HttpApiMiddleware.Service<
  ApiKeyAuth,
  { provides: CurrentCaller; requires: never }
>()("mailyard/ApiKeyAuth", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: [Unauthorized, RateLimited],
}) {}

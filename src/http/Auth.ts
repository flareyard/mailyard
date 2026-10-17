import * as Context from "effect/Context"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity"
import * as Schema from "effect/Schema"
import type { Caller } from "../domain/apiKeys.ts"

export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()("mailyard/CurrentCaller") {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
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
  error: Unauthorized,
}) {}

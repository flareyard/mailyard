import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import pkg from "../../package.json" with { type: "json" }
import { Database } from "../services/Database.ts"
import { MailApi, Unhealthy } from "./Api.ts"

export const SystemHandlers = HttpApiBuilder.group(
  MailApi,
  "system",
  Effect.fn(function* (handlers) {
    const database = yield* Database
    return handlers.handleAll({
      health: () =>
        database.ping.pipe(
          Effect.as({ status: "ok", app: "mailflare", version: pkg.version, database: "ok" } as const),
          Effect.catchTag("DatabaseError", (e) =>
            Effect.logError("health check: database unreachable", e.cause).pipe(
              Effect.andThen(Effect.fail(new Unhealthy({ database: "unreachable" }))),
            ),
          ),
        ),
    })
  }),
)

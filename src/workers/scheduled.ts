import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { watchEventCoverage } from "../domain/eventCoverage.ts"
import { runtimeFor } from "./inbound.ts"

/** The hourly cron: checks that every sending domain's delivery events are reaching Mailyard. */
export const handleScheduled = (env: Env) =>
  runtimeFor(env).runPromise(
    watchEventCoverage().pipe(
      Effect.tap((coverage) =>
        Effect.logInfo(
          `cron: delivery events ${coverage.map((c) => `${c.domain}=${c.status}`).join(", ") || "no sending domains"}`,
        ),
      ),
      Effect.catchCause((cause) => Effect.logError("cron: delivery-events watchdog failed", cause)),
      Effect.asVoid,
    ),
  )

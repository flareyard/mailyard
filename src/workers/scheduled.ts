import * as Effect from "effect/Effect"
import { sweepAutomations } from "../automations/runs.ts"
import type { Env } from "../Bindings.ts"
import { watchEventCoverage } from "../domain/eventCoverage.ts"
import { runtimeFor } from "./inbound.ts"

/**
 * The hourly cron: checks that every sending domain's delivery events are reaching Mailyard, and
 * sweeps automations (date triggers whose hour it is; segment triggers at 02:00 UTC).
 */
export const handleScheduled = (env: Env) =>
  runtimeFor(env).runPromise(
    sweepAutomations().pipe(
      Effect.tap((report) => Effect.logInfo(`cron: automations ${report.join(", ") || "nothing due"}`)),
      Effect.catchCause((cause) => Effect.logError("cron: automation sweep failed", cause)),
      Effect.andThen(watchEventCoverage()),
      Effect.tap((coverage) =>
        Effect.logInfo(
          `cron: delivery events ${coverage.map((c) => `${c.domain}=${c.status}`).join(", ") || "no sending domains"}`,
        ),
      ),
      Effect.catchCause((cause) => Effect.logError("cron: delivery-events watchdog failed", cause)),
      Effect.asVoid,
    ),
  )

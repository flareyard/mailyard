import * as Effect from "effect/Effect"
import { sweepAutomations } from "../automations/runs.ts"
import type { Env } from "../Bindings.ts"
import { sweepAlerts } from "../domain/alertSweep.ts"
import { pruneKeyUsage } from "../domain/apiKeys.ts"
import { watchEventCoverage } from "../domain/eventCoverage.ts"
import { pruneHourlyStats } from "../domain/insights.ts"
import { snapshotAudience } from "../domain/overview.ts"
import { pruneSessions } from "../domain/sessions.ts"
import { syncWithCloudflare } from "../domain/suppressions.ts"
import { runtimeFor } from "./inbound.ts"

/**
 * The hourly cron: checks that every sending domain's delivery events are reaching Mailyard, sweeps
 * automations (date triggers whose hour it is; segment triggers at 02:00 UTC), and syncs the
 * suppression list with Cloudflare's when Mailyard can read it, then sweeps the alerts whose
 * condition is a state (src/domain/alertSweep.ts).
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
      Effect.andThen(syncWithCloudflare()),
      Effect.tap((sync) =>
        Effect.logInfo(
          sync.connected
            ? `cron: suppressions synced, ${sync.adopted} adopted, ${sync.cloudflareOnly} Cloudflare-only${sync.error ? ` (${sync.error})` : ""}`
            : "cron: suppressions not synced (Cloudflare's list isn't readable)",
        ),
      ),
      Effect.catchCause((cause) => Effect.logError("cron: suppression sync failed", cause)),
      Effect.andThen(sweepAlerts()),
      Effect.tap((report) => Effect.logInfo(`cron: alerts ${report.join(", ")}`)),
      Effect.catchCause((cause) => Effect.logError("cron: alert sweep failed", cause)),
      Effect.andThen(snapshotAudience()),
      Effect.catchCause((cause) => Effect.logError("cron: audience snapshot failed", cause)),
      Effect.andThen(pruneKeyUsage()),
      Effect.andThen(pruneHourlyStats()),
      Effect.catchCause((cause) => Effect.logError("cron: key usage prune failed", cause)),
      Effect.andThen(pruneSessions()),
      Effect.catchCause((cause) => Effect.logError("cron: session prune failed", cause)),
      Effect.asVoid,
    ),
  )

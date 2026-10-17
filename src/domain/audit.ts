import { Effect } from "effect"
import { audit } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"

/**
 * Records a configuration change: who (an API key id, or `root`), what, and the before and after.
 * Never fails the change it records: a lost audit row is logged, not raised.
 */
export const recordAudit = (entry: {
  readonly actor: string
  readonly action: string
  readonly target: string
  readonly before?: unknown
  readonly after?: unknown
}) =>
  Effect.gen(function* () {
    const database = yield* Database
    const id = `aud_${yield* (yield* Ids).next}`
    yield* database.query("audit.insert", (db) =>
      db
        .insert(audit)
        .values({
          id,
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          before: entry.before ?? null,
          after: entry.after ?? null,
          at: Date.now(),
        })
        .run(),
    )
  }).pipe(Effect.catchCause((cause) => Effect.logError(`audit: could not record ${entry.action}`, cause)))

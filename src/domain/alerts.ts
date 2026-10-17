import { and, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { alerts } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"

export class AlertNotFound extends Schema.TaggedError<AlertNotFound>()("AlertNotFound", {
  id: Schema.String,
}) {}

type AlertRow = typeof alerts.$inferSelect

const describe = (a: AlertRow) => ({
  id: a.id,
  kind: a.kind,
  severity: a.severity,
  title: a.title,
  detail: a.detail,
  subject: a.subject ?? null,
  createdAt: a.createdAt,
  resolvedAt: a.resolvedAt,
  resolvedBy: a.resolvedBy,
})
export type AlertView = ReturnType<typeof describe>

/**
 * Opens an alert unless one is already open for the same `key`; a raise never fails what raised it.
 */
export const raiseAlert = (input: {
  readonly key: string
  readonly kind: string
  readonly severity: "info" | "warning" | "critical"
  readonly title: string
  readonly detail: string
  readonly subject?: { readonly type: string; readonly id: string } | null
}) =>
  Effect.gen(function* () {
    const database = yield* Database
    const open = yield* database.query("alerts.open", (db) =>
      db
        .select({ id: alerts.id })
        .from(alerts)
        .where(and(eq(alerts.key, input.key), isNull(alerts.resolvedAt)))
        .get(),
    )
    if (open) return open.id
    const id = `alr_${yield* (yield* Ids).next}`
    yield* database.query("alerts.insert", (db) =>
      db
        .insert(alerts)
        .values({
          id,
          key: input.key,
          kind: input.kind,
          severity: input.severity,
          title: input.title,
          detail: input.detail,
          subject: input.subject ?? null,
        })
        .run(),
    )
    return id
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(`alerts: could not raise ${input.key}`, cause).pipe(Effect.as(null)),
    ),
  )

/** Closes the open alert for `key`, if any: the condition it reported has cleared. */
export const clearAlert = (key: string, by: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.query("alerts.clear", (db) =>
      db
        .update(alerts)
        .set({ resolvedAt: Date.now(), resolvedBy: by })
        .where(and(eq(alerts.key, key), isNull(alerts.resolvedAt)))
        .run(),
    )
  }).pipe(Effect.catchCause((cause) => Effect.logError(`alerts: could not clear ${key}`, cause)))

export const listAlerts = Effect.fn("alerts.list")(function* (query: {
  readonly status?: "open" | "resolved" | "all" | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) {
  const database = yield* Database
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const status = query.status ?? "open"
  const [at, id] = query.cursor ? query.cursor.split(":") : []
  const rows = yield* database.query("alerts.list", (db) =>
    db
      .select()
      .from(alerts)
      .where(
        and(
          status === "open"
            ? isNull(alerts.resolvedAt)
            : status === "resolved"
              ? isNotNull(alerts.resolvedAt)
              : undefined,
          at && id
            ? or(lt(alerts.createdAt, Number(at)), and(eq(alerts.createdAt, Number(at)), lt(alerts.id, id)))
            : undefined,
        ),
      )
      .orderBy(desc(alerts.createdAt), desc(alerts.id))
      .limit(limit + 1)
      .all(),
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    alerts: page.map(describe),
    nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null,
  }
})

export const resolveAlert = Effect.fn("alerts.resolve")(function* (id: string, by: string) {
  const database = yield* Database
  const row = yield* database.query("alerts.get", (db) =>
    db.select().from(alerts).where(eq(alerts.id, id)).get(),
  )
  if (!row) return yield* new AlertNotFound({ id })
  if (row.resolvedAt !== null) return describe(row)
  const updated = yield* database.query("alerts.resolve", (db) =>
    db
      .update(alerts)
      .set({ resolvedAt: Date.now(), resolvedBy: by })
      .where(eq(alerts.id, id))
      .returning()
      .get(),
  )
  return describe(updated ?? row)
})

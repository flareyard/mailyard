import { and, count, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { alerts } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"

export class AlertNotFound extends Schema.TaggedError<AlertNotFound>()("AlertNotFound", {
  id: Schema.String,
}) {}

/**
 * Every alert Mailyard raises (HAL-3364), one name each. Each is raised by the event that causes it or
 * by the hourly sweep (src/domain/alertSweep.ts), and cleared when its condition clears; the notices
 * (`export_ready`, `domain_activated`, `import_failed`) clear themselves after a while.
 */
export const ALERT_KINDS = [
  "delivery_events_missing",
  "campaign_paused",
  "dns_drift",
  "reputation_warning",
  "reputation_at_risk",
  "bounce_spike",
  "complaint_spike",
  "quota_80",
  "quota_100",
  "webhook_dead_letter",
  "import_failed",
  "export_ready",
  "domain_activated",
  "automation_failed",
  "approval_pending",
] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

const HOUR = 3_600_000
/** Notices that clear on their own: an export's link lasts a day; the others are news for a week. */
export const AUTO_CLEAR: Partial<Record<AlertKind, number>> = {
  export_ready: 24 * HOUR,
  domain_activated: 7 * 24 * HOUR,
  import_failed: 7 * 24 * HOUR,
}

type AlertRow = typeof alerts.$inferSelect

const describe = (a: AlertRow) => ({
  id: a.id,
  kind: a.kind as AlertKind,
  severity: a.severity,
  title: a.title,
  detail: a.detail,
  subject: a.subject ?? null,
  count: a.count,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt ?? a.createdAt,
  resolvedAt: a.resolvedAt,
  resolvedBy: a.resolvedBy,
})
export type AlertView = ReturnType<typeof describe>

/**
 * Opens an alert, or, when one is already open for the same `key`, brings it up to date: the latest
 * title, detail and severity, and one more in `count` (or the count given). A raise never fails what
 * raised it.
 */
export const raiseAlert = (input: {
  readonly key: string
  readonly kind: AlertKind
  readonly severity: "info" | "warning" | "critical"
  readonly title: string
  readonly detail: string
  readonly subject?: { readonly type: string; readonly id: string } | null
  /** How many times it has happened, when the raiser knows (failed runs today, dead deliveries). */
  readonly count?: number | undefined
}) =>
  Effect.gen(function* () {
    const database = yield* Database
    const open = yield* database.query("alerts.open", (db) =>
      db
        .select({
          id: alerts.id,
          title: alerts.title,
          detail: alerts.detail,
          severity: alerts.severity,
          count: alerts.count,
        })
        .from(alerts)
        .where(and(eq(alerts.key, input.key), isNull(alerts.resolvedAt)))
        .get(),
    )
    if (open) {
      const next = input.count ?? open.count + 1
      // The sweep re-raises every hour; only a real change touches the row.
      if (
        next !== open.count ||
        open.title !== input.title ||
        open.detail !== input.detail ||
        open.severity !== input.severity
      )
        yield* database.query("alerts.refresh", (db) =>
          db
            .update(alerts)
            .set({
              title: input.title,
              detail: input.detail,
              severity: input.severity,
              count: input.count ?? sql`${alerts.count} + 1`,
              updatedAt: Date.now(),
            })
            .where(eq(alerts.id, open.id))
            .run(),
        )
      return open.id
    }
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
          count: input.count ?? 1,
          updatedAt: Date.now(),
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
  readonly kind?: AlertKind | undefined
  readonly severity?: "info" | "warning" | "critical" | undefined
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
          query.kind ? eq(alerts.kind, query.kind) : undefined,
          query.severity ? eq(alerts.severity, query.severity) : undefined,
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
  const open = yield* database.query("alerts.openCounts", (db) =>
    db
      .select({ severity: alerts.severity, n: count() })
      .from(alerts)
      .where(isNull(alerts.resolvedAt))
      .groupBy(alerts.severity)
      .all(),
  )
  const of = (s: string) => open.find((o) => o.severity === s)?.n ?? 0
  return {
    alerts: page.map(describe),
    open: {
      total: of("info") + of("warning") + of("critical"),
      critical: of("critical"),
      warning: of("warning"),
      info: of("info"),
    },
    nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null,
  }
})

/** Clears every open alert whose key starts with `prefix` and isn't in `keep`: a sweep's conditions that cleared. */
export const clearAlertsExcept = (prefix: string, keep: ReadonlySet<string>, by: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const open = yield* database.query("alerts.openByPrefix", (db) =>
      db
        .select({ key: alerts.key })
        .from(alerts)
        .where(
          and(
            isNull(alerts.resolvedAt),
            sql`${alerts.key} like ${`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} escape '\\'`,
          ),
        )
        .all(),
    )
    for (const a of open) if (!keep.has(a.key)) yield* clearAlert(a.key, by)
  }).pipe(Effect.catchCause((cause) => Effect.logError(`alerts: could not clear ${prefix}*`, cause)))

/** Clears the notices that have been open longer than their kind lasts (AUTO_CLEAR). */
export const expireNotices = (now = Date.now()) =>
  Effect.gen(function* () {
    const database = yield* Database
    for (const [kind, ttl] of Object.entries(AUTO_CLEAR))
      yield* database.query("alerts.expire", (db) =>
        db
          .update(alerts)
          .set({ resolvedAt: now, resolvedBy: "expired" })
          .where(
            and(eq(alerts.kind, kind), isNull(alerts.resolvedAt), lt(alerts.createdAt, now - (ttl ?? 0))),
          )
          .run(),
      )
  }).pipe(Effect.catchCause((cause) => Effect.logError("alerts: could not expire notices", cause)))

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

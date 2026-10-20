import { and, count, desc, eq, gte, inArray, lt, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import { dayKey } from "../campaigns/governor.ts"
import {
  alerts,
  apiKeys,
  audienceDaily,
  audit,
  contacts,
  events,
  inboundDaily,
  inboundDailySenders,
  mailboxes,
  mailboxMembers,
  mailboxPeople,
} from "../db/schema.ts"
import { seesAllMailboxes } from "../mail/access.ts"
import { callMailbox } from "../mail/rpc.ts"
import type { MailboxDO } from "../objects/MailboxDO.ts"
import { Database, queryIn } from "../services/Database.ts"
import type { Caller } from "./apiKeys.ts"
import { HOLDS_MAIL } from "./mailboxes.ts"
import { upstreamRejections } from "./routingAnalytics.ts"

/**
 * The Overview's read models (HAL-3362). Each read is bounded by its answer, not by the tables
 * (the database-design rule): measured rows read per call are on the issue.
 *
 * - Mail attention and response times ask each mailbox the caller can read; each mailbox answers
 *   from its own indexes (src/mailbox/store.ts).
 * - Inbound stats read closed days from `inbound_daily`, computed once the first time they're asked
 *   for, and only today live, through the received-at indexes.
 * - Audience counts come from the snapshot the hourly cron writes; only the in-range counts are
 *   read live, through indexes on when.
 * - Activity merges the newest of the audit log, alerts and bounce or complaint events, newest
 *   first, each read through its time index.
 */

export const RANGES = ["24h", "7d", "30d", "90d"] as const
export type StatsRange = (typeof RANGES)[number]
const DAYS: Record<StatsRange, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }
const DAY = 86_400_000
const startOfDay = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** The UTC days a range covers, oldest first, ending today. */
export const daysOf = (range: StatsRange, now = Date.now()) =>
  Array.from({ length: DAYS[range] }, (_, i) => dayKey(now - (DAYS[range] - 1 - i) * DAY))

/**
 * The mailboxes a caller can read: every one for root and admin keys and for people whose role
 * sees them all (HAL-3361), else the ones they've been given.
 */
export const readableMailboxes = Effect.fn("overview.mailboxes")(function* (caller: Caller) {
  const database = yield* Database
  const all = seesAllMailboxes(caller)
  const rows = all
    ? yield* database.query("overview.allMailboxes", (db) =>
        db
          .select({ id: mailboxes.id, address: mailboxes.address, kind: mailboxes.kind })
          .from(mailboxes)
          .all(),
      )
    : caller.member
      ? yield* database.query("overview.personMailboxes", (db) =>
          db
            .select({ id: mailboxes.id, address: mailboxes.address, kind: mailboxes.kind })
            .from(mailboxPeople)
            .innerJoin(mailboxes, eq(mailboxes.id, mailboxPeople.mailboxId))
            .where(eq(mailboxPeople.memberId, caller.keyId))
            .all(),
        )
      : caller.scopes.includes("read")
        ? yield* database.query("overview.memberMailboxes", (db) =>
            db
              .select({ id: mailboxes.id, address: mailboxes.address, kind: mailboxes.kind })
              .from(mailboxMembers)
              .innerJoin(mailboxes, eq(mailboxes.id, mailboxMembers.mailboxId))
              .where(eq(mailboxMembers.apiKeyId, caller.keyId))
              .all(),
          )
        : []
  return rows.filter((m) => HOLDS_MAIL.has(m.kind)).slice(0, 100)
})

/** Asks every readable mailbox at once; one that can't answer is listed as unavailable, not fatal. */
const askMailboxes = <A>(
  list: ReadonlyArray<{ readonly id: string; readonly address: string }>,
  ask: (stub: DurableObjectStub<MailboxDO>) => Promise<A>,
) =>
  Effect.forEach(
    list,
    (m) =>
      callMailbox(m.id, ask).pipe(
        Effect.map((value) => ({ mailbox: m, value: value as A | null })),
        Effect.catchCause((cause) =>
          Effect.logWarning(`overview: mailbox ${m.id} didn't answer`, cause).pipe(
            Effect.as({ mailbox: m, value: null as A | null }),
          ),
        ),
      ),
    { concurrency: 10 },
  )

// ---------------------------------------------------------------------------------------------
// Mail attention
// ---------------------------------------------------------------------------------------------

export const mailAttention = Effect.fn("overview.attention")(function* (
  caller: Caller,
  query: { readonly replyTargetHours?: number | undefined } = {},
) {
  const env = yield* Bindings
  const target = query.replyTargetHours ?? (Number(env.MAILYARD_REPLY_TARGET_HOURS) || 24)
  const now = Date.now()
  const endOfDay = startOfDay(dayKey(now)) + DAY
  const list = yield* readableMailboxes(caller)
  const answers = yield* askMailboxes(list, (s) =>
    s.attention({ olderThan: now - target * 3_600_000, until: endOfDay, assignee: caller.keyId }),
  )
  const ok = answers.filter((a) => a.value !== null) as Array<{
    mailbox: { id: string; address: string }
    value: {
      unread: number
      waitingForReply: number
      oldestWaitingAt: number | null
      snoozedReturning: number
      assignedToMe: number
    }
  }>
  const sum = (pick: (v: (typeof ok)[number]["value"]) => number) => ok.reduce((n, a) => n + pick(a.value), 0)
  const oldest = ok.map((a) => a.value.oldestWaitingAt).filter((x): x is number => x !== null)
  return {
    replyTargetHours: target,
    unread: ok
      .filter((a) => a.value.unread > 0)
      .map((a) => ({ mailboxId: a.mailbox.id, address: a.mailbox.address, count: a.value.unread }))
      .sort((a, b) => b.count - a.count),
    unreadTotal: sum((v) => v.unread),
    waitingForReply: sum((v) => v.waitingForReply),
    oldestWaitingAt: oldest.length ? Math.min(...oldest) : null,
    snoozedReturningToday: sum((v) => v.snoozedReturning),
    assignedToMe: sum((v) => v.assignedToMe),
    mailboxes: ok.map((a) => ({ mailboxId: a.mailbox.id, address: a.mailbox.address, ...a.value })),
    unavailable: answers.filter((a) => a.value === null).map((a) => a.mailbox.id),
  }
})

// ---------------------------------------------------------------------------------------------
// Response times
// ---------------------------------------------------------------------------------------------

export const responseTimes = Effect.fn("overview.responseTimes")(function* (
  caller: Caller,
  range: StatsRange,
) {
  const now = Date.now()
  const from = startOfDay(daysOf(range, now)[0] as string)
  const list = yield* readableMailboxes(caller)
  const answers = yield* askMailboxes(list, (s) => s.responseTimes({ from, to: now }))
  const keyIds = [
    ...new Set(
      answers.flatMap((a) =>
        (a.value ?? []).map((r) => r.assignee).filter((x): x is string => x !== null && x !== "root"),
      ),
    ),
  ]
  const database = yield* Database
  const names = new Map<string, string>()
  for (let i = 0; i < keyIds.length; i += 90) {
    const rows = yield* database.query("overview.keyNames", (db) =>
      db
        .select({ id: apiKeys.id, name: apiKeys.name })
        .from(apiKeys)
        .where(inArray(apiKeys.id, keyIds.slice(i, i + 90)))
        .all(),
    )
    for (const r of rows) names.set(r.id, r.name)
  }
  const minutes = (ms: number | null) => (ms === null ? null : Math.round(ms / 60_000))
  return {
    range,
    mailboxes: answers
      .filter((a) => a.value !== null)
      .map((a) => ({
        mailboxId: a.mailbox.id,
        address: a.mailbox.address,
        assignees: (a.value ?? []).map((r) => ({
          assigneeId: r.assignee,
          name:
            r.assignee === null
              ? null
              : r.assignee === "root"
                ? "Admin key"
                : (names.get(r.assignee) ?? r.assignee),
          threads: r.threads,
          answered: r.answered,
          firstResponseMedianMin: minutes(r.firstResponseMedianMs),
          firstResponseP90Min: minutes(r.firstResponseP90Ms),
          resolved: r.resolved,
          resolutionMedianHours:
            r.resolutionMedianMs === null ? null : Math.round((r.resolutionMedianMs / 3_600_000) * 10) / 10,
        })),
      })),
    unavailable: answers.filter((a) => a.value === null).map((a) => a.mailbox.id),
  }
})

// ---------------------------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------------------------

type DayCounts = {
  readonly workspace: { received: number; rejected: number; held: number }
  readonly byMailbox: ReadonlyMap<string, { received: number; spam: number }>
  readonly senders: ReadonlyArray<{ address: string; received: number }>
}

/** One day's counts straight from the ledgers, through their time indexes. */
const countDay = (from: number, to: number, senderLimit: number) =>
  Effect.gen(function* () {
    const { DB } = yield* Bindings
    const database = yield* Database
    const [statuses, deliveries, senders] = yield* database.query("overview.inboundDay", () =>
      DB.batch([
        DB.prepare(
          "select status, count(*) as n from inbound_messages where received_at >= ? and received_at < ? group by status",
        ).bind(from, to),
        DB.prepare(
          "select mailbox_id, count(*) as n, sum(folder = 'spam') as spam from inbound_deliveries where at >= ? and at < ? group by mailbox_id",
        ).bind(from, to),
        DB.prepare(
          `select lower(from_address) as address, count(*) as n from inbound_messages
           where received_at >= ? and received_at < ? and from_address is not null
           group by lower(from_address) order by n desc limit ?`,
        ).bind(from, to, senderLimit),
      ]),
    )
    const s = (statuses?.results ?? []) as Array<{ status: string; n: number }>
    const of = (st: string) => Number(s.find((r) => r.status === st)?.n ?? 0)
    return {
      workspace: {
        received: s.reduce((n, r) => n + Number(r.n), 0),
        rejected: of("rejected"),
        held: of("held"),
      },
      byMailbox: new Map(
        ((deliveries?.results ?? []) as Array<{ mailbox_id: string; n: number; spam: number | null }>).map(
          (r) => [r.mailbox_id, { received: Number(r.n), spam: Number(r.spam ?? 0) }],
        ),
      ),
      senders: ((senders?.results ?? []) as Array<{ address: string; n: number }>).map((r) => ({
        address: r.address,
        received: Number(r.n),
      })),
    } satisfies DayCounts
  })

/** Closed days come from inbound_daily; any not stored yet are counted once and stored. */
const closedDays = (days: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const database = yield* Database
    const out = new Map<string, DayCounts>()
    if (days.length === 0) return out
    const stored = yield* database.query("overview.inboundDaily", (db) =>
      db
        .select()
        .from(inboundDaily)
        // d1: bounded: a range is at most 90 days.
        .where(inArray(inboundDaily.day, [...days]))
        .all(),
    )
    const storedSenders = yield* database.query("overview.inboundDailySenders", (db) =>
      db
        .select()
        .from(inboundDailySenders)
        // d1: bounded: a range is at most 90 days.
        .where(inArray(inboundDailySenders.day, [...days]))
        .all(),
    )
    for (const day of new Set(stored.filter((r) => r.mailboxId === "").map((r) => r.day))) {
      const rows = stored.filter((r) => r.day === day)
      const ws = rows.find((r) => r.mailboxId === "")
      out.set(day, {
        workspace: { received: ws?.received ?? 0, rejected: ws?.rejected ?? 0, held: ws?.held ?? 0 },
        byMailbox: new Map(
          rows
            .filter((r) => r.mailboxId !== "")
            .map((r) => [r.mailboxId, { received: r.received, spam: r.spam }]),
        ),
        senders: storedSenders
          .filter((r) => r.day === day)
          .map((r) => ({ address: r.address, received: r.received })),
      })
    }
    const missing = days.filter((d) => !out.has(d))
    if (missing.length === 0) return out
    const { DB } = yield* Bindings
    const writes: Array<D1PreparedStatement> = []
    for (const day of missing) {
      const counts = yield* countDay(startOfDay(day), startOfDay(day) + DAY, 50)
      out.set(day, counts)
      writes.push(
        DB.prepare(
          "insert or replace into inbound_daily (day, mailbox_id, received, spam, rejected, held) values (?, '', ?, 0, ?, ?)",
        ).bind(day, counts.workspace.received, counts.workspace.rejected, counts.workspace.held),
        ...[...counts.byMailbox].map(([mailboxId, c]) =>
          DB.prepare(
            "insert or replace into inbound_daily (day, mailbox_id, received, spam, rejected, held) values (?, ?, ?, ?, 0, 0)",
          ).bind(day, mailboxId, c.received, c.spam),
        ),
        ...counts.senders.map((sender) =>
          DB.prepare(
            "insert or replace into inbound_daily_senders (day, address, received) values (?, ?, ?)",
          ).bind(day, sender.address, sender.received),
        ),
      )
    }
    for (let i = 0; i < writes.length; i += 100) {
      const part = writes.slice(i, i + 100)
      yield* database.query("overview.inboundDailyWrite", () => DB.batch(part))
    }
    return out
  })

export const inboundStats = Effect.fn("overview.inbound")(function* (range: StatsRange) {
  const now = Date.now()
  const days = daysOf(range, now)
  const today = dayKey(now)
  // 24h means the last 24 hours: yesterday's closed day plus today so far would double it, so it
  // reads its window live.
  const live =
    range === "24h" ? yield* countDay(now - DAY, now, 10) : yield* countDay(startOfDay(today), now, 50)
  const closed =
    range === "24h" ? new Map<string, DayCounts>() : yield* closedDays(days.filter((d) => d !== today))
  const all: Array<[string, DayCounts]> = [
    ...days
      .filter((d) => d !== today && closed.has(d))
      .map((d) => [d, closed.get(d) as DayCounts] as [string, DayCounts]),
    [today, live],
  ]
  const byMailbox = new Map<string, { received: number; spam: number }>()
  const senders = new Map<string, number>()
  let received = 0
  let rejected = 0
  let held = 0
  for (const [, c] of all) {
    received += c.workspace.received
    rejected += c.workspace.rejected
    held += c.workspace.held
    for (const [id, m] of c.byMailbox) {
      const cur = byMailbox.get(id) ?? { received: 0, spam: 0 }
      byMailbox.set(id, { received: cur.received + m.received, spam: cur.spam + m.spam })
    }
    for (const s of c.senders) senders.set(s.address, (senders.get(s.address) ?? 0) + s.received)
  }
  const database = yield* Database
  const ids = [...byMailbox.keys()]
  const addresses = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 90) {
    const rows = yield* database.query("overview.mailboxAddresses", (db) =>
      db
        .select({ id: mailboxes.id, address: mailboxes.address })
        .from(mailboxes)
        .where(inArray(mailboxes.id, ids.slice(i, i + 90)))
        .all(),
    )
    for (const r of rows) addresses.set(r.id, r.address)
  }
  const upstream = yield* upstreamRejections(days)
  return {
    range,
    received,
    rejected: {
      total: rejected,
      noSuchAddress: rejected,
      // Email Routing rejects DMARC, SPF and DKIM failures before mail reaches Mailyard; its analytics
      // count them (HAL-3393). No dimension names a blocklist, so `rbl` stays null.
      dmarcFail: upstream.dmarcFail,
      authFail: upstream.authFail,
      upstreamRejected: upstream.rejected,
      rbl: null,
      upstream: {
        connected: upstream.connected,
        reason: upstream.reason,
        zones: upstream.zones,
        from: upstream.from,
        ...(upstream.relay ? { relay: upstream.relay } : {}),
      },
    },
    held,
    spam: [...byMailbox.values()].reduce((n, m) => n + m.spam, 0),
    byMailbox: [...byMailbox]
      .map(([mailboxId, m]) => ({
        mailboxId,
        address: addresses.get(mailboxId) ?? null,
        received: m.received,
        spam: m.spam,
      }))
      .sort((a, b) => b.received - a.received),
    days: all.map(([day, c]) => ({
      day,
      received: c.workspace.received,
      rejected: c.workspace.rejected,
      spam: [...c.byMailbox.values()].reduce((n, m) => n + m.spam, 0),
    })),
    topSenders: [...senders]
      .map(([address, n]) => ({ address, received: n }))
      .sort((a, b) => b.received - a.received)
      .slice(0, 10),
    /** Top senders over closed days sum each day's 50 busiest, so a sender spread thinly may be undercounted. */
    topSendersEstimate: range !== "24h",
  }
})

// ---------------------------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------------------------

const STATUSES = ["subscribed", "unconfirmed", "unsubscribed", "bounced", "complained", "suppressed"] as const

/** Counts contacts by status and stores it as today's snapshot. Run by the hourly cron. */
export const snapshotAudience = Effect.fn("overview.snapshotAudience")(function* (now = Date.now()) {
  const database = yield* Database
  const rows = yield* database.query("overview.audienceCount", (db) =>
    db.select({ status: contacts.status, n: count() }).from(contacts).groupBy(contacts.status).all(),
  )
  const of = (s: string) => rows.find((r) => r.status === s)?.n ?? 0
  const value = {
    day: dayKey(now),
    total: rows.reduce((n, r) => n + r.n, 0),
    subscribed: of("subscribed"),
    unconfirmed: of("unconfirmed"),
    unsubscribed: of("unsubscribed"),
    bounced: of("bounced"),
    complained: of("complained"),
    suppressed: of("suppressed"),
    at: now,
  }
  yield* database.query("overview.audienceSave", (db) =>
    db
      .insert(audienceDaily)
      .values(value)
      .onConflictDoUpdate({ target: audienceDaily.day, set: value })
      .run(),
  )
  return value
})

export const audienceStats = Effect.fn("overview.audience")(function* (range: StatsRange) {
  const database = yield* Database
  const now = Date.now()
  const days = daysOf(range, now)
  const from = range === "24h" ? now - DAY : startOfDay(days[0] as string)
  const snapshots = yield* database.query("overview.audienceDays", (db) =>
    db
      .select()
      .from(audienceDaily)
      .where(gte(audienceDaily.day, days[0] as string))
      .orderBy(audienceDaily.day)
      .all(),
  )
  // No snapshot yet (a new install, or the cron hasn't run today): take one now.
  const latest =
    snapshots.at(-1)?.day === dayKey(now)
      ? (snapshots.at(-1) as typeof audienceDaily.$inferSelect)
      : yield* snapshotAudience(now)
  const { DB } = yield* Bindings
  const [created, unsubscribed, suppressed] = yield* database.query("overview.audienceRange", () =>
    DB.batch([
      DB.prepare("select count(*) as n from contacts where created_at >= ?").bind(from),
      DB.prepare(
        "select count(distinct contact_id) as n from events where name = 'email.unsubscribed' and at >= ?",
      ).bind(from),
      DB.prepare("select count(*) as n from suppressions where at >= ?").bind(from),
    ]),
  )
  const n = (r: D1Result | undefined) => Number((r?.results?.[0] as { n?: number } | undefined)?.n ?? 0)
  const byDay = new Map(snapshots.map((s) => [s.day, s.total]))
  byDay.set(latest.day, latest.total)
  return {
    range,
    asOf: latest.at,
    total: latest.total,
    byStatus: Object.fromEntries(STATUSES.map((s) => [s, latest[s]])) as Record<
      (typeof STATUSES)[number],
      number
    >,
    new: n(created),
    unsubscribed: n(unsubscribed),
    suppressed: n(suppressed),
    totalByDay: days.map((day) => ({ day, total: byDay.get(day) ?? null })),
  }
})

// ---------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------

const PAST: Record<string, string> = {
  create: "created",
  created: "created",
  update: "updated",
  updated: "updated",
  delete: "deleted",
  deleted: "deleted",
  schedule: "scheduled",
  pause: "paused",
  resume: "resumed",
  cancel: "cancelled",
  publish: "published",
  resend: "resent to non-openers",
  import: "import started",
  imported: "import finished",
  export: "export started",
  started: "started",
  cancelled: "cancelled",
  erase: "erased",
  add: "added",
  remove: "removed",
  push: "pushed to Cloudflare",
  adopt: "adopted from Cloudflare",
  members: "members changed",
  reordered: "reordered",
  retry: "retried",
  exit: "ended",
  sending: "sending settings changed",
  compliance: "compliance settings changed",
}
const NOUN: Record<string, string> = {
  campaign: "Campaign",
  automation: "Automation",
  contact: "Contact",
  contacts: "Contacts",
  segment: "Segment",
  topic: "Topic",
  form: "Form",
  domain: "Domain",
  mailbox: "Mailbox",
  rule: "Inbox rule",
  suppression: "Suppression",
  suppressions: "Suppressions",
  settings: "Settings",
  template: "Template",
  webhook: "Webhook",
  import: "Mailbox import",
  export: "Export",
}

const labelOf = (value: unknown) => {
  const v = value as Record<string, unknown> | null
  const pick = v?.name ?? v?.email ?? v?.address ?? v?.subject
  return typeof pick === "string" ? pick : null
}

type Item = {
  id: string
  kind: string
  text: string
  subject: { type: string; id: string; label: string | null } | null
  actor: { type: "key" | "system"; id: string; name: string | null } | null
  at: number
}

export const activity = Effect.fn("overview.activity")(function* (query: {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) {
  const database = yield* Database
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 100)
  const [cAt, cId] = query.cursor ? query.cursor.split(":") : []
  const before = cAt && cId ? { at: Number(cAt), id: cId } : null
  const older = (
    atCol: typeof audit.at | typeof alerts.createdAt | typeof events.at,
    idCol: typeof audit.id | typeof alerts.id | typeof events.id,
  ) => (before ? or(lt(atCol, before.at), and(eq(atCol, before.at), lt(idCol, before.id))) : undefined)

  const auditRows = yield* database.query("overview.activityAudit", (db) =>
    db
      .select()
      .from(audit)
      .where(older(audit.at, audit.id))
      .orderBy(desc(audit.at), desc(audit.id))
      .limit(limit + 1)
      .all(),
  )
  const alertRows = yield* database.query("overview.activityAlerts", (db) =>
    db
      .select()
      .from(alerts)
      .where(older(alerts.createdAt, alerts.id))
      .orderBy(desc(alerts.createdAt), desc(alerts.id))
      .limit(limit + 1)
      .all(),
  )
  const eventRows = yield* database.query("overview.activityEvents", (db) =>
    db
      .select({
        id: events.id,
        name: events.name,
        contactId: events.contactId,
        at: events.at,
        email: contacts.email,
      })
      .from(events)
      .innerJoin(contacts, eq(contacts.id, events.contactId))
      .where(and(inArray(events.name, ["email.bounced", "email.complained"]), older(events.at, events.id)))
      .orderBy(desc(events.at), desc(events.id))
      .limit(limit + 1)
      .all(),
  )

  const items: Array<Item> = [
    ...auditRows.map((r) => {
      const [type = "workspace", verb = ""] = r.action.split(".")
      const tail = r.action.split(".").slice(1).join(".")
      const label = labelOf(r.after) ?? labelOf(r.before)
      const noun = NOUN[type] ?? type
      return {
        id: r.id,
        kind: `audit.${r.action}`,
        text: `${noun}${label ? ` "${label}"` : ""} ${PAST[tail] ?? PAST[verb] ?? tail.replace(/[._]/g, " ")}`,
        subject: r.target ? { type, id: r.target, label } : null,
        actor:
          r.actor === "system" || r.actor === "sweep"
            ? { type: "system" as const, id: r.actor, name: "Mailyard" }
            : { type: "key" as const, id: r.actor, name: null },
        at: r.at,
      }
    }),
    ...alertRows.map((r) => ({
      id: r.id,
      kind: `alert.${r.kind}`,
      text: r.title,
      subject: r.subject ? { type: r.subject.type, id: r.subject.id, label: null } : null,
      actor: { type: "system" as const, id: "alerts", name: "Mailyard" },
      at: r.createdAt,
    })),
    ...eventRows.map((r) => ({
      id: r.id,
      kind: r.name,
      text:
        r.name === "email.complained" ? `${r.email} marked a message as spam` : `Mail to ${r.email} bounced`,
      subject: { type: "contact", id: r.contactId, label: r.email },
      actor: null,
      at: r.at,
    })),
  ].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

  const page = items.slice(0, limit)
  // Names for the keys that acted, one indexed lookup for the page.
  const keyIds = [
    ...new Set(page.flatMap((i) => (i.actor?.type === "key" && i.actor.id !== "root" ? [i.actor.id] : []))),
  ]
  const names = new Map<string, string>()
  if (keyIds.length > 0) {
    const rows = yield* queryIn("overview.activityKeys", keyIds, (db, chunk) =>
      db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).where(inArray(apiKeys.id, chunk)).all(),
    )
    for (const r of rows) names.set(r.id, r.name)
  }
  for (const i of page)
    if (i.actor?.type === "key")
      i.actor = { ...i.actor, name: i.actor.id === "root" ? "Admin key" : (names.get(i.actor.id) ?? null) }
  const last = page.at(-1)
  return {
    events: page,
    nextCursor: items.length > limit && last ? `${last.at}:${last.id}` : null,
  }
})

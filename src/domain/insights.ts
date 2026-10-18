import { and, eq, gte, lt, sql } from "drizzle-orm"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Bindings } from "../Bindings.ts"
import {
  dailyStats,
  deferralDaily,
  deliveryTimes,
  domains,
  hourlyStats,
  webhookDeliveries,
} from "../db/schema.ts"
import { CloudflareEmail } from "../services/CloudflareEmail.ts"
import { Database } from "../services/Database.ts"
import { eventCoverage } from "./eventCoverage.ts"

/**
 * Email Service pricing, measured 2026-10-16 (developers.cloudflare.com/email-service/platform/pricing):
 * 3,000 outbound emails a month included on Workers Paid, then $0.35 per 1,000. Hard bounces count;
 * sends refused at the API (suppressed) don't.
 */
export const PRICING = { includedPerMonth: 3000, usdPerThousand: 0.35, measuredAt: "2026-10-16" } as const

/**
 * Thresholds to judge rates against when the account's own policy can't be read. These are the values
 * Cloudflare returned for the founder's account on 2026-10-16; each account's policy may differ, so the
 * response says which source it used.
 */
export const FALLBACK_POLICY = {
  customer_bounce: { warning_at: 0.02, at_risk_at: 0.05, minimum_denominator: 100 },
  complaint: { warning_at: 0.001, at_risk_at: 0.002, minimum_denominator: 100 },
  spam_rejection: { warning_at: 0.01, at_risk_at: 0.03, minimum_denominator: 100 },
  suspension_after_hours: 168,
} as const

export type Range = "24h" | "7d" | "30d"
const DAYS: Record<Range, number> = { "24h": 1, "7d": 7, "30d": 30 }

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)
/** First UTC day included in a range ending today. */
export const since = (range: Range, now = Date.now()) => dayKey(now - (DAYS[range] - 1) * 86_400_000)

const sum = (column: AnySQLiteColumn) => sql<number>`coalesce(sum(${column}), 0)`

const totalsSince = (from: string, extra?: ReturnType<typeof eq>) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("stats.totals", (db) =>
      db
        .select({
          sent: sum(dailyStats.sent),
          delivered: sum(dailyStats.delivered),
          deferred: sum(dailyStats.deferred),
          bouncedHard: sum(dailyStats.bouncedHard),
          bouncedSoft: sum(dailyStats.bouncedSoft),
          complained: sum(dailyStats.complained),
          rejected: sum(dailyStats.rejected),
          failed: sum(dailyStats.failed),
        })
        .from(dailyStats)
        .where(and(gte(dailyStats.day, from), extra))
        .get(),
    )
    return {
      sent: row?.sent ?? 0,
      delivered: row?.delivered ?? 0,
      deferred: row?.deferred ?? 0,
      bouncedHard: row?.bouncedHard ?? 0,
      bouncedSoft: row?.bouncedSoft ?? 0,
      complained: row?.complained ?? 0,
      rejected: row?.rejected ?? 0,
      failed: row?.failed ?? 0,
    }
  })

type Totals = Effect.Success<ReturnType<typeof totalsSince>>

/**
 * Rates as fractions, or null under the policy's minimum volume (100 sends): a single bounce in five
 * sends is a 20% bounce rate that means nothing. Bounces and spam rejections are measured against
 * sends; complaints against deliveries.
 */
export const ratesOf = (t: Totals, minimum = 100) => {
  const enough = t.sent >= minimum
  const bounced = t.bouncedHard + t.bouncedSoft
  return {
    insufficientData: !enough,
    minimumSends: minimum,
    bounceRate: enough ? bounced / t.sent : null,
    complaintRate: enough && t.delivered > 0 ? t.complained / t.delivered : enough ? 0 : null,
    rejectionRate: enough ? t.rejected / t.sent : null,
    deliveryRate: enough ? t.delivered / t.sent : null,
  }
}

/** Upper bounds of the delivery-time buckets (migration 0031's trigger uses the same ones); the last is open. */
export const DELIVERY_BUCKETS_MS = [
  1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 10_800_000,
  21_600_000, 86_400_000,
] as const

/**
 * The median and 95th percentile from the histogram, to the bucket: each is the upper bound of the
 * bucket it falls in (null in the last, open one: a day or more). Null with no deliveries.
 */
export const quantilesOf = (counts: ReadonlyArray<number>) => {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return { medianMs: null, p95Ms: null, samples: 0 }
  const at = (q: number) => {
    let seen = 0
    for (let i = 0; i < counts.length; i++) {
      seen += counts[i] ?? 0
      if (seen >= q * total) return DELIVERY_BUCKETS_MS[i] ?? null
    }
    return null
  }
  return { medianMs: at(0.5), p95Ms: at(0.95), samples: total }
}

const deliveryTime = (from: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const rows = yield* database.query("stats.deliveryTimes", (db) =>
      db
        .select({ bucket: deliveryTimes.bucket, n: sum(deliveryTimes.n) })
        .from(deliveryTimes)
        .where(gte(deliveryTimes.day, from))
        .groupBy(deliveryTimes.bucket)
        .all(),
    )
    const counts = Array.from({ length: DELIVERY_BUCKETS_MS.length + 1 }, (_, i) =>
      Number(rows.find((r) => r.bucket === i)?.n ?? 0),
    )
    return {
      ...quantilesOf(counts),
      approximate: true as const,
      buckets: counts.map((n, i) => ({ underMs: DELIVERY_BUCKETS_MS[i] ?? null, n })),
    }
  })

export const deliveryStats = Effect.fn("insights.delivery")(function* (range: Range, by?: "day") {
  const from = since(range)
  const totals = yield* totalsSince(from)
  const time = yield* deliveryTime(from)
  if (by !== "day") return { range, from, totals, rates: ratesOf(totals), deliveryTime: time, days: [] }
  const database = yield* Database
  const rows = yield* database.query("stats.deliveryByDay", (db) =>
    db
      .select({
        day: dailyStats.day,
        sent: sum(dailyStats.sent),
        delivered: sum(dailyStats.delivered),
        deferred: sum(dailyStats.deferred),
        bouncedHard: sum(dailyStats.bouncedHard),
        bouncedSoft: sum(dailyStats.bouncedSoft),
        complained: sum(dailyStats.complained),
        rejected: sum(dailyStats.rejected),
        failed: sum(dailyStats.failed),
      })
      .from(dailyStats)
      .where(gte(dailyStats.day, from))
      .groupBy(dailyStats.day)
      .all(),
  )
  const zero = {
    sent: 0,
    delivered: 0,
    deferred: 0,
    bouncedHard: 0,
    bouncedSoft: 0,
    complained: 0,
    rejected: 0,
    failed: 0,
  }
  const days: Array<string> = []
  for (let i = DAYS[range] - 1; i >= 0; i--) days.push(dayKey(Date.now() - i * 86_400_000))
  return {
    range,
    from,
    totals,
    rates: ratesOf(totals),
    deliveryTime: time,
    days: days.map((day) => {
      const r = rows.find((x) => x.day === day)
      const t = r
        ? {
            sent: Number(r.sent),
            delivered: Number(r.delivered),
            deferred: Number(r.deferred),
            bouncedHard: Number(r.bouncedHard),
            bouncedSoft: Number(r.bouncedSoft),
            complained: Number(r.complained),
            rejected: Number(r.rejected),
            failed: Number(r.failed),
          }
        : zero
      return { day, totals: t, rates: ratesOf(t) }
    }),
  }
})

/** `GET /v1/stats/deferrals`: why mail was deferred, most common first. */
export const deferralStats = Effect.fn("insights.deferrals")(function* (range: Range) {
  const database = yield* Database
  const rows = yield* database.query("stats.deferrals", (db) =>
    db
      .select({
        reason: deferralDaily.reason,
        smtpStatus: deferralDaily.smtpStatus,
        provider: deferralDaily.provider,
        count: sum(deferralDaily.n),
      })
      .from(deferralDaily)
      .where(gte(deferralDaily.day, since(range)))
      .groupBy(deferralDaily.reason, deferralDaily.smtpStatus, deferralDaily.provider)
      .orderBy(sql`sum(${deferralDaily.n}) desc`)
      .limit(50)
      .all(),
  )
  return {
    range,
    reasons: rows.map((r) => ({
      reason: r.reason,
      smtpStatus: r.smtpStatus || null,
      provider: r.provider || null,
      count: Number(r.count),
    })),
  }
})

/** The governor's four streams, the keys every byStream carries (HAL-3419). */
export const STREAMS = ["transactional", "campaign", "automation", "mailbox"] as const
export type Stream = (typeof STREAMS)[number]

/** Rollup stream names onto the four: a reply is mailbox mail; tests and other apps' mail aren't charted. */
const streamOf = (raw: string): Stream | null =>
  raw === "reply" ? "mailbox" : (STREAMS as ReadonlyArray<string>).includes(raw) ? (raw as Stream) : null

const emptyStreams = (): Record<Stream, number> => ({
  transactional: 0,
  campaign: 0,
  automation: 0,
  mailbox: 0,
})

const HOUR = 3_600_000

export const volumeStats = Effect.fn("insights.volume")(function* (range: Range, by: "day" | "hour" = "day") {
  const database = yield* Database
  if (by === "hour") {
    // The last 24 hours, the current one included, from hourly_stats.
    const now = Math.floor(Date.now() / HOUR)
    const rows = yield* database.query("stats.volumeHourly", (db) =>
      db
        .select({ hour: hourlyStats.hour, stream: hourlyStats.stream, sent: sum(hourlyStats.sent) })
        .from(hourlyStats)
        .where(gte(hourlyStats.hour, now - 23))
        .groupBy(hourlyStats.hour, hourlyStats.stream)
        .all(),
    )
    const hours = Array.from({ length: 24 }, (_, i) => now - 23 + i).map((h) => {
      const byStream = emptyStreams()
      for (const r of rows) {
        const stream = r.hour === h ? streamOf(r.stream) : null
        if (stream) byStream[stream] += Number(r.sent ?? 0)
      }
      return { hour: new Date(h * HOUR).toISOString(), byStream }
    })
    return { range: "24h" as const, by, days: [], hours, streams: [...STREAMS] }
  }
  const rows = yield* database.query("stats.volume", (db) =>
    db
      .select({ day: dailyStats.day, stream: dailyStats.stream, sent: sum(dailyStats.sent) })
      .from(dailyStats)
      .where(gte(dailyStats.day, since(range)))
      .groupBy(dailyStats.day, dailyStats.stream)
      .orderBy(dailyStats.day)
      .all(),
  )
  // Every day in the range appears, zeros included, so a chart has no gaps.
  const days: Array<string> = []
  for (let i = DAYS[range] - 1; i >= 0; i--) days.push(dayKey(Date.now() - i * 86_400_000))
  return {
    range,
    by,
    days: days.map((day) => {
      const byStream = emptyStreams()
      for (const r of rows) {
        const stream = r.day === day ? streamOf(r.stream) : null
        if (stream) byStream[stream] += Number(r.sent ?? 0)
      }
      return { day, byStream }
    }),
    hours: [],
    streams: [...STREAMS],
  }
})

/**
 * Sends of one campaign in the trailing hour: this hour's count plus the part of the last hour still
 * inside the window. A rate, not a promise: the governor sets the pace.
 */
export const campaignRatePerHour = Effect.fn("insights.campaignRate")(function* (campaignId: string) {
  const database = yield* Database
  const nowMs = Date.now()
  const now = Math.floor(nowMs / HOUR)
  const rows = yield* database.query("stats.campaignRate", (db) =>
    db
      .select({ hour: hourlyStats.hour, sent: sum(hourlyStats.sent) })
      .from(hourlyStats)
      .where(and(eq(hourlyStats.campaignId, campaignId), gte(hourlyStats.hour, now - 1)))
      .groupBy(hourlyStats.hour)
      .all(),
  )
  const current = Number(rows.find((r) => r.hour === now)?.sent ?? 0)
  const previous = Number(rows.find((r) => r.hour === now - 1)?.sent ?? 0)
  const intoHour = (nowMs - now * HOUR) / HOUR
  return Math.round(current + previous * (1 - intoHour))
})

/** Hourly: hourly_stats older than 8 days goes. */
export const pruneHourlyStats = Effect.fn("insights.pruneHourly")(function* () {
  const database = yield* Database
  yield* database.query("stats.pruneHourly", (db) =>
    db
      .delete(hourlyStats)
      .where(lt(hourlyStats.hour, Math.floor(Date.now() / HOUR) - 8 * 24))
      .run(),
  )
})

export const providerStats = Effect.fn("insights.providers")(function* (range: Range) {
  const database = yield* Database
  const rows = yield* database.query("stats.providers", (db) =>
    db
      .select({
        provider: dailyStats.provider,
        delivered: sum(dailyStats.delivered),
        deferred: sum(dailyStats.deferred),
        bounced: sql<number>`coalesce(sum(${dailyStats.bouncedHard}) + sum(${dailyStats.bouncedSoft}), 0)`,
        complained: sum(dailyStats.complained),
      })
      .from(dailyStats)
      .where(and(gte(dailyStats.day, since(range)), sql`${dailyStats.provider} != ''`))
      .groupBy(dailyStats.provider)
      .all(),
  )
  return {
    range,
    providers: rows
      .map((r) => ({ ...r, total: r.delivered + r.bounced + r.deferred }))
      .sort((a, b) => b.total - a.total),
  }
})

/** Sends billed this calendar month (UTC), and today's against the daily quota if Cloudflare is connected. */
export const usage = Effect.fn("insights.usage")(function* () {
  const now = new Date()
  const monthStart = `${now.toISOString().slice(0, 7)}-01`
  const today = dayKey(now.getTime())
  const month = yield* totalsSince(monthStart)
  const todays = yield* totalsSince(today)
  const cloudflare = yield* CloudflareEmail
  const limits = yield* cloudflare.limits

  // Billed: everything Email Service accepted, which is what we counted as sent.
  const billed = month.sent
  const dayOfMonth = now.getUTCDate()
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const projected = Math.round((billed / dayOfMonth) * daysInMonth)
  const cost = (n: number) => Math.max(0, n - PRICING.includedPerMonth) * (PRICING.usdPerThousand / 1000)

  return {
    today: Option.match(limits, {
      onNone: () => ({
        sent: todays.sent,
        quota: null,
        remaining: null,
        overQuota: null,
        resetsAt: null,
        source: cloudflare.connected ? ("cloudflare-unreachable" as const) : ("not-connected" as const),
      }),
      onSome: (l) => ({
        sent: l.usage.sent,
        quota: l.quota.value,
        remaining: Math.max(0, l.quota.value - l.usage.sent),
        overQuota: l.usage.over_quota,
        resetsAt: l.usage.resets_at,
        source: "cloudflare" as const,
      }),
    }),
    month: {
      from: monthStart,
      billed,
      included: PRICING.includedPerMonth,
      overage: Math.max(0, billed - PRICING.includedPerMonth),
      costUsd: Number(cost(billed).toFixed(2)),
      projectedBilled: projected,
      projectedCostUsd: Number(cost(projected).toFixed(2)),
    },
    pricing: PRICING,
  }
})

/** How long `recipients` sends take at today's quota. Without a known quota there's no honest answer. */
export const forecast = Effect.fn("insights.forecast")(function* (recipients: number) {
  const u = yield* usage()
  if (u.today.quota === null || u.today.remaining === null) {
    return {
      recipients,
      possible: false as const,
      reason: "The daily quota is unknown: connect a read-only Cloudflare token.",
    }
  }
  const quota = u.today.quota
  const today = Math.min(recipients, u.today.remaining)
  const rest = recipients - today
  const extraDays = Math.ceil(rest / quota)
  const now = new Date()
  const finishDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + extraDays))
  return {
    recipients,
    possible: true as const,
    quota,
    sendableToday: today,
    additionalDays: extraDays,
    finishesBy: extraDays === 0 ? null : finishDay.toISOString().slice(0, 10),
    cost: {
      billedAfter: u.month.billed + recipients,
      extraUsd: Number(
        (
          (Math.max(0, u.month.billed + recipients - PRICING.includedPerMonth) -
            Math.max(0, u.month.billed - PRICING.includedPerMonth)) *
          (PRICING.usdPerThousand / 1000)
        ).toFixed(2),
      ),
    },
  }
})

const level = (rate: number | null, t: { warning_at: number; at_risk_at: number }) =>
  rate === null
    ? ("insufficient-data" as const)
    : rate >= t.at_risk_at
      ? ("at-risk" as const)
      : rate >= t.warning_at
        ? ("warning" as const)
        : ("ok" as const)

/** Cloudflare's verdict when connected, and our own 30-day rates against the thresholds either way. */
export const reputation = Effect.fn("insights.reputation")(function* () {
  const cloudflare = yield* CloudflareEmail
  const remote = yield* cloudflare.reputation
  const policy = Option.match(remote, { onNone: () => FALLBACK_POLICY, onSome: (r) => r.active_policy })
  const totals = yield* totalsSince(since("30d"))
  const rates = ratesOf(totals, policy.customer_bounce.minimum_denominator)
  return {
    status: Option.match(remote, { onNone: () => null, onSome: (r) => r.status }),
    statusSince: Option.match(remote, { onNone: () => null, onSome: (r) => r.status_since }),
    graceStartedAt: Option.match(remote, { onNone: () => null, onSome: (r) => r.grace_started_at }),
    evaluatedAt: Option.match(remote, { onNone: () => null, onSome: (r) => r.evaluated_at }),
    source: Option.isSome(remote) ? ("cloudflare" as const) : ("not-connected" as const),
    policySource: Option.isSome(remote) ? ("account" as const) : ("measured-2026-10-16" as const),
    policy,
    window: "30d" as const,
    totals,
    rates,
    levels: {
      bounce: level(rates.bounceRate, policy.customer_bounce),
      complaint: level(rates.complaintRate, policy.complaint),
      spamRejection: level(rates.rejectionRate, policy.spam_rejection),
    },
  }
})

type Check = { name: string; status: "ok" | "warn" | "fail" | "unknown"; detail: string }

/** The Overview's health strip: each thing that has to be true for mail to flow. */
export const health = Effect.fn("insights.health")(function* () {
  const env = yield* Bindings
  const database = yield* Database
  const checks: Array<Check> = []

  const db = yield* database.ping.pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
  checks.push({
    name: "database",
    status: db ? "ok" : "fail",
    detail: db ? "D1 reachable." : "D1 unreachable.",
  })

  const sender =
    env.MAILYARD_SENDER === "memory"
      ? ({ status: "warn", detail: "In-memory sender: nothing leaves this Worker." } as const)
      : env.EMAIL
        ? ({ status: "ok", detail: "Email Service binding present." } as const)
        : ({ status: "fail", detail: "No send_email binding." } as const)
  checks.push({ name: "sending", ...sender })

  const domainRows = yield* database.query("health.domains", (d) =>
    d
      .select({ name: domains.name, sending: domains.sendingEnabled, routing: domains.routingEnabled })
      .from(domains)
      .all(),
  )
  checks.push(
    domainRows.length === 0
      ? { name: "domains", status: "unknown", detail: "No domain set up in Mailyard yet." }
      : {
          name: "domains",
          status: domainRows.every((d) => d.sending) ? "ok" : "warn",
          detail: `${domainRows.filter((d) => d.sending).length} of ${domainRows.length} domains can send.`,
        },
  )

  const coverage = yield* eventCoverage()
  const silent = coverage.filter((c) => c.status === "warn")
  checks.push(
    coverage.length === 0
      ? { name: "delivery_events", status: "unknown", detail: "No sending domain yet." }
      : silent.length > 0
        ? {
            name: "delivery_events",
            status: "fail",
            detail: silent.map((c) => c.detail).join(" "),
          }
        : coverage.every((c) => c.status === "ok")
          ? {
              name: "delivery_events",
              status: "ok",
              detail: `Delivery events reach Mailyard for ${coverage.length === 1 ? coverage[0]?.domain : `all ${coverage.length} sending domains`}.`,
            }
          : {
              name: "delivery_events",
              status: "unknown",
              detail: coverage.find((c) => c.status === "unknown")?.detail ?? "",
            },
  )

  const rep = yield* reputation()
  const worst = (["at-risk", "warning"] as const).find((l) => Object.values(rep.levels).includes(l))
  checks.push({
    name: "reputation",
    status:
      rep.status === "at_risk" || worst === "at-risk"
        ? "fail"
        : worst === "warning"
          ? "warn"
          : rep.source === "cloudflare"
            ? "ok"
            : "unknown",
    detail: rep.status
      ? `Cloudflare says ${rep.status}.`
      : "Cloudflare reputation not connected; judged on our own rates.",
  })

  const u = yield* usage()
  checks.push(
    u.today.quota === null
      ? { name: "quota", status: "unknown", detail: `${u.today.sent} sent today; quota not connected.` }
      : {
          name: "quota",
          status: u.today.overQuota ? "fail" : (u.today.remaining ?? 0) < u.today.quota * 0.2 ? "warn" : "ok",
          detail: `${u.today.sent} of ${u.today.quota} sent today.`,
        },
  )

  const dead = yield* database.query("health.deadWebhooks", (d) =>
    d
      .select({ n: sql<number>`count(*)` })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.status, "dead"))
      .get(),
  )
  checks.push(
    (dead?.n ?? 0) > 0
      ? {
          name: "webhooks",
          status: "warn",
          detail: `${dead?.n} webhook deliveries failed for good; replay them.`,
        }
      : { name: "webhooks", status: "ok", detail: "No failed webhook deliveries." },
  )

  const status: "ok" | "warn" | "fail" = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok"
  return { status, checks, checkedAt: new Date().toISOString() }
})

import { and, eq, gte, sql } from "drizzle-orm"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { Effect, Option } from "effect"
import { Bindings } from "../Bindings.ts"
import { dailyStats, domains, webhookDeliveries } from "../db/schema.ts"
import { CloudflareEmail } from "../services/CloudflareEmail.ts"
import { Database } from "../services/Database.ts"

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
const since = (range: Range, now = Date.now()) => dayKey(now - (DAYS[range] - 1) * 86_400_000)

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

export const deliveryStats = Effect.fn("insights.delivery")(function* (range: Range) {
  const totals = yield* totalsSince(since(range))
  return { range, from: since(range), totals, rates: ratesOf(totals) }
})

export const volumeStats = Effect.fn("insights.volume")(function* (range: Range) {
  const database = yield* Database
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
  const streams = [...new Set(rows.map((r) => r.stream))].sort()
  return {
    range,
    days: days.map((day) => ({
      day,
      byStream: Object.fromEntries(
        streams.map((s) => [s, rows.find((r) => r.day === day && r.stream === s)?.sent ?? 0]),
      ),
    })),
    streams,
  }
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

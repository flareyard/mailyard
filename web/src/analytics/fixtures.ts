/**
 * Fixture-mode overrides for Analytics (registered in src/fixtures/overrides.ts), typed against the generated
 * schema so a contract change breaks them at compile time.
 *
 * The design fixtures hold partial bodies for several stats routes (a screen embeds `deliveryTime` alone under
 * the same path), so every Analytics route answers here from generated, deterministic data on the design clock
 * (17 Oct 2026, 17:48 UTC). A page's `?fx=` picks a designed state:
 *   collecting       delivery time and deferral reasons empty (production's first day, 18 Oct)
 *   not-enough-data  62 sends in the range, rates withheld and charts hatched
 *   error            GET /v1/stats/providers answers 500
 *   csv-blocked      signed in with an admin-only key (no read): every CSV control is off
 *   viewer           signed in as a viewer (Analytics is read-only for everyone)
 *   quota-unknown    usage.today.source is cloudflare-unreachable; the forecast can't plan days
 *   unavailable      support@'s mailbox store didn't answer the response-times read
 *   upstream         Email Routing's analytics are read (CLOUDFLARE_ANALYTICS_TOKEN set): DMARC, auth and RBL counts
 */
import type { Json, Override } from "../fixtures/overrides.ts"

type Delivery = Json<"/v1/stats/delivery", "get">
type Volume = Json<"/v1/stats/volume", "get">
type Deferrals = Json<"/v1/stats/deferrals", "get">
type Providers = Json<"/v1/stats/providers", "get">
type Engagement = Json<"/v1/stats/engagement", "get">
type Inbound = Json<"/v1/stats/inbound", "get">
type ResponseTimes = Json<"/v1/stats/response-times", "get">
type Audience = Json<"/v1/stats/audience", "get">
type Reputation = Json<"/v1/reputation", "get">
type Usage = Json<"/v1/usage", "get">
type Forecast = Json<"/v1/usage/forecast", "get">
type Storage = Json<"/v1/usage/storage", "get">
type Me = Json<"/v1/me", "get">

const NOW = Date.UTC(2026, 9, 17, 17, 48)
const DAY = 86_400_000
const HOUR = 3_600_000

/** The page's fixture state (`?fx=`), read when a request is answered. */
const fx = () =>
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("fx")

/** A small deterministic wobble, so generated series look like traffic and never change between renders. */
const wobble = (i: number, salt: number) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const lastDays = (n: number) => Array.from({ length: n }, (_, i) => dayStr(NOW - (n - 1 - i) * DAY))
const rangeOf = (url: URL): "24h" | "7d" | "30d" => {
  const r = url.searchParams.get("range")
  return r === "24h" || r === "7d" || r === "30d" ? r : "30d"
}
const range90 = (url: URL): "24h" | "7d" | "30d" | "90d" =>
  url.searchParams.get("range") === "90d" ? "90d" : rangeOf(url)
const daysIn = (r: string) => (r === "24h" ? 1 : r === "7d" ? 7 : r === "30d" ? 30 : 90)

// ───────── sending ─────────

function dayTotals(sent: number, i: number) {
  const bouncedHard = Math.round(sent * 0.004 + wobble(i, 1))
  const bouncedSoft = Math.round(sent * 0.005 + wobble(i, 2))
  const complained = sent > 450 && wobble(i, 3) > 0.7 ? 1 : 0
  const rejected = Math.round(sent * 0.0025 + wobble(i, 4) * 0.6)
  const failed = wobble(i, 5) > 0.8 ? 1 : 0
  const deferred = Math.round(sent * 0.005 + wobble(i, 6))
  const delivered = Math.max(0, sent - bouncedHard - bouncedSoft - rejected - failed - deferred)
  return { sent, delivered, deferred, bouncedHard, bouncedSoft, complained, rejected, failed }
}

function rates(t: ReturnType<typeof dayTotals>, minimum = 100) {
  const insufficientData = t.sent < minimum
  return {
    insufficientData,
    minimumSends: minimum,
    bounceRate: insufficientData ? null : (t.bouncedHard + t.bouncedSoft) / t.sent,
    complaintRate: insufficientData || !t.delivered ? null : t.complained / t.delivered,
    rejectionRate: insufficientData ? null : t.rejected / t.sent,
    deliveryRate: insufficientData ? null : t.delivered / t.sent,
  }
}

const sum = (list: ReturnType<typeof dayTotals>[]) =>
  list.reduce(
    (a, t) => {
      for (const k of Object.keys(a) as (keyof typeof a)[]) a[k] += t[k]
      return a
    },
    {
      sent: 0,
      delivered: 0,
      deferred: 0,
      bouncedHard: 0,
      bouncedSoft: 0,
      complained: 0,
      rejected: 0,
      failed: 0,
    },
  )

const dailySent = (i: number, n: number) => {
  const campaignDay = (n - 1 - i) % 4 === 0 ? 280 + Math.round(wobble(i, 7) * 120) : 0
  return 120 + Math.round(wobble(i, 8) * 70) + campaignDay
}

function delivery(url: URL): Delivery {
  const range = rangeOf(url)
  const state = fx()
  const n = daysIn(range)
  const thin = state === "not-enough-data"
  const days = lastDays(n).map((day, i) => {
    const t = dayTotals(thin ? ([6, 9, 12, 8, 11, 7, 9][i % 7] ?? 9) : dailySent(i, n), i)
    return { day, totals: t, rates: rates(t) }
  })
  const totals = range === "24h" ? dayTotals(thin ? 62 : 412, 99) : sum(days.map((d) => d.totals))
  const collecting = state === "collecting"
  const overADay = range === "30d"
  const scale = Math.max(1, Math.round(totals.sent / 900))
  const buckets = [
    [1000, 44],
    [2000, 201],
    [5000, 455],
    [10000, 172],
    [30000, 60],
    [60000, 20],
    [300000, 11],
    [3600000, 4],
    [86400000, overADay ? 8 : 2],
    [null, overADay ? 40 : 0],
  ].map(([underMs, k]) => ({ underMs: underMs ?? null, n: collecting ? 0 : (k ?? 0) * scale }))
  const samples = buckets.reduce((a, b) => a + b.n, 0)
  return {
    range,
    from: `${lastDays(n)[0]}T00:00:00Z`,
    totals,
    rates: rates(totals),
    deliveryTime: {
      medianMs: collecting ? null : 5000,
      p95Ms: collecting || overADay ? null : 30000,
      samples,
      approximate: true,
      buckets,
    },
    days: url.searchParams.get("by") === "day" && range !== "24h" ? days : [],
  }
}

function volume(url: URL): Volume {
  const range = rangeOf(url)
  const by = url.searchParams.get("by") === "hour" ? "hour" : "day"
  const stream = (i: number, sent: number) => {
    const campaign = sent > 300 ? sent - 140 : 0
    const rest = sent - campaign
    return {
      transactional: Math.round(rest * 0.78),
      campaign,
      automation: Math.round(rest * 0.14),
      mailbox: rest - Math.round(rest * 0.78) - Math.round(rest * 0.14) + Math.round(wobble(i, 9)),
    }
  }
  if (by === "hour") {
    const hours = Array.from({ length: 24 }, (_, i) => {
      const at = Math.floor(NOW / HOUR) * HOUR - (23 - i) * HOUR
      const h = new Date(at).getUTCHours()
      const base = h >= 7 && h <= 19 ? 8 + Math.round(wobble(i, 10) * 10) : 2 + Math.round(wobble(i, 10) * 3)
      return {
        hour: new Date(at).toISOString(),
        byStream: {
          transactional: base,
          campaign: h === 9 ? 280 : h === 10 ? 141 : 0,
          automation: Math.round(wobble(i, 11) * 2),
          mailbox: Math.round(wobble(i, 12) * 1.4),
        },
      }
    })
    return { range, by, days: [], hours, streams: ["transactional", "campaign", "automation", "mailbox"] }
  }
  const n = daysIn(range)
  const thin = fx() === "not-enough-data"
  const days = lastDays(n).map((day, i) => ({
    day,
    byStream: stream(i, thin ? ([6, 9, 12, 8, 11, 7, 9][i % 7] ?? 9) : dailySent(i, n)),
  }))
  return { range, by, days, hours: [], streams: ["transactional", "campaign", "automation", "mailbox"] }
}

function deferrals(url: URL): Deferrals {
  const range = rangeOf(url)
  if (fx() === "collecting") return { range, reasons: [] }
  const k = range === "24h" ? 0.2 : range === "30d" ? 3.4 : 1
  return {
    range,
    reasons: [
      {
        reason: "Messages from 104.30.x.x temporarily deferred due to unexpected volume or user complaints",
        smtpStatus: "421 4.7.0",
        provider: "yahoo",
        count: Math.max(1, Math.round(9 * k)),
      },
      {
        reason: "This mail has been rate limited: unusual rate of unsolicited mail from this sender",
        smtpStatus: "421 4.7.28",
        provider: "gmail",
        count: Math.max(1, Math.round(4 * k)),
      },
      {
        reason: "Server busy, try again later",
        smtpStatus: "451 4.7.500",
        provider: "microsoft",
        count: Math.max(1, Math.round(3 * k)),
      },
      {
        reason: "The email account that you tried to reach is over quota",
        smtpStatus: "452 4.2.2",
        provider: "gmail",
        count: Math.max(1, Math.round(2 * k)),
      },
      {
        reason: "Quota exceeded: Cloudflare's daily sending limit was reached",
        smtpStatus: null,
        provider: null,
        count: 1,
      },
    ],
  }
}

function providers(url: URL): Providers {
  const range = rangeOf(url)
  const k = range === "24h" ? 0.23 : range === "30d" ? 3.5 : 1
  const row = (provider: string, d: number, df: number, b: number, c = 0) => {
    const delivered = Math.round(d * k)
    const deferred = Math.round(df * k)
    const bounced = Math.round(b * k)
    return {
      provider,
      delivered,
      deferred,
      bounced,
      complained: c,
      total: delivered + deferred + bounced + c,
    }
  }
  return {
    range,
    providers: [
      row("gmail", 1039, 4, 6),
      row("microsoft", 339, 2, 3),
      row("yahoo", 193, 4, 2, range === "30d" ? 1 : 0),
      row("apple", 126, 0, 1),
      row("other", 86, 1, 3),
    ],
  }
}

// ───────── engagement ─────────

function engagement(url: URL): Engagement {
  const range = rangeOf(url)
  const campaigns = [
    {
      id: "cmp_01JAOCT",
      name: "October product update",
      startedAt: Date.UTC(2026, 9, 17, 9),
      delivered: 671,
      uniqueOpens: 251,
      machineOpens: 88,
      uniqueClicks: 63,
      unsubscribed: 4,
    },
    {
      id: "cmp_01JASEP",
      name: "September recap",
      startedAt: Date.UTC(2026, 8, 29, 9),
      delivered: 1198,
      uniqueOpens: 431,
      machineOpens: 160,
      uniqueClicks: 97,
      unsubscribed: 7,
    },
    {
      id: "cmp_01JAWAIT",
      name: "Data foundations: waitlist",
      startedAt: Date.UTC(2026, 8, 22, 9),
      delivered: 64,
      uniqueOpens: 31,
      machineOpens: 9,
      uniqueClicks: 12,
      unsubscribed: 0,
    },
  ]
    .filter((c) => NOW - c.startedAt <= daysIn(range) * DAY)
    .map((c) => ({ ...c, openRate: c.uniqueOpens / c.delivered, clickRate: c.uniqueClicks / c.delivered }))
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
  const byHour = days.map((weekday, d) => ({
    weekday,
    hours: Array.from({ length: 24 }, (_, hour) => {
      const work = d < 5 && hour >= 7 && hour <= 10
      const evening = hour >= 18 && hour <= 21
      const opens = Math.round(
        (work ? 30 : evening ? 14 : d >= 5 && hour >= 9 && hour <= 13 ? 9 : 2) +
          wobble(d * 24 + hour, 13) * 6,
      )
      return { hour, opens, clicks: Math.round(opens * (0.15 + wobble(d * 24 + hour, 14) * 0.15)) }
    }),
  }))
  return {
    range,
    from: `${lastDays(daysIn(range))[0]}T00:00:00Z`,
    estimate: true,
    campaigns,
    byHour,
    unsubscribesByTopic: [
      { topicId: "top_product", name: "Product updates", unsubscribed: 11 },
      { topicId: "top_courses", name: "New courses", unsubscribed: 6 },
      { topicId: "top_tips", name: "Weekly tips", unsubscribed: 2 },
    ],
  }
}

// ───────── inbound and audience ─────────

function inbound(url: URL): Inbound {
  const range = range90(url)
  const n = daysIn(range)
  const days = lastDays(n).map((day, i) => {
    const received = 52 + Math.round(wobble(i, 15) * 32)
    return { day, received, rejected: Math.round(received * 0.06), spam: Math.round(received * 0.04) }
  })
  const received = days.reduce((a, d) => a + d.received, 0)
  const rejected = days.reduce((a, d) => a + d.rejected, 0)
  const spam = days.reduce((a, d) => a + d.spam, 0)
  const long = range === "90d"
  return {
    range,
    received,
    rejected:
      fx() === "upstream"
        ? {
            total: rejected,
            noSuchAddress: rejected,
            dmarcFail: Math.round(rejected * 1.4),
            authFail: Math.round(rejected * 0.6),
            upstreamRejected: Math.round(rejected * 2.6),
            rbl: Math.round(rejected * 0.6),
            upstream: { connected: true, reason: null, zones: 2, from: "Email Routing analytics" },
          }
        : {
            total: rejected,
            noSuchAddress: rejected,
            dmarcFail: null,
            authFail: null,
            upstreamRejected: null,
            rbl: null,
            upstream: {
              connected: false,
              reason: "CLOUDFLARE_ANALYTICS_TOKEN isn't set, so Email Routing's analytics can't be read.",
              zones: 0,
              from: null,
            },
          },
    held: Math.max(1, Math.round(received / 120)),
    spam,
    byMailbox: [
      {
        mailboxId: "mbx_support",
        address: "support@coursified.app",
        received: Math.round(received * 0.5),
        spam: Math.round(spam * 0.4),
      },
      {
        mailboxId: "mbx_hello",
        address: "hello@coursified.app",
        received: Math.round(received * 0.43),
        spam: Math.round(spam * 0.56),
      },
      {
        mailboxId: "mbx_founder",
        address: "halleluyah@coursified.app",
        received: received - Math.round(received * 0.5) - Math.round(received * 0.43),
        spam: Math.round(spam * 0.04),
      },
    ],
    days,
    topSenders: [
      { address: "notifications@github.com", received: Math.round(received * 0.12) },
      { address: "no-reply@vercel.com", received: Math.round(received * 0.05) },
      { address: "ada.okafor@gmail.com", received: Math.round(received * 0.02) },
      { address: "billing@paystack.com", received: Math.round(received * 0.016) },
    ],
    topSendersEstimate: long,
  }
}

function responseTimes(url: URL): ResponseTimes {
  const range = range90(url)
  const unavailable = fx() === "unavailable"
  return {
    range,
    mailboxes: unavailable
      ? []
      : [
          {
            mailboxId: "mbx_support",
            address: "support@coursified.app",
            assignees: [
              {
                assigneeId: "mem_kemi",
                name: "Kemi Bello",
                threads: 41,
                answered: 38,
                firstResponseMedianMin: 38,
                firstResponseP90Min: 210,
                resolved: 34,
                resolutionMedianHours: 6.5,
              },
              {
                assigneeId: "key_ops",
                name: "Ops laptop",
                threads: 12,
                answered: 9,
                firstResponseMedianMin: 112,
                firstResponseP90Min: 540,
                resolved: 7,
                resolutionMedianHours: 11,
              },
              {
                assigneeId: null,
                name: null,
                threads: 6,
                answered: 2,
                firstResponseMedianMin: 300,
                firstResponseP90Min: null,
                resolved: 1,
                resolutionMedianHours: null,
              },
            ],
          },
        ],
    unavailable: unavailable ? ["mbx_support"] : [],
  }
}

function audience(url: URL): Audience {
  const range = range90(url)
  const n = range === "24h" ? 2 : daysIn(range)
  const gaps = new Set(n >= 30 ? [0, 1, 2, 14, 15] : n >= 7 ? [3] : [])
  const totalByDay = lastDays(n).map((day, i) => ({
    day,
    total: gaps.has(i) ? null : 4220 + Math.round(i * (592 / n)),
  }))
  return {
    range,
    asOf: Date.UTC(2026, 9, 17, 17),
    total: 4812,
    byStatus: {
      subscribed: 4390,
      unconfirmed: 96,
      unsubscribed: 241,
      bounced: 52,
      complained: 3,
      suppressed: 30,
    },
    new: Math.round(592 * (n / 30)),
    unsubscribed: Math.round(82 * (n / 30)),
    suppressed: Math.round(26 * (n / 30)),
    totalByDay,
  }
}

// ───────── reputation, usage ─────────

const reputation = (): Reputation => ({
  status: "healthy",
  statusSince: "2026-09-02T08:00:00Z",
  graceStartedAt: null,
  evaluatedAt: "2026-10-17T17:30:00Z",
  source: "cloudflare",
  policySource: "account",
  policy: {
    customer_bounce: { warning_at: 0.02, at_risk_at: 0.05, minimum_denominator: 100 },
    complaint: { warning_at: 0.001, at_risk_at: 0.002, minimum_denominator: 100 },
    spam_rejection: { warning_at: 0.01, at_risk_at: 0.03, minimum_denominator: 100 },
    suspension_after_hours: 168,
  },
  window: "30d",
  totals: {
    sent: 6329,
    delivered: 6206,
    deferred: 38,
    bouncedHard: 25,
    bouncedSoft: 35,
    complained: 3,
    rejected: 18,
    failed: 7,
  },
  rates: {
    insufficientData: false,
    minimumSends: 100,
    bounceRate: 0.00948,
    complaintRate: 0.00048,
    rejectionRate: 0.00284,
    deliveryRate: 0.9806,
  },
  levels: { bounce: "ok", complaint: "ok", spamRejection: "ok" },
})

function usage(): Usage {
  const unknown = fx() === "quota-unknown"
  return {
    today: unknown
      ? {
          sent: 412,
          quota: null,
          remaining: null,
          overQuota: null,
          resetsAt: "2026-10-18T00:00:00Z",
          source: "cloudflare-unreachable",
        }
      : {
          sent: 412,
          quota: 1000,
          remaining: 588,
          overQuota: false,
          resetsAt: "2026-10-18T00:00:00Z",
          source: "cloudflare",
        },
    month: {
      from: "2026-10-01T00:00:00Z",
      billed: 3678,
      included: 3000,
      overage: 678,
      costUsd: 0.24,
      projectedBilled: 6824,
      projectedCostUsd: 1.34,
    },
    pricing: { includedPerMonth: 3000, usdPerThousand: 0.35, measuredAt: "2026-10-16T09:00:00Z" },
  }
}

function forecast(url: URL): Forecast {
  const recipients = Math.max(1, Number(url.searchParams.get("recipients")) || 3400)
  const startAt = Number(url.searchParams.get("startAt")) || NOW
  if (fx() === "quota-unknown")
    return {
      recipients,
      startAt,
      possible: false,
      reason: "Cloudflare didn’t return a daily quota, so the days can’t be planned. Try again shortly.",
    }
  const quota = 1000
  const today = Math.min(recipients, 512)
  const days = [{ day: dayStr(NOW), available: 512, queued: 488, thisCampaign: today }]
  let left = recipients - today
  for (let i = 1; left > 0 && i < 30; i++) {
    const take = Math.min(quota, left)
    days.push({ day: dayStr(NOW + i * DAY), available: quota, queued: 0, thisCampaign: take })
    left -= take
  }
  const finishesBy = new Date(Date.parse(`${days[days.length - 1]?.day}T00:00:00Z`) + 14 * HOUR).toISOString()
  const billedAfter = 3678 + recipients - 766
  return {
    recipients,
    startAt,
    possible: true,
    quota,
    sendableToday: today,
    additionalDays: days.length - 1,
    finishesBy,
    days,
    cost: { billedAfter, extraUsd: Math.round(Math.max(0, recipients - 76) * 0.35) / 1000 },
  }
}

const storage = (): Storage => ({
  totalBytes: 1931400000,
  mailBytes: 1874000000,
  exportsBytes: 48200000,
  uploadsBytes: 9200000,
  byMailbox: [
    { mailboxId: "mbx_support", address: "support@coursified.app", messages: 4211, bytes: 912000000 },
    { mailboxId: "mbx_hello", address: "hello@coursified.app", messages: 3214, bytes: 701000000 },
    { mailboxId: "mbx_founder", address: "halleluyah@coursified.app", messages: null, bytes: null },
  ],
  measuredAt: NOW - 2 * HOUR,
})

// ───────── who's signed in, for the role and scope states ─────────

const workspace = {
  id: "ws_01JA3Q8M2K",
  name: "Coursified",
  logoUrl: null,
  url: "https://mail.coursified.app",
  host: "mail.coursified.app",
  claimed: true,
}

function me(): Me | null {
  const state = fx()
  if (state === "csv-blocked")
    return {
      user: null,
      workspace,
      role: null,
      via: "session-key",
      key: { id: "key_01JAOPST", name: "Ops tablet", prefix: "sk_Op7t…" },
      scopes: ["admin"],
      permissions: [],
      mailboxes: null,
      workspaces: [workspace],
      session: { id: "ses_01JAOPST", expiresAt: NOW + 14 * DAY, absoluteExpiresAt: NOW + 30 * DAY },
    }
  if (state === "viewer")
    return {
      user: { id: "usr_01JAVIEW", name: "Femi Ade", email: "femi@coursified.app", timeZone: "Africa/Lagos" },
      workspace,
      role: "viewer",
      via: "session-member",
      key: null,
      scopes: [],
      permissions: [],
      mailboxes: [],
      workspaces: [workspace],
      session: { id: "ses_01JAVIEW", expiresAt: NOW + 14 * DAY, absoluteExpiresAt: NOW + 30 * DAY },
    }
  return null
}

const ok = (body: unknown) => ({ status: 200, body })

const onAnalytics = () => typeof window !== "undefined" && window.location.pathname.startsWith("/analytics")

/**
 * A path pattern that only matches while an Analytics page is open, so these overrides never change what the
 * Overview, the shell or another section gets from the design fixtures for the same routes. `findOverride`
 * matches with `pathname.match(pattern)`, which defers to `Symbol.match`.
 */
function scoped(re: RegExp, when: () => boolean = onAnalytics): RegExp {
  const r = new RegExp(re.source, re.flags)
  Object.defineProperty(r, Symbol.match, {
    value: (s: string) => (when() ? RegExp.prototype[Symbol.match].call(re, s) : null),
  })
  return r
}

export const ANALYTICS_OVERRIDES: readonly Override[] = [
  { method: "GET", path: scoped(/^\/v1\/stats\/delivery$/), answer: (_m, _b, url) => ok(delivery(url)) },
  { method: "GET", path: scoped(/^\/v1\/stats\/volume$/), answer: (_m, _b, url) => ok(volume(url)) },
  { method: "GET", path: scoped(/^\/v1\/stats\/deferrals$/), answer: (_m, _b, url) => ok(deferrals(url)) },
  {
    method: "GET",
    path: scoped(/^\/v1\/stats\/providers$/),
    answer: (_m, _b, url) =>
      fx() === "error"
        ? {
            status: 500,
            body: { _tag: "InternalError", message: "Internal error", requestId: "8d41a0c2e93b7f16-LHR" },
          }
        : ok(providers(url)),
  },
  { method: "GET", path: scoped(/^\/v1\/stats\/engagement$/), answer: (_m, _b, url) => ok(engagement(url)) },
  { method: "GET", path: scoped(/^\/v1\/stats\/inbound$/), answer: (_m, _b, url) => ok(inbound(url)) },
  {
    method: "GET",
    path: scoped(/^\/v1\/stats\/response-times$/),
    answer: (_m, _b, url) => ok(responseTimes(url)),
  },
  { method: "GET", path: scoped(/^\/v1\/stats\/audience$/), answer: (_m, _b, url) => ok(audience(url)) },
  { method: "GET", path: scoped(/^\/v1\/reputation$/), answer: () => ok(reputation()) },
  { method: "GET", path: scoped(/^\/v1\/usage$/), answer: () => ok(usage()) },
  { method: "GET", path: scoped(/^\/v1\/usage\/forecast$/), answer: (_m, _b, url) => ok(forecast(url)) },
  { method: "GET", path: scoped(/^\/v1\/usage\/storage$/), answer: () => ok(storage()) },
  // The role and scope states only: everywhere else /v1/me falls through to the design fixtures.
  { method: "GET", path: scoped(/^\/v1\/me$/, () => onAnalytics() && me() !== null), answer: () => ok(me()) },
]

import { and, asc, eq, gte, isNull, like, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { syncFailedAlert } from "../automations/runs.ts"
import { DEFAULT_CONFIG, type PauseRule } from "../campaigns/governor.ts"
import { alerts, domains, messagesOut, webhookDeliveries, webhookEndpoints } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { Governor } from "../services/Governor.ts"
import { clearAlert, clearAlertsExcept, expireNotices, raiseAlert } from "./alerts.ts"
import { recheckDomain } from "./domains.ts"
import { reputation, usage } from "./insights.ts"
import { syncDeadLetterAlert } from "./webhooks.ts"

/**
 * The hourly alert sweep (HAL-3364): the alerts whose condition is a state rather than an event.
 * Each step raises what holds now and clears what no longer does, and a failing step never stops
 * the others.
 *
 * - `dns_drift`, `domain_activated`: re-checks the 25 domains checked longest ago (src/domain/domains.ts).
 * - `reputation_warning`, `reputation_at_risk`: Cloudflare's verdict when connected, and Mailyard's
 *   own 30-day rates against Cloudflare's thresholds either way (`GET /v1/reputation`).
 * - `bounce_spike`, `complaint_spike`: the last 24 hours against the governor's pause rule, the same
 *   line that pauses a campaign, across every stream.
 * - `quota_80`, `quota_100`: today's sends against the daily quota, when the quota is known.
 * - `webhook_dead_letter`, `automation_failed`: brought up to date, so they clear when the dead letters
 *   or failed runs are gone.
 * - Notices past their time (`export_ready`, `domain_activated`, `import_failed`) are cleared.
 */

const DAY = 86_400_000
const DOMAINS_PER_SWEEP = 25

const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as(`${name} ok`),
    Effect.catchCause((cause) =>
      Effect.logError(`alerts sweep: ${name} failed`, cause).pipe(Effect.as(`${name} failed`)),
    ),
  )

export const sweepAlerts = Effect.fn("alerts.sweep")(function* (now = Date.now()) {
  return [
    yield* step("domains", sweepDomains()),
    yield* step("reputation", sweepReputation()),
    yield* step("spikes", sweepSpikes(now)),
    yield* step("quota", sweepQuota()),
    yield* step("webhooks", sweepDeadLetters()),
    yield* step("automations", sweepAutomationFailures()),
    yield* step("notices", expireNotices(now)),
  ]
})

const sweepDomains = () =>
  Effect.gen(function* () {
    const database = yield* Database
    const due = yield* database.query("alerts.sweepDomains", (db) =>
      db
        .select({ id: domains.id })
        .from(domains)
        .orderBy(sql`coalesce(${domains.lastCheckedAt}, 0)`, asc(domains.id))
        .limit(DOMAINS_PER_SWEEP)
        .all(),
    )
    for (const d of due)
      yield* recheckDomain(d.id).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`alerts sweep: could not recheck ${d.id}`, cause)),
      )
  })

const sweepReputation = () =>
  Effect.gen(function* () {
    const rep = yield* reputation()
    const levels = Object.values(rep.levels)
    const atRisk = rep.status === "at_risk" || levels.includes("at-risk")
    const warning = !atRisk && (rep.status === "warning" || levels.includes("warning"))
    const why = [
      rep.status ? `Cloudflare says ${rep.status.replace("_", " ")}.` : null,
      rep.rates.bounceRate !== null ? `Bounces ${(100 * rep.rates.bounceRate).toFixed(2)}%` : null,
      rep.rates.complaintRate !== null ? `complaints ${(100 * rep.rates.complaintRate).toFixed(3)}%` : null,
      rep.rates.rejectionRate !== null
        ? `spam rejections ${(100 * rep.rates.rejectionRate).toFixed(2)}% over 30 days.`
        : null,
    ]
      .filter(Boolean)
      .join(" ")
    if (atRisk) {
      yield* raiseAlert({
        key: "reputation_at_risk",
        kind: "reputation_at_risk",
        severity: "critical",
        title: "Sending reputation is at risk",
        detail: `${why} Past this line Cloudflare can suspend sending: pause bulk mail and clean the list.`,
      })
      yield* clearAlert("reputation_warning", "sweep")
    } else if (warning) {
      yield* raiseAlert({
        key: "reputation_warning",
        kind: "reputation_warning",
        severity: "warning",
        title: "Sending reputation needs attention",
        detail: `${why} Check recent campaigns' bounces and complaints.`,
      })
      yield* clearAlert("reputation_at_risk", "sweep")
    } else {
      yield* clearAlert("reputation_at_risk", "sweep")
      yield* clearAlert("reputation_warning", "sweep")
    }
  })

/** Outcomes of the last 24 hours, every stream: what the governor's pause rule is judged on. */
const lastDay = (now: number) =>
  Effect.gen(function* () {
    const database = yield* Database
    const rows = yield* database.query("alerts.lastDay", (db) =>
      db
        .select({ status: messagesOut.status, bounceType: messagesOut.bounceType, n: sql<number>`count(*)` })
        .from(messagesOut)
        .where(gte(messagesOut.createdAt, now - DAY))
        .groupBy(messagesOut.status, messagesOut.bounceType)
        .all(),
    )
    const of = (status: string, bounce?: string) =>
      rows
        .filter((r) => r.status === status && (bounce === undefined || r.bounceType === bounce))
        .reduce((n, r) => n + Number(r.n), 0)
    // A complaint arrives after delivery: the message was delivered too.
    const complained = of("complained")
    return { delivered: of("delivered") + complained, bounced: of("bounced", "hard"), complained }
  })

const pauseRule = Effect.gen(function* () {
  const governor = yield* Governor
  return yield* governor.overview.pipe(
    Effect.map((o) => o.config.pause as PauseRule),
    Effect.orElseSucceed(() => DEFAULT_CONFIG.pause),
  )
})

const sweepSpikes = (now: number) =>
  Effect.gen(function* () {
    const o = yield* lastDay(now)
    const rule = yield* pauseRule
    const settled = o.delivered + o.bounced
    const bounceRate = settled > 0 ? o.bounced / settled : 0
    if (settled >= rule.minOutcomes && bounceRate > rule.bounceRate)
      yield* raiseAlert({
        key: "bounce_spike",
        kind: "bounce_spike",
        severity: "critical",
        title: `Bounce rate ${(100 * bounceRate).toFixed(1)}% in the last 24 hours`,
        detail: `${o.bounced} hard bounces out of ${settled} settled messages, over the ${(100 * rule.bounceRate).toFixed(0)}% line that pauses a campaign. A list with old or bought addresses does this.`,
        count: o.bounced,
      })
    else yield* clearAlert("bounce_spike", "sweep")
    const complaintRate = o.complained / Math.max(o.delivered, 1)
    if (o.complained >= rule.minComplaints && complaintRate > rule.complaintRate)
      yield* raiseAlert({
        key: "complaint_spike",
        kind: "complaint_spike",
        severity: "critical",
        title: `Complaint rate ${(100 * complaintRate).toFixed(2)}% in the last 24 hours`,
        detail: `${o.complained} people marked mail as spam out of ${o.delivered} delivered, over the ${(100 * rule.complaintRate).toFixed(1)}% line. Check who's on the list and how they joined.`,
        count: o.complained,
      })
    else yield* clearAlert("complaint_spike", "sweep")
  })

/** Today's quota, from Cloudflare when connected, else the governor's configured one (never its fallback guess). */
const quotaToday = Effect.gen(function* () {
  const u = yield* usage()
  if (u.today.quota !== null)
    return { sent: Number(u.today.sent), quota: u.today.quota, source: "Cloudflare" }
  const governor = yield* Governor
  const o = yield* governor.overview.pipe(Effect.orElseSucceed(() => null))
  if (o && o.quotaSource === "configured")
    return {
      sent: Object.values(o.sent).reduce((a, b) => a + b, 0),
      quota: o.quota,
      source: "the configured quota",
    }
  return null
})

const sweepQuota = () =>
  Effect.gen(function* () {
    const q = yield* quotaToday
    if (!q || q.quota <= 0) {
      yield* clearAlert("quota_100", "sweep")
      yield* clearAlert("quota_80", "sweep")
      return
    }
    const share = q.sent / q.quota
    const line = `${q.sent} of ${q.quota} sent today (${source(q.source)}).`
    if (share >= 1) {
      yield* raiseAlert({
        key: "quota_100",
        kind: "quota_100",
        severity: "critical",
        title: "Today's sending quota is used up",
        detail: `${line} More mail waits for midnight UTC; transactional mail gets the reserve first.`,
      })
      yield* clearAlert("quota_80", "sweep")
    } else if (share >= 0.8) {
      yield* raiseAlert({
        key: "quota_80",
        kind: "quota_80",
        severity: "warning",
        title: `${Math.floor(100 * share)}% of today's sending quota is used`,
        detail: `${line} Campaigns slow down to keep the rest for transactional mail.`,
      })
      yield* clearAlert("quota_100", "sweep")
    } else {
      yield* clearAlert("quota_100", "sweep")
      yield* clearAlert("quota_80", "sweep")
    }
  })
const source = (s: string) => `per ${s}`

const sweepDeadLetters = () =>
  Effect.gen(function* () {
    const database = yield* Database
    const withDead = yield* database.query("alerts.deadEndpoints", (db) =>
      db
        .selectDistinct({ id: webhookEndpoints.id, url: webhookEndpoints.url })
        .from(webhookDeliveries)
        .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
        .where(eq(webhookDeliveries.status, "dead"))
        .all(),
    )
    for (const e of withDead) yield* syncDeadLetterAlert(e)
    yield* clearAlertsExcept(
      "webhook_dead_letter:",
      new Set(withDead.map((e) => `webhook_dead_letter:${e.id}`)),
      "sweep",
    )
  })

const sweepAutomationFailures = () =>
  Effect.gen(function* () {
    const database = yield* Database
    const open = yield* database.query("alerts.openAutomationFailures", (db) =>
      db
        .select({ key: alerts.key })
        .from(alerts)
        .where(and(isNull(alerts.resolvedAt), like(alerts.key, "automation\\_failed:%")))
        .all(),
    )
    for (const a of open) yield* syncFailedAlert(a.key.slice("automation_failed:".length))
  })

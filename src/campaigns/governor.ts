/**
 * The rules SendGovernorDO enforces, as plain functions so they can be read and tested on their own.
 * Bulk mail (campaigns, automations) is paced against the account's daily quota, per mailbox
 * provider, and per sending domain while that domain warms up; transactional mail is never held,
 * and a share of the quota is kept for it.
 */

export const DAY_MS = 86_400_000
export const MINUTE_MS = 60_000

export type Stream = "transactional" | "campaign" | "automation" | "mailbox"
export const BULK: ReadonlyArray<Stream> = ["campaign", "automation"]

export type Provider = "gmail" | "microsoft" | "yahoo" | "apple" | "other"
export const PROVIDERS: ReadonlyArray<Provider> = ["gmail", "microsoft", "yahoo", "apple", "other"]

/** The UTC day a moment falls in, as `YYYY-MM-DD`: Email Sending's quota resets at midnight UTC. */
export const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10)
export const nextMidnight = (now: number) => Math.floor(now / DAY_MS) * DAY_MS + DAY_MS
export const minuteKey = (now: number) => Math.floor(now / MINUTE_MS)
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS)

/** Which big mailbox provider a recipient's domain belongs to, by its consumer domains. */
export const providerOf = (domain: string): Provider => {
  const d = domain.toLowerCase()
  if (d === "gmail.com" || d === "googlemail.com") return "gmail"
  if (/^(outlook|hotmail|live|msn|passport)\.[a-z.]+$/.test(d)) return "microsoft"
  if (/^(yahoo|ymail|rocketmail|aol)\.[a-z.]+$/.test(d)) return "yahoo"
  if (d === "icloud.com" || d === "me.com" || d === "mac.com") return "apple"
  return "other"
}

export interface WarmupConfig {
  readonly enabled: boolean
  /** Bulk sends a new sending domain may make on its first day. */
  readonly start: number
  /** Each clean day multiplies the cap by this. */
  readonly factor: number
  /** A day above either rate holds the cap where it is. */
  readonly maxBounceRate: number
  readonly maxComplaintRate: number
}

export interface GovernorConfig {
  /** The account's daily quota. null: read it from Cloudflare (`/email/sending/limits`) when connected. */
  readonly dailyQuota: number | null
  /** Used when the quota is unknown, so sending never stops for want of a number. */
  readonly fallbackQuota: number
  /** Share of the daily quota bulk mail can't touch, kept for sign-in codes and receipts. */
  readonly transactionalReserve: number
  /** Bulk sends per minute to each provider. */
  readonly providerPerMinute: Readonly<Record<Provider, number>>
  readonly warmup: WarmupConfig
  /** Sending domains with a track record: no warm-up. */
  readonly establishedDomains: ReadonlyArray<string>
  readonly pause: PauseRule
}

export interface PauseRule {
  /** Bounces over delivered plus bounced, once at least `minOutcomes` are in. */
  readonly bounceRate: number
  readonly minOutcomes: number
  /** Complaints over delivered: Cloudflare's own warning line is 0.1%. */
  readonly complaintRate: number
  /** Complaints before the complaint rate is trusted at all. */
  readonly minComplaints: number
}

export const DEFAULT_CONFIG: GovernorConfig = {
  dailyQuota: null,
  fallbackQuota: 1000,
  transactionalReserve: 0.2,
  providerPerMinute: { gmail: 120, microsoft: 60, yahoo: 60, apple: 60, other: 300 },
  warmup: { enabled: true, start: 50, factor: 2, maxBounceRate: 0.02, maxComplaintRate: 0.001 },
  establishedDomains: [],
  pause: { bounceRate: 0.05, minOutcomes: 50, complaintRate: 0.001, minComplaints: 2 },
}

export interface DayOutcomes {
  readonly sent: number
  readonly delivered: number
  readonly bounced: number
  readonly complained: number
}

/** A day is clean when its bounce and complaint rates stay under the warm-up limits. */
export const cleanDay = (o: DayOutcomes, w: WarmupConfig) => {
  const settled = o.delivered + o.bounced
  if (settled === 0) return o.sent === 0 ? null : true
  const bounceRate = o.bounced / settled
  const complaintRate = o.delivered === 0 ? (o.complained > 0 ? 1 : 0) : o.complained / o.delivered
  return bounceRate <= w.maxBounceRate && complaintRate <= w.maxComplaintRate
}

/**
 * Tomorrow's cap for a warming domain. A clean day that used at least half its cap earns the next
 * step; a quiet day keeps the cap (it proved nothing); a dirty day holds it too.
 */
export const nextCap = (cap: number, day: DayOutcomes, w: WarmupConfig, quota: number) => {
  const clean = cleanDay(day, w)
  if (clean === true && day.sent >= cap / 2) return Math.min(quota, Math.ceil(cap * w.factor))
  return cap
}

/** Whether a campaign's outcomes so far mean it should stop, and why. */
export const pauseReason = (o: Omit<DayOutcomes, "sent">, rule: PauseRule): string | null => {
  const settled = o.delivered + o.bounced
  if (settled >= rule.minOutcomes && o.bounced / settled > rule.bounceRate) {
    return `Bounce rate ${(100 * (o.bounced / settled)).toFixed(1)}% is over ${(100 * rule.bounceRate).toFixed(0)}%.`
  }
  if (o.complained >= rule.minComplaints && o.complained / Math.max(o.delivered, 1) > rule.complaintRate) {
    return `Complaint rate ${(100 * (o.complained / Math.max(o.delivered, 1))).toFixed(2)}% is over ${(100 * rule.complaintRate).toFixed(1)}%.`
  }
  return null
}

/** Bulk sends the day's quota still allows: everything not kept for transactional and not used. */
export const bulkAllowance = (
  quota: number,
  reserve: number,
  sentToday: Readonly<Record<Stream, number>>,
) => {
  const bulkShare = Math.floor(quota * (1 - reserve))
  const bulkUsed = sentToday.campaign + sentToday.automation
  const allUsed = bulkUsed + sentToday.transactional + sentToday.mailbox
  return Math.max(0, Math.min(bulkShare - bulkUsed, quota - allUsed))
}

/**
 * When `remaining` bulk sends will have gone, given today's allowance and the domain's warm-up.
 * Assumes today's pace on later days: a fresh allowance at each midnight, the cap growing on schedule.
 */
export const projectEta = (input: {
  readonly remaining: number
  readonly now: number
  readonly todayAllowance: number
  readonly dailyBulk: number
  readonly warmupCap: number | null
  readonly warmupUsedToday: number
  readonly warmupFactor: number
}) => {
  if (input.remaining <= 0) return { days: 0, at: input.now }
  let left = input.remaining
  let cap = input.warmupCap
  let day = 0
  let allowance = Math.min(
    input.todayAllowance,
    cap === null ? Number.POSITIVE_INFINITY : Math.max(0, cap - input.warmupUsedToday),
  )
  while (left > 0 && day < 3650) {
    if (left <= allowance) break
    left -= allowance
    day++
    if (cap !== null) cap = Math.ceil(cap * input.warmupFactor)
    allowance = Math.min(input.dailyBulk, cap ?? Number.POSITIVE_INFINITY)
    if (allowance <= 0) return { days: null, at: null }
  }
  return { days: day, at: day === 0 ? input.now : nextMidnight(input.now) + (day - 1) * DAY_MS }
}

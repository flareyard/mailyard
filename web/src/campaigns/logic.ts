/**
 * Campaigns, as pure functions (design: screens/audience/campaign*.html, HANDOFF-audience §6, GAPS-audience
 * A7). Everything the screens decide lives here so it can be tested without a browser: where a campaign opens,
 * how its list row reads, placeholders and fallbacks, which string a 400 names, where each check's fix goes,
 * the audience buckets and their sum, the forecast bars, the 168-hour activity chart, the funnel, time zones,
 * what a stale save would lose, and the refusals a limited key gets.
 */
import { ApiError } from "../api/client.ts"
import { fmtInt, num } from "../lib/format.ts"

type N = number | string | null | undefined

export type Status = "draft" | "scheduled" | "sending" | "paused" | "sent" | "cancelled"
export type Step = "content" | "audience" | "preview" | "checks" | "schedule"
export const STEPS: readonly Step[] = ["content", "audience", "preview", "checks", "schedule"]
export const STEP_LABEL: Record<Step, string> = {
  content: "Content",
  audience: "Audience",
  preview: "Preview",
  checks: "Checks",
  schedule: "Schedule",
}
export const isStep = (v: unknown): v is Step =>
  typeof v === "string" && (STEPS as readonly string[]).includes(v)

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

export type ListTab = { status: Status | "active" | undefined; label: string; count: keyof CountsLike }
export type CountsLike = {
  draft: N
  scheduled: N
  sending: N
  paused: N
  sent: N
  cancelled: N
  active: N
  total: N
}
export const LIST_TABS: readonly ListTab[] = [
  { status: undefined, label: "All", count: "total" },
  { status: "active", label: "Active", count: "active" },
  { status: "draft", label: "Drafts", count: "draft" },
  { status: "scheduled", label: "Scheduled", count: "scheduled" },
  { status: "sending", label: "Sending", count: "sending" },
  { status: "paused", label: "Paused", count: "paused" },
  { status: "sent", label: "Sent", count: "sent" },
  { status: "cancelled", label: "Cancelled", count: "cancelled" },
]
const LIST_STATUSES = ["active", "draft", "scheduled", "sending", "paused", "sent", "cancelled"] as const
export const isListStatus = (v: unknown): v is (typeof LIST_STATUSES)[number] =>
  typeof v === "string" && (LIST_STATUSES as readonly string[]).includes(v)

/** Where a campaign opens: the editor for a draft, the schedule once scheduled, the sending view, the report. */
export function landingFor(status: Status): Step | "sending" | "report" {
  if (status === "draft") return "content"
  if (status === "scheduled") return "schedule"
  if (status === "sending" || status === "paused") return "sending"
  return "report"
}

export function campaignHref(id: string, status: Status): string {
  const to = landingFor(status)
  return to === "sending" ? `/campaigns/${id}` : `/campaigns/${id}/${to}`
}

/** Only a draft can be edited; once scheduled, a campaign's content is what it is (the API answers 409). */
export const isEditable = (status: Status) => status === "draft"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const p2 = (n: number) => String(n).padStart(2, "0")
const hm = (d: Date) => `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
const sameUtcDay = (a: number, b: number) =>
  new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10)

/** "Tue 20 Oct, 09:00 UTC". */
export function fmtWhen(ms: N): string {
  const t = num(ms)
  if (t === null) return "—"
  const d = new Date(t)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hm(d)} UTC`
}

/** "30 Sep, 11:14 UTC", or "09:02 UTC" for today. */
export function fmtStamp(ms: N, now = Date.now()): string {
  const t = num(ms)
  if (t === null) return "—"
  const d = new Date(t)
  if (sameUtcDay(t, now)) return `${hm(d)} UTC`
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hm(d)} UTC`
}

type RowLike = {
  status: Status
  sendAt: N
  startedAt: N
  finishedAt: N
  updatedAt?: N
  pausedBy: string | null
  heldBy: string | null
  heldUntil: N
  audienceSize: N
  summary?: { sent: N } | null
}

/** The list's "Send time" cell. */
export function sendTimeLabel(c: RowLike, now = Date.now()): string {
  switch (c.status) {
    case "draft":
      return "Not scheduled"
    case "scheduled":
      return fmtWhen(c.sendAt)
    case "sending":
    case "paused":
      return `Started ${fmtStamp(c.startedAt ?? c.sendAt, now)}`
    case "sent":
      return fmtStamp(c.finishedAt ?? c.startedAt, now)
    case "cancelled":
      return `Cancelled ${fmtStamp(c.finishedAt ?? c.updatedAt, now)}`
  }
}

export const PAUSED_BY_WORDS: Record<string, string> = {
  bounce_rate: "bounce rate",
  complaint_rate: "complaint rate",
  admin: "paused by hand",
}
export const HELD_BY_WORDS: Record<string, string> = { quota: "daily quota", warmup: "warm-up cap" }

/** Is the governor holding it for the day (HAL-3431)? A hold is not a pause: it carries on by itself. */
export const isHeld = (c: Pick<RowLike, "status" | "heldUntil" | "heldBy">) =>
  c.status === "sending" && num(c.heldUntil) !== null

/** The line under the status pill: "Held until 00:00 UTC · daily quota", "bounce rate". */
export function statusSub(c: RowLike): string | null {
  if (isHeld(c)) return `Held until ${fmtHeld(c.heldUntil)} · ${HELD_BY_WORDS[c.heldBy ?? ""] ?? "held"}`
  if (c.status === "paused") return c.pausedBy ? (PAUSED_BY_WORDS[c.pausedBy] ?? c.pausedBy) : "paused"
  return null
}

export function fmtHeld(ms: N): string {
  const t = num(ms)
  return t === null ? "—" : `${hm(new Date(t))} UTC`
}

/** Sent of audience, 0–100, for the list's bar and the sending view. */
export function sentPct(sent: N, audience: N): number {
  const s = num(sent) ?? 0
  const a = num(audience) ?? 0
  if (a <= 0) return 0
  return Math.min(100, Math.round((s / a) * 1000) / 10)
}

// ---------------------------------------------------------------------------------------------
// Placeholders and fallbacks (`{{ name ?? "there" }}`, src/domain/render.ts)
// ---------------------------------------------------------------------------------------------

export type Placeholder = {
  raw: string
  key: string
  fallback: string | null
  /** `{{#if x}}`, `{{/if}}`, `{{else}}`: block helpers, not values. */
  helper: boolean
  /** Anything the renderer won't parse (`{{ city | "Lagos" }}`) goes out as typed. */
  unparsed: boolean
  start: number
  end: number
}

const TAG = /\{\{\s*([^{}]*?)\s*\}\}/g
const VALUE = /^([A-Za-z_][\w.]*)\s*(?:\?\?\s*(?:"([^"]*)"|'([^']*)'))?$/

export function parsePlaceholders(text: string): Placeholder[] {
  const out: Placeholder[] = []
  for (const m of text.matchAll(TAG)) {
    const inner = (m[1] ?? "").trim()
    const start = m.index ?? 0
    const base = { raw: m[0], start, end: start + m[0].length }
    if (/^[#/]|^else\b/.test(inner)) {
      const key = inner.replace(/^[#/]\w+\s*/, "").trim() || inner.replace(/^[#/]/, "")
      out.push({ ...base, key, fallback: null, helper: true, unparsed: false })
      continue
    }
    const v = inner.match(VALUE)
    if (v?.[1])
      out.push({ ...base, key: v[1], fallback: v[2] ?? v[3] ?? null, helper: false, unparsed: false })
    else out.push({ ...base, key: inner, fallback: null, helper: false, unparsed: true })
  }
  return out
}

/** Values the renderer fills itself, not from a contact field. */
export const BUILT_IN_KEYS = new Set([
  "view_url",
  "unsubscribe_url",
  "preferences_url",
  "unsubscribe_footer",
  "email",
  "name",
  "contact.email",
  "contact.name",
])

export type MergeField = { key: string; fallback: string | null; count: number; known: boolean | null }

/**
 * The merge fields a piece of content uses, in first-seen order, with the fallback each carries (the first one
 * written) and whether the field exists. `known` is null while the field registry hasn't loaded.
 */
export function mergeFields(texts: readonly string[], fieldKeys: readonly string[] | null): MergeField[] {
  const map = new Map<string, MergeField>()
  for (const t of texts)
    for (const p of parsePlaceholders(t)) {
      if (p.helper || p.unparsed) continue
      const cur = map.get(p.key)
      if (cur) {
        cur.count++
        if (cur.fallback === null && p.fallback !== null) cur.fallback = p.fallback
        continue
      }
      const known =
        BUILT_IN_KEYS.has(p.key) || p.key.startsWith("trigger.")
          ? true
          : fieldKeys === null
            ? null
            : fieldKeys.includes(p.key.replace(/^(contact\.)?fields\./, ""))
      map.set(p.key, { key: p.key, fallback: p.fallback, count: 1, known })
    }
  return [...map.values()]
}

/** Placeholders that would go out as typed: unparsed syntax, or a field nobody has. */
export function goesOutAsTyped(texts: readonly string[], fieldKeys: readonly string[] | null): string[] {
  const out: string[] = []
  for (const t of texts)
    for (const p of parsePlaceholders(t)) {
      if (p.helper) continue
      if (p.unparsed) out.push(p.raw)
      else if (fieldKeys && !BUILT_IN_KEYS.has(p.key) && !p.key.startsWith("trigger.")) {
        if (!fieldKeys.includes(p.key.replace(/^(contact\.)?fields\./, ""))) out.push(p.raw)
      }
    }
  return [...new Set(out)]
}

/** Writes one fallback into every `{{ key … }}` in a text; an empty fallback removes it. */
export function setFallback(text: string, key: string, fallback: string): string {
  return text.replace(TAG, (raw, inner: string) => {
    const v = inner.trim().match(VALUE)
    if (!v || v[1] !== key) return raw
    if (!fallback) return `{{ ${key} }}`
    const q = fallback.includes('"') ? "'" : '"'
    return `{{ ${key} ?? ${q}${fallback}${q} }}`
  })
}

// ---------------------------------------------------------------------------------------------
// Which string a 400 names (HAL-3433): `bodyBlocks.blocks[4].text`, `bodyBlocks.footer.reason`, `subject`
// ---------------------------------------------------------------------------------------------

export type ErrorTarget =
  | { kind: "block"; index: number; path: string }
  | { kind: "footer"; path: string }
  | { kind: "blocks"; path: string }
  | { kind: "field"; field: string; path: string }

export function errorTarget(field: string | null | undefined): ErrorTarget | null {
  if (!field) return null
  const b = field.match(/^bodyBlocks\.blocks\[(\d+)\]/)
  if (b) return { kind: "block", index: Number(b[1]), path: field }
  if (field.startsWith("bodyBlocks.footer")) return { kind: "footer", path: field }
  if (field === "bodyBlocks" || field.startsWith("bodyBlocks.")) return { kind: "blocks", path: field }
  return { kind: "field", field: field.split(/[.[]/)[0] ?? field, path: field }
}

// ---------------------------------------------------------------------------------------------
// Checks: where each fix goes (HAL-3430)
// ---------------------------------------------------------------------------------------------

export type FixLike = {
  label: string
  target: "content" | "audience" | "settings.compliance" | "domains"
  field?: string | undefined
  domainId?: string | undefined
}

export function fixHref(campaignId: string, fix: FixLike): string {
  switch (fix.target) {
    case "content":
      return `/campaigns/${campaignId}/content${fix.field ? `?focus=${encodeURIComponent(fix.field)}` : ""}`
    case "audience":
      return `/campaigns/${campaignId}/audience`
    case "settings.compliance":
      return `/settings/tracking${fix.field ? `?field=${encodeURIComponent(fix.field)}` : ""}`
    case "domains":
      return fix.domainId ? `/domains/${encodeURIComponent(fix.domainId)}` : "/domains?add=1"
  }
}

/** Fixes outside the campaign need another permission: settings and domains are owners' and admins'. */
export function fixPermission(fix: FixLike): "campaigns.write" | "settings.write" | "domains.manage" {
  if (fix.target === "settings.compliance") return "settings.write"
  if (fix.target === "domains") return "domains.manage"
  return "campaigns.write"
}

export function checksSummary(checks: readonly { status: "pass" | "warn" | "fail" }[]) {
  const pass = checks.filter((c) => c.status === "pass").length
  const warn = checks.filter((c) => c.status === "warn").length
  const fail = checks.filter((c) => c.status === "fail").length
  return { pass, warn, fail, ready: fail === 0 }
}

export function readySentence(s: { pass: number; warn: number; fail: number }): {
  title: string
  sub: string
} {
  if (s.fail > 0)
    return {
      title: `Can’t send yet: ${s.fail} check${s.fail === 1 ? "" : "s"} fail${s.fail === 1 ? "s" : ""}`,
      sub: "Scheduling and Send now stay locked until every failing check passes. Each fix button goes to the field, setting or domain that fixes it. Warnings don’t block.",
    }
  const warn = s.warn ? ` and ${s.warn} ${s.warn === 1 ? "is" : "are"} worth a look` : ""
  return {
    title: "Ready to send",
    sub: `${s.pass} check${s.pass === 1 ? "" : "s"} pass${s.pass === 1 ? "es" : ""}${warn}. Checks run again right before it sends.`,
  }
}

// ---------------------------------------------------------------------------------------------
// Who gets it: buckets in the API's order, and the sum written out (HAL-3429)
// ---------------------------------------------------------------------------------------------

export type PreviewLike = {
  matching: N
  sendable: N
  excluded: {
    blocked: N
    unsubscribed: N
    unconfirmed: N
    notOnTopic: N
    bySegment: readonly { segmentId: string; name: string; count: N }[]
    recentlySent: N
  }
}

export type Bucket = { key: string; label: string; count: number; group: "status" | "exclusion" }

export function previewBuckets(
  p: PreviewLike,
  opts: { topicName?: string | null | undefined; recentlySentDays?: N },
): { buckets: Bucket[]; leftOut: number; matching: number; sendable: number; addsUp: boolean } {
  const e = p.excluded
  const n = (v: N) => num(v) ?? 0
  const days = num(opts.recentlySentDays)
  const buckets: Bucket[] = [
    { key: "blocked", label: "Suppressed or blocked", count: n(e.blocked), group: "status" },
    { key: "unsubscribed", label: "Unsubscribed", count: n(e.unsubscribed), group: "status" },
    {
      key: "unconfirmed",
      label: "Not yet confirmed (double opt-in)",
      count: n(e.unconfirmed),
      group: "status",
    },
    {
      key: "notOnTopic",
      label: opts.topicName ? `Not on ${opts.topicName}` : "Not on the topic",
      count: n(e.notOnTopic),
      group: "status",
    },
    ...e.bySegment.map((s) => ({
      key: `seg:${s.segmentId}`,
      label: `In ${s.name}`,
      count: n(s.count),
      group: "exclusion" as const,
    })),
  ]
  if (days !== null || n(e.recentlySent) > 0)
    buckets.push({
      key: "recentlySent",
      label:
        days !== null
          ? `Mailed by another campaign in the last ${days} day${days === 1 ? "" : "s"}`
          : "Mailed recently by another campaign",
      count: n(e.recentlySent),
      group: "exclusion",
    })
  const leftOut = buckets.reduce((s, b) => s + b.count, 0)
  const matching = n(p.matching)
  const sendable = n(p.sendable)
  return { buckets, leftOut, matching, sendable, addsUp: sendable + leftOut === matching }
}

export const MAX_EXCLUDED_SEGMENTS = 10

/** The recently-sent field, as the API checks it: a whole number of days from 1 to 90, or empty. */
export function parseRecentDays(v: string): { value: number | null } | { error: string } {
  const s = v.trim()
  if (!s) return { value: null }
  if (!/^\d+$/.test(s)) return { error: "Leave out people mailed in the last 1 to 90 days." }
  const n = Number(s)
  if (n < 1 || n > 90) return { error: "Leave out people mailed in the last 1 to 90 days." }
  return { value: n }
}

// ---------------------------------------------------------------------------------------------
// Time zones: the schedule keeps an IANA `timezone` beside the UTC `sendAt` (HAL-3428)
// ---------------------------------------------------------------------------------------------

export function isTimeZone(tz: string): boolean {
  if (!tz.trim()) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz.trim() })
    return true
  } catch {
    return false
  }
}

/** The offset of a zone at an instant, in minutes east of UTC. */
export function zoneOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
}

/** A wall-clock date ("2026-10-20") and time ("10:00") in a zone, as UTC ms. */
export function zonedToUtc(date: string, time: string, tz: string): number | null {
  const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const t = time.match(/^(\d{2}):(\d{2})$/)
  if (!d || !t || !isTimeZone(tz)) return null
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]))
  let ms = guess - zoneOffset(guess, tz) * 60_000
  ms = guess - zoneOffset(ms, tz) * 60_000
  return ms
}

/** UTC ms as the wall clock in a zone: { date: "2026-10-20", time: "10:00" }. */
export function utcToZoned(ms: number, tz: string): { date: string; time: string } {
  const shifted = new Date(ms + zoneOffset(ms, tz) * 60_000)
  return {
    date: shifted.toISOString().slice(0, 10),
    time: `${p2(shifted.getUTCHours())}:${p2(shifted.getUTCMinutes())}`,
  }
}

export const COMMON_ZONES = [
  "Africa/Lagos",
  "Africa/Accra",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Africa/Cairo",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
]

/** Every IANA zone the browser knows, for the picker's suggestions. */
export function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  try {
    const list = intl.supportedValuesOf?.("timeZone")
    if (list?.length) return list.includes("UTC") ? list : [...list, "UTC"]
  } catch {}
  return COMMON_ZONES
}

// ---------------------------------------------------------------------------------------------
// Forecast (HAL-3429)
// ---------------------------------------------------------------------------------------------

export type ForecastDay = { day: string; available: N; queued: N; thisCampaign: N }

export type ForecastBar = {
  day: string
  label: string
  available: number
  queued: number
  mine: number
  free: number
  heightPct: number
  aria: string
}

/** One bar per day: height is that day's bulk share against the busiest day; inside it, queued, this, free. */
export function forecastBars(days: readonly ForecastDay[]): ForecastBar[] {
  const max = Math.max(1, ...days.map((d) => num(d.available) ?? 0))
  return days.map((d) => {
    const available = num(d.available) ?? 0
    const queued = Math.min(available, num(d.queued) ?? 0)
    const mine = Math.min(available - queued, num(d.thisCampaign) ?? 0)
    const free = Math.max(0, available - queued - mine)
    const date = new Date(`${d.day}T00:00:00Z`)
    const label = Number.isFinite(date.getTime()) ? `${DAYS[date.getUTCDay()]} ${date.getUTCDate()}` : d.day
    return {
      day: d.day,
      label,
      available,
      queued,
      mine,
      free,
      heightPct: Math.round((available / max) * 100),
      aria: `${label}: ${fmtInt(available)} available, ${fmtInt(queued)} queued ahead, ${fmtInt(mine)} this campaign`,
    }
  })
}

/** "Fri 23 Oct" from the forecast's "2026-10-23". */
export function fmtDayKey(day: string | null | undefined): string {
  if (!day) return "—"
  const d = new Date(`${day}T00:00:00Z`)
  if (!Number.isFinite(d.getTime())) return day
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export const INSUFFICIENT = "Not enough data yet (100 sends needed)"

/** "Opens by people" is opened − machineOnlyOpens, over delivered. */
export function humanOpens(opened: N, machineOnly: N): number {
  return Math.max(0, (num(opened) ?? 0) - (num(machineOnly) ?? 0))
}

export type ActivityPoint = { hour: number; opens: number; clicks: number }

/** 168 hourly columns from `startedAt`, the API's gaps filled with zeros. */
export function fillActivity(activity: readonly { hour: N; opens: N; clicks: N }[]): ActivityPoint[] {
  const out: ActivityPoint[] = Array.from({ length: 168 }, (_, hour) => ({ hour, opens: 0, clicks: 0 }))
  for (const a of activity) {
    const h = num(a.hour)
    if (h === null || h < 0 || h > 167) continue
    const slot = out[h]
    if (!slot) continue
    slot.opens += num(a.opens) ?? 0
    slot.clicks += num(a.clicks) ?? 0
  }
  return out
}

/** "Day 1, hour 0 · from Wed 30 Sep, 09:01 UTC · 50 opens, 11 clicks". It isn't an hour of the day. */
export function activityTitle(p: ActivityPoint, startedAt: N): string {
  const base = `Day ${Math.floor(p.hour / 24) + 1}, hour ${p.hour % 24}`
  const s = num(startedAt)
  const from = s === null ? "" : ` · from ${fmtWhen(s + p.hour * 3_600_000)}`
  return `${base}${from} · ${fmtInt(p.opens)} opens, ${fmtInt(p.clicks)} clicks`
}

export function activitySummary(points: readonly ActivityPoint[]) {
  const total = points.reduce((s, p) => s + p.opens, 0)
  const days = Array.from({ length: 7 }, (_, d) =>
    points.slice(d * 24, d * 24 + 24).reduce((s, p) => s + p.opens, 0),
  )
  const peak = points.reduce(
    (best, p) => (p.opens > best.opens ? p : best),
    points[0] ?? { hour: 0, opens: 0, clicks: 0 },
  )
  const firstDayShare = total ? Math.round(((days[0] ?? 0) / total) * 100) : 0
  const max = Math.max(0, ...points.map((p) => p.opens))
  return { total, days, peak, firstDayShare, max }
}

/** A round axis top for the chart: 60 for 50, 8 for 7. */
export function niceMax(v: number): number {
  if (v <= 4) return 4
  // A top that splits into four round ticks: 60 → 15, 30, 45, 60.
  const q = v / 4
  const mag = 10 ** Math.floor(Math.log10(q))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (m * mag >= q) return m * mag * 4
  return 40 * mag
}

/** Recipient status words, as the funnel and the table use them. */
export function recipientLabel(status: string, bounceType: string | null): string {
  const s = status.replace(/^./, (c) => c.toUpperCase())
  return status === "bounced" && bounceType ? `${s} · ${bounceType}` : s
}

export function recipientPill(status: string): string {
  if (["delivered", "opened", "clicked", "sent"].includes(status)) return "pill-pass"
  if (["bounced", "complained", "failed", "rejected"].includes(status)) return "pill-fail"
  if (status === "pending" || status === "deferred") return "pill-info"
  return "pill-neutral"
}

/** The link table's pill: the stored status, a timeout or unreachable error, or never followed. */
export function linkPill(l: { status: N; error: string | null }): {
  cls: string
  label: string
  mono: boolean
} {
  const s = num(l.status)
  if (l.error === "timed out") return { cls: "pill-warn", label: "Timed out", mono: false }
  if (l.error === "unreachable") return { cls: "pill-fail", label: "Unreachable", mono: false }
  if (l.error) return { cls: "pill-fail", label: l.error, mono: false }
  if (s === null) return { cls: "pill-neutral", label: "Not checked yet", mono: false }
  if (s >= 200 && s < 400) return { cls: "pill-pass", label: String(s), mono: true }
  return { cls: "pill-fail", label: String(s), mono: true }
}

// ---------------------------------------------------------------------------------------------
// Save conflicts (HAL-3428): what a stale save would have lost
// ---------------------------------------------------------------------------------------------

const DIFF_LABELS: Record<string, string> = {
  name: "Name",
  fromAddress: "From",
  replyTo: "Reply-to",
  subject: "Subject A",
  subjectB: "Subject B",
  preheader: "Preheader",
  ab: "Split test",
  bodyBlocks: "Body (blocks)",
  bodyHtml: "Body (HTML)",
  bodyText: "Plain-text part",
  templateId: "Template",
  segmentId: "Segment",
  topicId: "Topic",
  exclude: "Exclusions",
  trackOpens: "Track opens",
  trackClicks: "Track clicks",
  timezone: "Time zone",
}

export type Change = { field: string; label: string; yours: string }

/** The fields the draft changed against what was loaded, in words, for the conflict panel and the copy. */
export function unsavedChanges(loaded: Record<string, unknown>, draft: Record<string, unknown>): Change[] {
  const out: Change[] = []
  for (const k of Object.keys(DIFF_LABELS)) {
    if (!(k in draft)) continue
    if (JSON.stringify(loaded[k] ?? null) === JSON.stringify(draft[k] ?? null)) continue
    const v = draft[k]
    const yours =
      v === null || v === undefined
        ? "empty"
        : typeof v === "string"
          ? `“${v.length > 140 ? `${v.slice(0, 140)}…` : v}”`
          : typeof v === "boolean"
            ? v
              ? "on"
              : "off"
            : k === "bodyBlocks"
              ? `${(v as { blocks?: unknown[] }).blocks?.length ?? 0} blocks`
              : JSON.stringify(v)
    out.push({ field: k, label: DIFF_LABELS[k] ?? k, yours })
  }
  return out
}

export function changesAsText(changes: readonly Change[], draft: Record<string, unknown>): string {
  return changes
    .map((c) => {
      const v = draft[c.field]
      return `${c.label}:\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`
    })
    .join("\n\n")
}

/** A refusal for a stale save: `409 { reason: "stale", updatedAt, updatedBy }`. */
export function staleRefusal(
  e: unknown,
): { message: string; updatedAt: number | null; updatedBy: string | null } | null {
  if (!(e instanceof ApiError) || e.status !== 409 || e.body.reason !== "stale") return null
  return {
    message: e.message,
    updatedAt: num(e.body.updatedAt as N),
    updatedBy: typeof e.body.updatedBy === "string" ? e.body.updatedBy : null,
  }
}

// ---------------------------------------------------------------------------------------------
// Limited keys (HAL-3460): campaigns refuse keys with send limits
// ---------------------------------------------------------------------------------------------

export type AgentRefusal = {
  reason: "agent_limit" | "recipient_not_allowed"
  message: string
  notAllowed: string[]
  resetsAt: number | null
  requestId: string | undefined
}

export function agentRefusal(e: unknown): AgentRefusal | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null
  const r = e.body.reason
  if (r !== "agent_limit" && r !== "recipient_not_allowed") return null
  return {
    reason: r,
    message: e.message,
    notAllowed: Array.isArray(e.body.notAllowed) ? (e.body.notAllowed as string[]) : [],
    resetsAt: num(e.body.resetsAt as N),
    requestId: e.requestId,
  }
}

// ---------------------------------------------------------------------------------------------
// Audience line
// ---------------------------------------------------------------------------------------------

export function audienceLine(
  c: { segmentId: string | null; topicId: string | null },
  names: { segment?: string | undefined; topic?: string | undefined },
): string {
  if (c.segmentId) return `Segment · ${names.segment ?? c.segmentId}`
  if (c.topicId) return `Topic · ${names.topic ?? c.topicId}`
  return "No audience yet"
}

export function recipientsLine(size: N): string {
  const n = num(size)
  return n === null ? "— recipients" : `${fmtInt(n)} recipient${n === 1 ? "" : "s"}`
}

export const RECIPIENT_STATUSES = [
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "unsubscribed",
  "failed",
  "pending",
] as const
export type RecipientFilter = (typeof RECIPIENT_STATUSES)[number]
export const isRecipientStatus = (v: unknown): v is RecipientFilter =>
  typeof v === "string" && (RECIPIENT_STATUSES as readonly string[]).includes(v)

// ---------------------------------------------------------------------------------------------
// The report's funnel (HANDOFF-audience §6): complaints against deliveries, bounces against sends
// ---------------------------------------------------------------------------------------------

export type ReportLike = {
  audience: N
  sent: N
  delivered: N
  opened: N
  machineOnlyOpens: N
  clicked: N
  replied: N
  unsubscribed: N
  bounced: { hard: N; soft: N }
  complained: N
  failed: N
  insufficientData: boolean
  rates: {
    delivery: N
    open: N
    click: N
    clickToOpen: N
    bounce: N
    complaint: N
    unsubscribe: N
  }
  machineOpenShare: N
}

export type FunnelRow = {
  key: string
  label: string
  sub?: string
  count: number
  /** Bar widths, 0–100: the main segment, and machine-only opens after it. */
  width: number
  machine?: number
  color: string
  pct: string
  status?: RecipientFilter
  total?: boolean
  sepBefore?: boolean
}

const share = (a: N, b: N) => {
  const x = num(a) ?? 0
  const y = num(b) ?? 0
  return y > 0 ? x / y : 0
}
const w = (a: N, b: N) => Math.min(100, Math.round(share(a, b) * 10000) / 100)

/** One decimal, as the funnel's share column reads: "98.7%", "0.4%". */
export const fpct = (v: N) => {
  const x = num(v)
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`
}

export function funnelRows(r: ReportLike, replyTo?: string | null): FunnelRow[] {
  const no = r.insufficientData
  const p = (rate: N, fallback: () => number) =>
    no ? "—" : num(rate) !== null ? fpct(rate) : fpct(fallback())
  const human = humanOpens(r.opened, r.machineOnlyOpens)
  const at = replyTo ? replyTo.replace(/^.*<|>.*$/g, "").split("@")[0] : null
  return [
    {
      key: "audience",
      label: "Audience",
      count: num(r.audience) ?? 0,
      width: 100,
      color: "var(--data-neutral)",
      pct: "100.0%",
      total: true,
    },
    {
      key: "sent",
      label: "Sent",
      count: num(r.sent) ?? 0,
      width: w(r.sent, r.audience),
      color: "var(--data-neutral)",
      pct: no ? "—" : fpct(share(r.sent, r.audience)),
    },
    {
      key: "delivered",
      label: "Delivered",
      count: num(r.delivered) ?? 0,
      width: w(r.delivered, r.sent),
      color: "var(--data-good)",
      pct: p(r.rates.delivery, () => share(r.delivered, r.sent)),
      status: "delivered",
      sepBefore: true,
    },
    {
      key: "opened",
      label: "Opened",
      sub: `· ${fmtInt(human)} people · ${fmtInt(r.machineOnlyOpens)} machine`,
      count: num(r.opened) ?? 0,
      width: w(human, r.delivered),
      machine: w(r.machineOnlyOpens, r.delivered),
      color: "var(--data-good)",
      pct: p(r.rates.open, () => share(r.opened, r.delivered)),
      status: "opened",
    },
    {
      key: "clicked",
      label: "Clicked",
      count: num(r.clicked) ?? 0,
      width: w(r.clicked, r.delivered),
      color: "var(--data-transactional)",
      pct: p(r.rates.click, () => share(r.clicked, r.delivered)),
      status: "clicked",
    },
    {
      key: "replied",
      label: "Replied",
      ...(at ? { sub: `· landed in ${at}@` } : {}),
      count: num(r.replied) ?? 0,
      width: w(r.replied, r.delivered),
      color: "var(--data-campaign)",
      pct: no ? "—" : fpct(share(r.replied, r.delivered)),
    },
    {
      key: "unsubscribed",
      label: "Unsubscribed",
      count: num(r.unsubscribed) ?? 0,
      width: w(r.unsubscribed, r.delivered),
      color: "var(--data-warn)",
      pct: p(r.rates.unsubscribe, () => share(r.unsubscribed, r.delivered)),
      status: "unsubscribed",
    },
    {
      key: "hard",
      label: "Bounced hard",
      count: num(r.bounced.hard) ?? 0,
      width: w(r.bounced.hard, r.sent),
      color: "var(--data-bad-strong)",
      pct: no ? "—" : fpct(share(r.bounced.hard, r.sent)),
      status: "bounced",
      sepBefore: true,
    },
    {
      key: "soft",
      label: "Bounced soft",
      count: num(r.bounced.soft) ?? 0,
      width: w(r.bounced.soft, r.sent),
      color: "var(--data-bad-soft)",
      pct: no ? "—" : fpct(share(r.bounced.soft, r.sent)),
    },
    {
      key: "complained",
      label: "Complained",
      sub: "· of delivered",
      count: num(r.complained) ?? 0,
      width: w(r.complained, r.delivered),
      color: "var(--data-bad)",
      pct: p(r.rates.complaint, () => share(r.complained, r.delivered)),
      status: "complained",
    },
    {
      key: "failed",
      label: "Failed",
      count: num(r.failed) ?? 0,
      width: w(r.failed, r.sent),
      color: "var(--data-bad)",
      pct: no ? "—" : fpct(share(r.failed, r.sent)),
      status: "failed",
    },
  ]
}

/** The recipients as CSV, for the report's Export (every page, formula-safe). */
export function recipientsCsv(
  rows: readonly {
    email: string
    name: string | null
    status: string
    bounceType: string | null
    provider: string | null
    variant: string | null
    opens: N
    machineOpens: N
    clicks: N
    unsubscribed: boolean
    sentAt: N
    openedAt: N
    clickedAt: N
  }[],
): string {
  const esc = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const iso = (v: N) => {
    const t = num(v)
    return t === null ? "" : new Date(t).toISOString()
  }
  const head =
    "email,name,status,bounce_type,provider,variant,opens,machine_opens,clicks,unsubscribed,sent_at,opened_at,clicked_at"
  const lines = rows.map((r) =>
    [
      r.email,
      r.name,
      r.status,
      r.bounceType,
      r.provider,
      r.variant,
      num(r.opens),
      num(r.machineOpens),
      num(r.clicks),
      r.unsubscribed,
      iso(r.sentAt),
      iso(r.openedAt),
      iso(r.clickedAt),
    ]
      .map(esc)
      .join(","),
  )
  return `﻿${[head, ...lines].join("\r\n")}\r\n`
}

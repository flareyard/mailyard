/**
 * The Overview's pure logic: threshold levels, funnel percentages, stacked-bar scaling, the audience sparkline,
 * and the design's short time and number formats. Everything here is a plain function of its inputs, so the
 * tests in logic.test.ts pin the behaviour the screens depend on.
 */
import { num } from "../lib/format.ts"
import type { IconName } from "../ui/icons.tsx"

export type Range = "24h" | "7d" | "30d"
export type Wire = number | string | null | undefined

export const RANGES: { key: Range; label: string; shortcut: string }[] = [
  { key: "24h", label: "Last 24 hours", shortcut: "1" },
  { key: "7d", label: "Last 7 days", shortcut: "2" },
  { key: "30d", label: "Last 30 days", shortcut: "3" },
]
export const RANGE_LABEL: Record<Range, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
}

/** A wire number, or 0 when it is missing or not finite. */
export const n0 = (v: Wire): number => num(v) ?? 0

// ───────── rates against Cloudflare's thresholds ─────────

export type Level = "ok" | "warning" | "at-risk" | "insufficient-data"
export type Line = { warning_at: Wire; at_risk_at: Wire; minimum_denominator: Wire }
export type Policy = { customer_bounce: Line; complaint: Line; spam_rejection: Line }

/**
 * Cloudflare's published lines, used only when /v1/reputation can't be read. When it can, its `policy` (the
 * account's own) wins. Bounce 2% / 5%, complaint 0.1% / 0.2%, spam rejection 1% / 3%, rated from 100 sends.
 */
export const DEFAULT_POLICY: Policy = {
  customer_bounce: { warning_at: 0.02, at_risk_at: 0.05, minimum_denominator: 100 },
  complaint: { warning_at: 0.001, at_risk_at: 0.002, minimum_denominator: 100 },
  spam_rejection: { warning_at: 0.01, at_risk_at: 0.03, minimum_denominator: 100 },
}
export const MINIMUM_SENDS = 100

/**
 * The level of one rate. Under the minimum number of sends (or when the API says the range is insufficient, or
 * the rate is null) it is "insufficient-data": Cloudflare doesn't rate an account there, so neither do we.
 */
export function classifyRate(
  rate: Wire,
  line: Pick<Line, "warning_at" | "at_risk_at">,
  opts: { sent: Wire; minimum?: Wire; insufficient?: boolean } = { sent: MINIMUM_SENDS },
): Level {
  const r = num(rate)
  const minimum = num(opts.minimum) ?? MINIMUM_SENDS
  if (opts.insufficient || r === null || n0(opts.sent) < minimum) return "insufficient-data"
  const warn = n0(line.warning_at)
  const risk = n0(line.at_risk_at)
  if (r >= risk) return "at-risk"
  if (r >= warn) return "warning"
  return "ok"
}

export const LEVEL_PILL: Record<Level, { cls: string; label: string }> = {
  ok: { cls: "pill-pass", label: "Under warning" },
  warning: { cls: "pill-warn", label: "Warning" },
  "at-risk": { cls: "pill-fail", label: "At risk" },
  "insufficient-data": { cls: "pill-neutral", label: "Not enough data yet" },
}

/** The worst of several levels; all-insufficient stays insufficient. */
export function worstLevel(levels: Level[]): Level {
  for (const l of ["at-risk", "warning", "ok"] as const) if (levels.includes(l)) return l
  return "insufficient-data"
}

/**
 * Where the fill and the two lines sit on a threshold track, in percent. The track runs to 1.6 × the at-risk
 * line, so the at-risk line always sits at 62.5% and a rate past it still has room to show.
 */
export function thresholdGeometry(rate: Wire, warn: Wire, risk: Wire) {
  const scale = n0(risk) * 1.6 || 1
  const r = num(rate)
  return {
    fill: r === null ? 0 : Math.max(0, Math.min((r / scale) * 100, 100)),
    warnAt: (n0(warn) / scale) * 100,
    riskAt: (n0(risk) / scale) * 100,
  }
}

/** The design's rate format: two decimals under 1% ("0.06%"), one decimal from 1% ("2.0%"). */
export function fmtRate(v: Wire): string {
  const x = num(v)
  if (x === null) return "—"
  const p = x * 100
  return p < 1 ? `${p.toFixed(2)}%` : `${p.toFixed(1)}%`
}

// ───────── delivery funnel ─────────

export type DeliveryTotals = {
  sent: Wire
  delivered: Wire
  deferred: Wire
  bouncedHard: Wire
  bouncedSoft: Wire
  complained: Wire
  rejected: Wire
  failed: Wire
}
export type FunnelRow = {
  key: keyof DeliveryTotals
  label: string
  sub?: string
  status: string
  color: string
  count: number
  /** Bar width, percent of sent, unrounded. */
  width: number
  /** The label beside the bar: one decimal, or "—" when nothing was sent. */
  pct: string
}

const FUNNEL: {
  key: Exclude<keyof DeliveryTotals, "sent">
  label: string
  sub?: string
  status: string
  color: string
}[] = [
  { key: "delivered", label: "Delivered", status: "delivered", color: "var(--data-good)" },
  {
    key: "deferred",
    label: "Deferred",
    sub: "still retrying",
    status: "deferred",
    color: "var(--data-warn)",
  },
  { key: "bouncedHard", label: "Bounced hard", status: "bounced", color: "var(--data-bad-strong)" },
  { key: "bouncedSoft", label: "Bounced soft", status: "bounced", color: "var(--data-bad-soft)" },
  { key: "complained", label: "Complained", status: "complained", color: "var(--data-bad-strong)" },
  {
    key: "rejected",
    label: "Rejected",
    sub: "suppressed or policy",
    status: "rejected",
    color: "var(--data-bad-soft)",
  },
  { key: "failed", label: "Failed", status: "failed", color: "var(--data-bad)" },
]

/** Each outcome as a share of sent. Shares are of sent, so complaints (a subset of delivered) can overlap. */
export function funnelRows(t: DeliveryTotals): { sent: number; rows: FunnelRow[] } {
  const sent = n0(t.sent)
  return {
    sent,
    rows: FUNNEL.map((f) => {
      const count = n0(t[f.key])
      const width = sent > 0 ? Math.min(100, (count / sent) * 100) : 0
      return { ...f, count, width, pct: sent > 0 ? `${((count / sent) * 100).toFixed(1)}%` : "—" }
    }),
  }
}

/** Delivery time quantiles are bucket upper bounds: "≤ 2 s", "≤ 1 min", "≤ 3 h"; null means past the top bucket. */
export function fmtQuantile(ms: Wire, samples: Wire): string {
  const v = num(ms)
  if (v !== null) {
    const g = (x: number) => `${Number(x.toFixed(2))}`
    if (v < 60_000) return `≤ ${g(v / 1000)} s`
    if (v < 3_600_000) return `≤ ${g(v / 60_000)} min`
    return `≤ ${g(v / 3_600_000)} h`
  }
  return n0(samples) > 0 ? "over a day" : "none yet"
}

// ───────── volume by stream ─────────

export const STREAMS = ["transactional", "campaign", "automation", "mailbox"] as const
export type Stream = (typeof STREAMS)[number]
export type ByStream = Record<Stream, Wire>

export const STREAM_META: Record<Stream, { label: string; swatch: string; color: string }> = {
  transactional: { label: "Transactional", swatch: "swatch-tx", color: "var(--data-transactional)" },
  campaign: { label: "Campaign", swatch: "swatch-camp", color: "var(--data-campaign)" },
  automation: { label: "Automation", swatch: "swatch-auto", color: "var(--data-automation)" },
  mailbox: { label: "Mailbox", swatch: "swatch-mb", color: "var(--data-mailbox)" },
}

/** A round axis top with four even steps that holds `peak`: 149 → 200 (50s), 561 → 800 (200s). */
export function niceMax(peak: number): { top: number; step: number } {
  for (const step of [
    10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 25_000, 50_000, 100_000,
  ]) {
    if (peak <= step * 4) return { top: step * 4, step }
  }
  const step = 10 ** Math.ceil(Math.log10(peak / 4))
  return { top: step * 4, step }
}

export type BarSeg = { stream: Stream; value: number; height: number }
export type BarCol = { total: number; segs: BarSeg[]; values: Record<Stream, number> }

/** Stacked bars on a shared axis: each segment's height is its value over the axis top, in percent. */
export function stackBars(buckets: { byStream: ByStream }[]): {
  top: number
  step: number
  cols: BarCol[]
  totals: Record<Stream, number>
} {
  const cols0 = buckets.map((b) => {
    const values = Object.fromEntries(STREAMS.map((s) => [s, n0(b.byStream[s])])) as Record<Stream, number>
    return { values, total: STREAMS.reduce((a, s) => a + values[s], 0) }
  })
  const peak = Math.max(1, ...cols0.map((c) => c.total))
  const { top, step } = niceMax(peak)
  const totals = Object.fromEntries(
    STREAMS.map((s) => [s, cols0.reduce((a, c) => a + c.values[s], 0)]),
  ) as Record<Stream, number>
  return {
    top,
    step,
    totals,
    cols: cols0.map((c) => ({
      ...c,
      segs: STREAMS.filter((s) => c.values[s] > 0).map((s) => ({
        stream: s,
        value: c.values[s],
        height: (c.values[s] / top) * 100,
      })),
    })),
  }
}

/** Which x labels show: all of them when there are few, otherwise every `every`th counted back from the last. */
export function xLabelShown(i: number, count: number, every: number | null): boolean {
  if (every === null) return true
  return i % every === (count - 1) % every
}

// ───────── audience sparkline ─────────

/** Line segments for a 100 × 36 sparkline. A null day breaks the line (a gap, never a dip); a lone point is a dot. */
export function sparkPaths(values: (number | null)[]) {
  const known = values.filter((v): v is number => v !== null)
  if (!known.length)
    return {
      lines: [] as string[],
      dots: [] as [number, number][],
      gaps: values.length,
      first: null,
      last: null,
    }
  const lo = Math.min(...known)
  const span = Math.max(...known) - lo || 1
  const last = Math.max(1, values.length - 1)
  const segs: [number, number][][] = []
  let cur: [number, number][] = []
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) segs.push(cur)
      cur = []
      return
    }
    cur.push([(i / last) * 100, 32 - ((v - lo) / span) * 28])
  })
  if (cur.length) segs.push(cur)
  const pt = ([x, y]: [number, number]) => `${x.toFixed(2)},${y.toFixed(2)}`
  return {
    lines: segs.filter((s) => s.length > 1).map((s) => `M${s.map(pt).join(" L")}`),
    dots: segs.filter((s) => s.length === 1).map((s) => s[0] as [number, number]),
    gaps: values.filter((v) => v === null).length,
    first: known[0] ?? null,
    last: known[known.length - 1] ?? null,
  }
}

// ───────── cost ─────────

export function costBreakdown(month: { billed: Wire; included: Wire; projectedBilled: Wire }) {
  const included = n0(month.included)
  const billed = n0(month.billed)
  const projected = n0(month.projectedBilled)
  return {
    included,
    billed,
    projected,
    billedPct: included ? Math.min(100, (billed / included) * 100) : 100,
    projectedPct: included ? Math.min(100, (projected / included) * 100) : 100,
    projectedOverage: Math.max(0, projected - included),
  }
}

// ───────── health ─────────

export type ChipStatus = "pass" | "warn" | "fail" | "off" | "error" | "checking"

/** The worst of several DNS check statuses (used for the three return-path records). */
export function worstCheck(statuses: string[]): ChipStatus {
  if (statuses.includes("checking")) return "checking"
  for (const s of ["fail", "error", "warn"] as const) if (statuses.includes(s)) return s
  return "pass"
}

export const SERVICE_LABEL: Record<string, string> = {
  database: "Database",
  sending: "Send binding",
  domains: "Domains",
  delivery_events: "Delivery events",
  reputation: "Reputation",
  quota: "Quota",
  webhooks: "Webhooks",
}
export const SERVICE_CHIP: Record<string, ChipStatus> = {
  ok: "pass",
  warn: "warn",
  fail: "fail",
  unknown: "off",
}

/** The quota pill: red when over, amber from 80%, neutral otherwise. */
export function quotaPill(sent: number, quota: number, over: boolean | null): string {
  if (over) return "pill-fail"
  return quota > 0 && sent / quota >= 0.8 ? "pill-warn" : "pill-neutral"
}

// ───────── activity ─────────

export function feedIcon(kind: string): IconName {
  if (kind.startsWith("alert.")) return "bell"
  if (kind === "email.bounced") return "x-circle"
  if (kind === "email.complained") return "ban"
  const noun = kind.split(".")[1] ?? ""
  const map: Record<string, IconName> = {
    campaign: "campaigns",
    automation: "automations",
    domain: "domains",
    rule: "filter",
    contact: "user",
    webhook: "webhook",
    mailbox: "envelope",
    template: "file",
    key: "key",
    member: "user-plus",
    import: "inbound",
  }
  return map[noun] ?? "pulse"
}

export function actorLabel(a: { type: "key" | "system"; id: string; name: string | null } | null): string {
  if (a === null) return "From a delivery event"
  if (a.type === "system") return "System"
  return a.id === "root" ? "Admin key" : `Key: ${a.name ?? a.id}`
}

/** The web-app route a feed subject opens (HANDOFF §2 entity routes). */
export function subjectHref(s: { type: string; id: string }): string {
  const id = encodeURIComponent(s.id)
  switch (s.type) {
    case "domain":
      return `/domains/${id}`
    case "campaign":
      return `/campaigns/${id}`
    case "contact":
      return `/audience/contacts/${id}`
    case "automation":
      return `/automations/${id}`
    case "webhook":
      return `/transactional/webhooks/${id}`
    case "template":
      return `/transactional/templates/${id}`
    case "rule":
      return `/settings/rules/${id}`
    case "mailbox":
      return `/mail/${id}`
    default:
      return `/${s.type}s/${id}`
  }
}

/** Splits feed text around the subject's label so only the label is a link; falls back to linking all of it. */
export function splitOnLabel(text: string, label: string | null): [string, string, string] | null {
  if (!label) return null
  const i = text.indexOf(label)
  return i < 0 ? null : [text.slice(0, i), label, text.slice(i + label.length)]
}

// ───────── time ─────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const p2 = (x: number) => String(x).padStart(2, "0")

/** "18 min ago", "8 h ago", "3 d ago"; a date from 7 days on (HANDOFF §5: relative under 7 days). */
export function ago(at: Date | null, now = Date.now()): string {
  if (!at) return "—"
  const m = Math.floor((now - at.getTime()) / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} d ago`
  return longDate(at)
}

export const hhmm = (d: Date) => `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
/** "1 Oct" */
export const shortDate = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
/** "16 Oct 2026" */
export const longDate = (d: Date) => `${shortDate(d)} ${d.getUTCFullYear()}`
/** "Tue 20 Oct, 09:00" (UTC) */
export const dayTime = (d: Date) => `${DAYS[d.getUTCDay()]} ${shortDate(d)}, ${hhmm(d)}`
/** "Mon" */
export const weekday = (d: Date) => DAYS[d.getUTCDay()] ?? ""
/** "Mon 12 Oct" */
export const dayLabel = (d: Date) => `${weekday(d)} ${shortDate(d)}`
/** Is `d` on the same UTC day as `now`? */
export const sameUtcDay = (d: Date, now = new Date()) =>
  d.getUTCFullYear() === now.getUTCFullYear() &&
  d.getUTCMonth() === now.getUTCMonth() &&
  d.getUTCDate() === now.getUTCDate()

/** A YYYY-MM-DD day as a UTC date. */
export const parseDay = (s: string) => new Date(`${s}T00:00:00Z`)

/** Range keys: 1, 2, 3 switch the range unless focus is in something you type into. */
export function rangeForKey(key: string): Range | null {
  return RANGES.find((r) => r.shortcut === key)?.key ?? null
}
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable === true
  )
}

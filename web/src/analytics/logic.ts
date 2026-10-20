/**
 * Analytics' pure logic: ranges per view, chart geometry (stacked bars, line charts with gaps and hatching,
 * histograms, the weekday × hour heatmap), the delivery-time wording, the CSV catalogue and the forecast strip.
 * Plain functions of their inputs, pinned by logic.test.ts.
 */
import { fmtCompact, num } from "../lib/format.ts"
import { pct } from "../ops/format.ts"

export type Wire = number | string | null | undefined
export const n0 = (v: Wire): number => num(v) ?? 0

// ───────── ranges and views ─────────

export type Range = "24h" | "7d" | "30d" | "90d"
export type View = "sending" | "engagement" | "inbound" | "audience" | "reputation" | "usage"

export const VIEWS: { key: View; label: string; ninety: boolean }[] = [
  { key: "sending", label: "Sending", ninety: false },
  { key: "engagement", label: "Engagement", ninety: false },
  { key: "inbound", label: "Inbound", ninety: true },
  { key: "audience", label: "Audience", ninety: true },
  { key: "reputation", label: "Reputation", ninety: false },
  { key: "usage", label: "Usage and cost", ninety: false },
]

export const DEFAULT_RANGE: Range = "7d"

export const RANGE_META: Record<Range, { label: string; shortcut: string; meta: string }> = {
  "24h": { label: "Last 24 hours", shortcut: "1", meta: "last 24 hours" },
  "7d": { label: "Last 7 days", shortcut: "2", meta: "last 7 days" },
  "30d": { label: "Last 30 days", shortcut: "3", meta: "last 30 days" },
  "90d": { label: "Last 90 days", shortcut: "4", meta: "last 90 days" },
}

export const isRange = (v: unknown): v is Range => v === "24h" || v === "7d" || v === "30d" || v === "90d"

/** The ranges a view offers: inbound and audience go back 90 days (HAL-3362); the rest stop at 30. */
export const rangesFor = (view: View | null): Range[] =>
  VIEWS.find((v) => v.key === view)?.ninety ? ["24h", "7d", "30d", "90d"] : ["24h", "7d", "30d"]

/** The range a view actually asks for: 90d on a 30-day view reads 30d, as the API itself would. */
export function effectiveRange(view: View | null, range: Range): Exclude<Range, "90d"> | Range {
  return rangesFor(view).includes(range) ? range : "30d"
}

/** For endpoints that stop at 30 days. */
export const short = (r: Range): "24h" | "7d" | "30d" => (r === "90d" ? "30d" : r)

export const viewFromPath = (pathname: string): View | null => {
  const seg = pathname.split("/").filter(Boolean)[1] ?? "sending"
  return VIEWS.some((v) => v.key === seg) ? (seg as View) : null
}

// ───────── axes and bars ─────────

/** A round axis top with four even steps that holds `peak`: 149 → 200 (50s), 561 → 800 (200s). */
export function niceMax(peak: number): { top: number; step: number } {
  for (const step of [
    1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 25_000, 50_000,
  ]) {
    if (peak <= step * 4) return { top: step * 4, step }
  }
  const step = 10 ** Math.ceil(Math.log10(peak / 4))
  return { top: step * 4, step }
}

export const STREAMS = ["transactional", "campaign", "automation", "mailbox"] as const
export type Stream = (typeof STREAMS)[number]
export const STREAM_META: Record<Stream, { label: string; color: string }> = {
  transactional: { label: "Transactional", color: "var(--data-transactional)" },
  campaign: { label: "Campaign", color: "var(--data-campaign)" },
  automation: { label: "Automation", color: "var(--data-automation)" },
  mailbox: { label: "Mailbox", color: "var(--data-mailbox)" },
}

export type BarCol = {
  total: number
  values: Record<Stream, number>
  segs: { stream: Stream; height: number }[]
}

/** Stacked bars on a shared axis: each segment's height is its value over the axis top, in percent. */
export function stackBars(buckets: { byStream: Partial<Record<Stream, Wire>> }[]) {
  const raw = buckets.map((b) => {
    const values = Object.fromEntries(STREAMS.map((s) => [s, n0(b.byStream[s])])) as Record<Stream, number>
    return { values, total: STREAMS.reduce((a, s) => a + values[s], 0) }
  })
  const { top, step } = niceMax(Math.max(1, ...raw.map((c) => c.total)))
  const totals = Object.fromEntries(
    STREAMS.map((s) => [s, raw.reduce((a, c) => a + c.values[s], 0)]),
  ) as Record<Stream, number>
  const cols: BarCol[] = raw.map((c) => ({
    ...c,
    segs: STREAMS.filter((s) => c.values[s] > 0).map((s) => ({
      stream: s,
      height: (c.values[s] / top) * 100,
    })),
  }))
  return { top, step, totals, cols }
}

/** Which x labels show: all when few, otherwise every `every`th counted back from the last. */
export function xLabelShown(i: number, count: number, every: number | null): boolean {
  if (every === null) return true
  return i % every === (count - 1) % every
}

// ───────── line charts ─────────

const fx = (n: number) => n.toFixed(2)

/**
 * A line chart in a 100 × 100 box: one area and line per run of known values, so a null day breaks the line
 * (a gap, never a dip). A lone known value draws a short flat stroke so it stays visible.
 */
export function linePaths(values: (number | null)[], top: number): { area: string; line: string }[] {
  const n = values.length
  if (!n || top <= 0) return []
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100)
  const y = (v: number) => 100 - Math.max(0, Math.min(v / top, 1)) * 100
  const runs: [number, number][][] = []
  let cur: [number, number][] = []
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) runs.push(cur)
      cur = []
    } else cur.push([x(i), y(v)])
  })
  if (cur.length) runs.push(cur)
  return runs.map((run) => {
    const pts =
      run.length === 1 && run[0]
        ? [
            [Math.max(0, run[0][0] - 0.8), run[0][1]] as [number, number],
            [Math.min(100, run[0][0] + 0.8), run[0][1]] as [number, number],
          ]
        : run
    const first = pts[0] as [number, number]
    const last = pts[pts.length - 1] as [number, number]
    const line = `M${pts.map(([a, b]) => `${fx(a)},${fx(b)}`).join(" L")}`
    return { line, area: `${line} L${fx(last[0])},100 L${fx(first[0])},100 Z` }
  })
}

/**
 * Hatched spans for flagged points (days under 100 sends, days without a snapshot), as left and width in
 * percent: a run from point i to j covers i → j + 1, so the hatching reaches the next real point.
 */
export function hatchSpans(flags: boolean[]): { left: number; width: number }[] {
  const n = flags.length
  if (!n) return []
  if (n === 1) return flags[0] ? [{ left: 0, width: 100 }] : []
  const unit = 100 / (n - 1)
  const out: { left: number; width: number }[] = []
  let start = -1
  flags.forEach((f, i) => {
    if (f && start < 0) start = i
    if ((!f || i === n - 1) && start >= 0) {
      const end = f ? i : i - 1
      const left = start * unit
      out.push({ left, width: Math.min(100 - left, (end - start + 1) * unit) })
      start = -1
    }
  })
  return out
}

/** A rate axis that always shows the at-risk line: the top is 1.2 × at-risk (5% → 6%), or the peak if higher. */
export function rateAxis(values: (number | null)[], risk: number) {
  const peak = Math.max(0, ...values.filter((v): v is number => v !== null))
  const top = Math.max(risk * 1.2, peak * 1.1) || 0.01
  const digits = top < 0.01 ? 2 : 1
  return {
    top,
    ticks: [0, 1, 2, 3, 4].map((i) => ({
      bottom: i * 25,
      label: `${(((top * i) / 4) * 100).toFixed(digits)}%`,
    })),
    at: (v: number) => Math.min(100, (v / top) * 100),
  }
}

/** A count axis on round steps; `compact` writes thousands as 1.3k. */
export function countAxis(values: (number | null)[], compact = false) {
  const peak = Math.max(1, ...values.filter((v): v is number => v !== null))
  const { top, step } = niceMax(peak)
  return {
    top,
    ticks: [0, 1, 2, 3, 4].map((i) => ({
      bottom: i * 25,
      label: compact ? fmtCompact(step * i) : new Intl.NumberFormat("en").format(step * i),
    })),
  }
}

// ───────── delivery time ─────────

const durationWord = (ms: number) => {
  if (ms >= 86_400_000) return ms === 86_400_000 ? "a day" : `${Math.round(ms / 86_400_000)} days`
  if (ms >= 3_600_000) return `${Number((ms / 3_600_000).toFixed(1))} h`
  if (ms >= 60_000) return `${Number((ms / 60_000).toFixed(1))} min`
  return `${Number((ms / 1000).toFixed(2))} s`
}

/** A quantile is its bucket's upper bound: "under 5 s"; null is "over a day" with samples, else "none yet". */
export function quantile(ms: Wire, samples: Wire): string {
  const v = num(ms)
  if (v !== null) return `under ${durationWord(v)}`
  return n0(samples) > 0 ? "over a day" : "none yet"
}

/** A histogram bucket's label: "< 1 s", "< 1 min", "< a day"; the open bucket is "a day or more". */
export const bucketLabel = (underMs: Wire) => {
  const v = num(underMs)
  return v === null ? "a day or more" : `< ${durationWord(v)}`
}

export function histogram(buckets: { underMs: Wire; n: Wire }[]) {
  const peak = Math.max(1, ...buckets.map((b) => n0(b.n)))
  return buckets.map((b) => ({ label: bucketLabel(b.underMs), n: n0(b.n), width: (n0(b.n) / peak) * 100 }))
}

// ───────── providers and deferrals ─────────

const PROVIDER_NAMES: Record<string, string> = {
  gmail: "Gmail",
  microsoft: "Microsoft",
  yahoo: "Yahoo",
  apple: "Apple",
  other: "Other",
  proton: "Proton",
  zoho: "Zoho",
  fastmail: "Fastmail",
}
export const providerName = (p: string | null | undefined) =>
  p ? (PROVIDER_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1)) : "No provider"

export const deliveredShare = (delivered: Wire, total: Wire) => (n0(total) ? n0(delivered) / n0(total) : null)

// ───────── engagement heatmap ─────────

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
export type Metric = "opens" | "clicks"
type ByHour = { weekday: string; hours: { hour: Wire; opens: Wire; clicks: Wire }[] }[]

/** A full 7 × 24 grid (missing hours are 0), each cell's share of the busiest cell, and the busiest window. */
export function heatGrid(byHour: ByHour, metric: Metric) {
  const rows = WEEKDAYS.map((d) => {
    const src = byHour.find((r) => r.weekday === d)
    return {
      weekday: d,
      cells: Array.from({ length: 24 }, (_, h) => {
        const c = src?.hours.find((x) => n0(x.hour) === h)
        return { hour: h, opens: n0(c?.opens), clicks: n0(c?.clicks) }
      }),
    }
  })
  const peak = Math.max(0, ...rows.flatMap((r) => r.cells.map((c) => c[metric])))
  const grid = rows.map((r) => ({
    ...r,
    cells: r.cells.map((c) => ({ ...c, p: peak ? Math.round((c[metric] / peak) * 100) : 0 })),
  }))
  // The busiest three-hour window across weekdays, for the chart's text alternative.
  let best = { start: 0, sum: -1 }
  for (let h = 0; h < 22; h++) {
    const sum = grid
      .slice(0, 5)
      .reduce(
        (a, r) =>
          a + (r.cells[h]?.[metric] ?? 0) + (r.cells[h + 1]?.[metric] ?? 0) + (r.cells[h + 2]?.[metric] ?? 0),
        0,
      )
    if (sum > best.sum) best = { start: h, sum }
  }
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`
  const summary = peak
    ? `Most ${metric} fall between ${hh(best.start)} and ${hh(best.start + 3)} UTC on weekdays`
    : `No ${metric} in this range`
  return { grid, peak, summary }
}

// ───────── CSV ─────────

export const CSV_CHARTS = [
  { chart: "volume", name: "Volume by stream", ninety: false },
  { chart: "delivery", name: "Delivery totals and rates by day", ninety: false },
  { chart: "providers", name: "Mailbox providers", ninety: false },
  { chart: "deferrals", name: "Deferral reasons", ninety: false },
  { chart: "engagement", name: "Engagement by campaign", ninety: false },
  { chart: "engagement-hours", name: "Opens and clicks by weekday and hour", ninety: false },
  { chart: "unsubscribes", name: "Unsubscribes by topic", ninety: false },
  { chart: "inbound", name: "Inbound mail", ninety: true },
  { chart: "audience", name: "Audience", ninety: true },
] as const
export type Chart = (typeof CSV_CHARTS)[number]["chart"]

/** The CSV for a chart at a range: volume adds by=hour for 24h, by=day otherwise; 30-day charts read 30d for 90d. */
export function csvFor(chart: Chart, range: Range) {
  const meta = CSV_CHARTS.find((c) => c.chart === chart)
  const r = meta?.ninety ? range : short(range)
  const params = new URLSearchParams({ range: r })
  if (chart === "volume") params.set("by", r === "24h" ? "hour" : "day")
  if (chart === "delivery" && r !== "24h") params.set("by", "day")
  return {
    path: `/v1/stats/${chart}.csv?${params.toString().replace(/%2C/g, ",")}`,
    file: `${chart}-${r}.csv`,
    range: r,
  }
}

// ───────── usage ─────────

/** "3,400" → 3400; anything that isn't a positive whole number is null. */
export function parseRecipients(v: string): number | null {
  const n = Number(v.replace(/[\s,_]/g, ""))
  return Number.isInteger(n) && n > 0 ? n : null
}

/** The forecast strip: this send's share of each day's quota, with Today first and weekdays after. */
export function forecastStrip(days: { day: string; thisCampaign: Wire }[], quota: Wire) {
  const q = n0(quota) || Math.max(1, ...days.map((d) => n0(d.thisCampaign)))
  return days.map((d, i) => ({
    label:
      i === 0
        ? "Today"
        : new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en", { weekday: "short", timeZone: "UTC" }),
    height: Math.min(100, Math.round((n0(d.thisCampaign) / q) * 100)),
    n: n0(d.thisCampaign),
  }))
}

/** Bytes as the design writes storage: decimal units, "1.93 GB", "48.2 MB". */
export function fmtStorage(v: Wire): { value: string; unit: string } {
  const n = num(v)
  if (n === null) return { value: "—", unit: "" }
  const units = ["B", "KB", "MB", "GB", "TB"]
  let x = n
  let i = 0
  while (x >= 1000 && i < units.length - 1) {
    x /= 1000
    i++
  }
  const value = i === 0 || x >= 100 ? String(Math.round(x)) : String(Number(x.toPrecision(3)))
  return { value, unit: units[i] ?? "B" }
}
export const storageText = (v: Wire) => {
  const s = fmtStorage(v)
  return s.unit ? `${s.value} ${s.unit}` : s.value
}

/** The month's cost lines, from the API's own figures (no client-side pricing). */
export function monthLines(m: {
  billed: Wire
  included: Wire
  overage: Wire
  costUsd: Wire
  projectedBilled: Wire
  projectedCostUsd: Wire
}) {
  const included = n0(m.included)
  const billed = n0(m.billed)
  const projected = n0(m.projectedBilled)
  return {
    included,
    billed,
    projected,
    billedPct: included ? Math.min(100, (billed / included) * 100) : 100,
    projectedPct: included ? Math.min(100, (projected / included) * 100) : 100,
    overage: n0(m.overage),
    projectedOverage: Math.max(0, projected - included),
  }
}

/** The rate a figure shows: "Not enough data yet" under the minimum, never a misleading percentage. */
export const rateOrWait = (v: Wire, insufficient: boolean) =>
  insufficient || num(v) === null ? null : pct(v)

/** What `recipients` more sends this month add to the bill, from the API's own pricing (forecast's cost arm). */
export function extraCost(billed: Wire, included: Wire, usdPerThousand: Wire, recipients: number) {
  const b = n0(billed)
  const inc = n0(included)
  const over = (x: number) => Math.max(0, x - inc)
  return ((over(b + recipients) - over(b)) * n0(usdPerThousand)) / 1000
}

/** Typing in a field never changes the range. */
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

/** The range a digit picks among the ones offered ("1" → first). */
export function rangeForKey(key: string, offered: Range[]): Range | null {
  const i = Number(key) - 1
  return Number.isInteger(i) && i >= 0 ? (offered[i] ?? null) : null
}

export type AnalyticsSearch = { range?: Range; export?: 1; fx?: string }

/** The section's search: 7d stays out of the URL; `fx` (a fixture state) is kept only in fixture mode. */
export function parseSearch(s: Record<string, unknown>, fixtures: boolean): AnalyticsSearch {
  return {
    ...(isRange(s.range) && s.range !== DEFAULT_RANGE ? { range: s.range } : {}),
    ...(s.export === 1 || s.export === "1" || s.export === true ? { export: 1 as const } : {}),
    ...(fixtures && typeof s.fx === "string" && /^[a-z-]{1,32}$/.test(s.fx) ? { fx: s.fx } : {}),
  }
}

/** A threshold's value as the designs label it, keeping the zero: "2.0%", "0.10%". */
export function fmtLine(v: Wire): string {
  const x = num(v)
  if (x === null) return "—"
  const p = x * 100
  return p < 1 ? `${p.toFixed(2)}%` : `${p.toFixed(1)}%`
}

/** An Email Routing rejection count (HAL-3393): a number, or "—" when that one wasn't reported. */
export const upstreamCount = (v: number | string | null | undefined): string => {
  const n = num(v)
  return n === null ? "—" : new Intl.NumberFormat("en").format(n)
}

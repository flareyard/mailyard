/**
 * A contact's page, as pure functions (design: contact*.html; GAPS-audience A1.4–A1.6, A6.1): the timeline's
 * day groups and item lines, each topic's consent sentence, and the suppression panel's words.
 */
import { num, toDate } from "../../lib/format.ts"
import { fmtAgoShort, fmtDay, fmtTime } from "../kit/format.ts"

export const TIMELINE_KINDS = [
  "event",
  "message",
  "delivery",
  "subscription",
  "consent",
  "reply",
  "automation",
] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]
export const KIND_LABEL: Record<TimelineKind, string> = {
  event: "Events",
  message: "Messages",
  delivery: "Delivery",
  subscription: "Topics",
  consent: "Consent",
  reply: "Replies",
  automation: "Automations",
}

/** `?kind=` holds a comma list in the canonical order; empty means every kind. */
export function parseKinds(v: unknown): TimelineKind[] {
  if (typeof v !== "string") return []
  const want = v.split(",").map((s) => s.trim())
  return TIMELINE_KINDS.filter((k) => want.includes(k))
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** The day header a timestamp falls under, in UTC: “Today”, “Yesterday”, “Wed 14 Oct”, “Wed 11 Mar 2025”. */
export function dayLabel(at: number, now = Date.now()): string {
  const d = new Date(at)
  const n = new Date(now)
  const key = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
  const diff = Math.round((key(n) - key(d)) / 86_400_000)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  const base = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  return d.getUTCFullYear() === n.getUTCFullYear() ? base : `${base} ${d.getUTCFullYear()}`
}

/** Groups items (newest first, as the API sends them) under their day labels, keeping the order. */
export function groupByDay<T extends { at: number | string }>(items: readonly T[], now = Date.now()) {
  const out: { day: string; items: T[] }[] = []
  for (const it of items) {
    const at = num(it.at as number) ?? 0
    const day = dayLabel(at, now)
    const last = out[out.length - 1]
    if (last && last.day === day) last.items.push(it)
    else out.push({ day, items: [it] })
  }
  return out
}

/** “14:48”: the item's clock, UTC like every time here (the zone is on the day header’s page). */
export const itemTime = (at: number | string) => fmtTime(at).replace(" UTC", "")

const DELIVERY_VERB: Record<string, string> = {
  "email.delivered": "Delivered",
  "email.deferred": "Deferred",
  "email.bounced": "Bounced",
  "email.complained": "Marked as spam",
  "email.opened": "Opened",
  "email.clicked": "Clicked",
  "message.delivered": "Delivered",
  "message.deferred": "Deferred",
  "message.bounced": "Bounced",
  "message.complained": "Marked as spam",
}
export const deliveryVerb = (event: string) =>
  DELIVERY_VERB[event] ?? event.replace(/^[a-z]+\./, "").replace(/^./, (c) => c.toUpperCase())

/** Delivery events that went wrong get a red dot; the rest pass. */
export const deliveryTone = (event: string) =>
  /bounced|complained|failed|rejected/.test(event)
    ? "is-fail"
    : /deferred/.test(event)
      ? "is-warn"
      : "is-pass"

export const messageTone = (status: string) =>
  /bounced|failed|rejected|complained/.test(status)
    ? "is-fail"
    : /deferred|queued|sending/.test(status)
      ? "is-warn"
      : "is-pass"

const STREAM: Record<string, string> = {
  campaign: "Campaign email",
  automation: "Automation email",
  transactional: "Transactional email",
  mailbox: "Mailbox message",
  test: "Test send",
}
export const streamLabel = (s: string) => STREAM[s] ?? `${s.replace(/^./, (c) => c.toUpperCase())} email`

/** An event's data as one short line: `course Data foundations · lesson 6`. */
export function dataLine(data: unknown, max = 4): string | null {
  if (!data || typeof data !== "object") return null
  const parts = Object.entries(data as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .slice(0, max)
    .map(([k, v]) => `${k} ${String(v)}`)
  return parts.length ? parts.join(" · ") : null
}

/** A delivery's detail worth a line: the link clicked, the provider, the SMTP answer. */
export function deliveryMeta(data: unknown): string[] {
  if (!data || typeof data !== "object") return []
  const d = data as Record<string, unknown>
  return ["url", "link", "provider", "response", "reason", "diagnostic"]
    .map((k) => d[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0)
}

export type TopicState = {
  topicId: string
  name: string
  state: "subscribed" | "unconfirmed" | "unsubscribed"
  changedAt?: number | string | undefined
  source?: string | undefined
  confirmedAt?: number | string | null | undefined
}

/**
 * The consent line under a topic (A1.4): “Subscribed 11 Mar via `import:imp_01J8` · confirmed by double opt-in
 * on 12 Mar 2026”; “Never subscribed” for a topic they've no row for; the source is quoted as the API stores it.
 */
export function consentParts(t: TopicState | undefined, now = Date.now()) {
  if (!t) return { text: "Never subscribed", source: null as string | null, confirmed: null as string | null }
  const verb =
    t.state === "subscribed"
      ? "Subscribed"
      : t.state === "unconfirmed"
        ? "Waiting for confirmation"
        : "Unsubscribed"
  const when =
    t.changedAt !== undefined && toDate(t.changedAt) ? ` ${fmtAgoShortOrDay(t.changedAt, now)}` : ""
  const confirmed = t.confirmedAt ? `confirmed by double opt-in on ${fmtDayFull(t.confirmedAt)}` : null
  return { text: `${verb}${when}`, source: t.source ?? null, confirmed }
}

function fmtAgoShortOrDay(v: number | string, now: number) {
  const d = toDate(v)
  if (!d) return ""
  return now - d.getTime() < 7 * 86_400_000 ? fmtAgoShort(v, now) : fmtDay(v, now)
}

function fmtDayFull(v: number | string) {
  const d = toDate(v)
  if (!d) return "—"
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} UTC`
}

export const SUPPRESSION_REASON: Record<string, string> = {
  hard_bounce: "Hard bounce",
  complaint: "Complaint",
  unsubscribe: "Unsubscribe",
  manual: "Added by hand",
}
export const SUPPRESSION_SOURCE: Record<string, string> = {
  events: "A delivery event",
  cloudflare: "Cloudflare’s list",
  manual: "Added by hand",
  import: "A suppression import",
}

/**
 * The field a skipped send named, read from `?field=` (linked from a skipped automation step), checked against
 * a registry key so a stray value highlights nothing.
 */
export function highlightField(v: unknown, keys: readonly string[]): string | null {
  return typeof v === "string" && keys.includes(v) ? v : null
}

/**
 * A typed field value from what was typed, as the API stores it: numbers as numbers, yes/no as booleans, dates
 * as ISO strings; an empty input clears the field (null). Null with an error when it doesn't fit the type.
 */
export function typedInput(
  type: string | undefined,
  raw: string,
): { value: string | number | boolean | null } | { error: string } {
  const v = raw.trim()
  if (v === "") return { value: null }
  if (type === "number") {
    const n = Number(v.replace(/,/g, ""))
    return Number.isFinite(n) ? { value: n } : { error: `“${v}” isn’t a number.` }
  }
  if (type === "boolean") {
    const l = v.toLowerCase()
    if (["true", "yes", "y", "1"].includes(l)) return { value: true }
    if (["false", "no", "n", "0"].includes(l)) return { value: false }
    return { error: "Use yes or no." }
  }
  if (type === "date") {
    const ms = Date.parse(v)
    return Number.isNaN(ms)
      ? { error: `“${v}” isn’t a date. Use 2026-03-11.` }
      : { value: new Date(ms).toISOString().slice(0, 10) }
  }
  return { value: v }
}

/** A stored field value as the profile's input shows it. */
export function inputValue(v: unknown, type: string | undefined): string {
  if (v === null || v === undefined) return ""
  if (type === "boolean") return v === true ? "yes" : v === false ? "no" : String(v)
  if (type === "date" && typeof v === "string") return v.slice(0, 10)
  return String(v)
}

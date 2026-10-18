/**
 * Formatting shared by Audience, Campaigns and Automations. Every time on these screens is UTC with the zone
 * written out (HANDOFF-audience §6); rates are fractions and go through `pct`.
 */

import { ApiError } from "../../api/client.ts"
import { fmtInt, num, toDate } from "../../lib/format.ts"

type N = number | string | null | undefined

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const p2 = (n: number) => String(n).padStart(2, "0")

/** "11 Mar", or "11 Mar 2025" when it isn't this year. */
export function fmtDay(v: N, now = Date.now()): string {
  const d = toDate(v)
  if (!d) return "—"
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear()
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${sameYear ? "" : ` ${d.getUTCFullYear()}`}`
}

/** "17:46 UTC". */
export function fmtTime(v: N): string {
  const d = toDate(v)
  return d ? `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC` : "—"
}

/** "18 Oct 2026, 17:46 UTC". */
export function fmtDateTime(v: N): string {
  const d = toDate(v)
  if (!d) return "—"
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`
}

/** "Tue 20 Oct". */
export function fmtWeekday(v: N): string {
  const d = toDate(v)
  if (!d) return "—"
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** "2 h ago" style, short, for dense tables: "just now", "12 min ago", "5 h ago", "3 d ago", then the day. */
export function fmtAgoShort(v: N, now = Date.now()): string {
  const d = toDate(v)
  if (!d) return "—"
  const s = Math.round((now - d.getTime()) / 1000)
  if (s < 0) return fmtDay(v, now)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  const h = Math.round(s / 3600)
  if (h < 24) return `${h} h ago`
  const days = Math.max(1, Math.round(s / 86_400))
  if (days < 7) return `${days} d ago`
  return fmtDay(v, now)
}

/** A rate (a fraction) as a percentage; "—" for null. */
export function pct(v: N, digits = 1): string {
  const n = num(v)
  if (n === null) return "—"
  const s = (n * 100).toFixed(digits)
  return `${s.replace(/\.0+$/, "")}%`
}

/** "1 contact" / "4,812 contacts". */
export function plural(n: N, one: string, many = `${one}s`): string {
  const v = num(n) ?? 0
  return `${fmtInt(v)} ${v === 1 ? one : many}`
}

/** "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/** A 400's message when its `field` names this field (exactly, or a path under it). */
export function fieldError(error: unknown, field: string, opts: { prefix?: boolean } = {}): string | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null
  const f = error.body.field
  if (typeof f !== "string") return null
  if (f === field || (opts.prefix && (f.startsWith(`${field}.`) || f.startsWith(`${field}[`))))
    return error.message
  return null
}

/** The `field` a 400 names, if any. */
export function errorField(error: unknown): string | null {
  return error instanceof ApiError && typeof error.body.field === "string" ? error.body.field : null
}

/** Initials for an avatar: "Ada Okafor" → "AO", "ada@x" → "A". */
export function initialsOf(name: string | null | undefined, email?: string | null): string {
  const src = (name ?? "").trim()
  if (src) {
    const parts = src.split(/\s+/).filter(Boolean)
    return parts
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("")
  }
  return (email ?? "?").slice(0, 1).toUpperCase()
}

/**
 * Formatting rules the ops screens share (HANDOFF-ops §5), on top of src/lib/format.ts. Pure, so they're tested
 * in format.test.ts.
 */
import { num, toDate } from "../lib/format.ts"

/** Rates are fractions: two decimals under 1%, otherwise one, and never a trailing ".0". */
export function pct(v: number | string | null | undefined): string {
  const n = num(v)
  if (n === null) return "—"
  const p = n * 100
  const digits = Math.abs(p) < 1 && p !== 0 ? 2 : 1
  return `${p.toFixed(digits).replace(/\.?0+$/, "")}%`
}

const pad = (n: number) => String(n).padStart(2, "0")
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "17:48 UTC" */
export function utcTime(v: number | string | null | undefined, seconds = false): string {
  const d = toDate(v)
  if (!d) return "—"
  const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""}`
  return `${t} UTC`
}

/** "17 Oct 2026" */
export function utcDate(v: number | string | null | undefined): string {
  const d = toDate(v)
  if (!d) return "—"
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** "Sat 17 Oct 2026, 17:48 UTC": the full time, for `<time title>` and wherever a moment must be exact. */
export function utcFull(v: number | string | null | undefined): string {
  const d = toDate(v)
  if (!d) return "—"
  return `${DAYS[d.getUTCDay()]} ${utcDate(d.getTime())}, ${utcTime(d.getTime())}`
}

/** "Sun 18 Oct, 17:48 UTC" */
export function utcShort(v: number | string | null | undefined): string {
  const d = toDate(v)
  if (!d) return "—"
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${utcTime(d.getTime())}`
}

/** For `<input type="datetime-local">` read as UTC: "2026-10-17T17:48". */
export function toLocalInput(v: number | string | null | undefined): string {
  const d = toDate(v)
  if (!d) return ""
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** The inverse: a datetime-local value taken as UTC, to epoch ms, or null when empty or invalid. */
export function fromLocalInput(v: string): number | null {
  if (!v) return null
  const ms = Date.parse(`${v}${v.length === 16 ? ":00" : ""}Z`)
  return Number.isFinite(ms) ? ms : null
}

const UNITS = ["B", "KB", "MB", "GB", "TB"]
/** Bytes in base 1024 with the unit people expect: "325 KB", "1.4 MB". */
export function fmtBytes(v: number | string | null | undefined): string {
  let n = num(v)
  if (n === null) return "—"
  let i = 0
  while (Math.abs(n) >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  const s = i === 0 || n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, "")
  return `${s} ${UNITS[i]}`
}

/** Milliseconds as a short duration: "850 ms", "4.2 s", "3 min", "2 h 5 min", "2 d". */
export function fmtDuration(ms: number | string | null | undefined): string {
  const n = num(ms)
  if (n === null) return "—"
  if (n < 1000) return `${Math.round(n)} ms`
  const s = n / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1).replace(/\.0$/, "") : Math.round(s)} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  return `${Math.round(h / 24)} d`
}

/** Seconds as the grace wording: "Now", "1 hour", "24 hours", "7 days", "90 minutes". */
export function fmtSeconds(sec: number): string {
  if (sec <= 0) return "Now"
  if (sec % 86400 === 0) return `${sec / 86400} day${sec === 86400 ? "" : "s"}`
  if (sec % 3600 === 0) return `${sec / 3600} hour${sec === 3600 ? "" : "s"}`
  if (sec % 60 === 0) return `${sec / 60} minute${sec === 60 ? "" : "s"}`
  return `${sec} seconds`
}

/** Whether a moment is within the last week, where times read relative ("3 hours ago"). */
export const isRecent = (v: number | string | null | undefined, now = Date.now()) => {
  const d = toDate(v)
  return d ? Math.abs(now - d.getTime()) < 7 * 86_400_000 : false
}

/** "1 message", "2 messages". */
export const plural = (n: number | string | null | undefined, one: string, many = `${one}s`) => {
  const v = num(n) ?? 0
  return `${new Intl.NumberFormat("en").format(v)} ${v === 1 ? one : many}`
}

/** A countdown to a moment: "6 days 23 hours", "5 hours 12 minutes", "12 minutes", "less than a minute". */
export function fmtCountdown(to: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((to - now) / 60_000))
  if (m < 1) return "less than a minute"
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const min = m % 60
  const u = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
  if (d) return h ? `${u(d, "day")} ${u(h, "hour")}` : u(d, "day")
  if (h) return min ? `${u(h, "hour")} ${u(min, "minute")}` : u(h, "hour")
  return u(min, "minute")
}

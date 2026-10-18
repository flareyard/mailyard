/**
 * Formatting shared by every screen. The API encodes some numbers as strings (Effect's NumberFromString on the
 * wire), so every figure goes through `num` before it is shown or compared.
 */
export const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

const int = new Intl.NumberFormat("en", { maximumFractionDigits: 0 })
const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD", minimumFractionDigits: 2 })
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

export const fmtInt = (v: number | string | null | undefined) => {
  const n = num(v)
  return n === null ? "—" : int.format(n)
}
export const fmtUsd = (v: number | string | null | undefined) => {
  const n = num(v)
  return n === null ? "—" : usd.format(n)
}
export const fmtCompact = (v: number | string | null | undefined) => {
  const n = num(v)
  return n === null ? "—" : compact.format(n)
}
export const fmtPct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(digits).replace(/\.0+$/, "")}%`

/** Timestamps arrive as ISO strings or epoch milliseconds. */
export const toDate = (v: number | string | null | undefined): Date | null => {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  return Number.isFinite(n) ? new Date(n) : null
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "long" })
export const fmtAgo = (v: number | string | null | undefined, now = Date.now()) => {
  const d = toDate(v)
  if (!d) return "—"
  const s = Math.round((d.getTime() - now) / 1000)
  const abs = Math.abs(s)
  if (abs < 45) return s <= 0 ? "just now" : "in a moment"
  if (abs < 2700) return rtf.format(Math.round(s / 60), "minute")
  if (abs < 79200) return rtf.format(Math.round(s / 3600), "hour")
  if (abs < 2592000) return rtf.format(Math.round(s / 86400), "day")
  return d.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })
}

/** "in 6 h 12 min" for countdowns to a reset or a retry. */
export const fmtIn = (v: number | string | null | undefined, now = Date.now()) => {
  const d = toDate(v)
  if (!d) return "—"
  const m = Math.max(0, Math.round((d.getTime() - now) / 60000))
  const h = Math.floor(m / 60)
  return h ? `in ${h} h ${m % 60} min` : `in ${m} min`
}

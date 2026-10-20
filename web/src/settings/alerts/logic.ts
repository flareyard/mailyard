/**
 * Pure logic for Settings → Alerts (HAL-3465): the channel rows as the form holds them, the PUT body they
 * become, what's unsaved, and where a 400 `{ field: "channels[i].target" }` belongs. Tested in logic.test.ts.
 */

export const ALERT_KINDS = [
  "delivery_events_missing",
  "campaign_paused",
  "dns_drift",
  "reputation_warning",
  "reputation_at_risk",
  "bounce_spike",
  "complaint_spike",
  "quota_80",
  "quota_100",
  "webhook_dead_letter",
  "import_failed",
  "export_ready",
  "domain_activated",
  "automation_failed",
  "approval_pending",
] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

export const SEVERITIES = [
  { value: "info", label: "Info and up" },
  { value: "warning", label: "Warning and up" },
  { value: "critical", label: "Critical only" },
] as const
export type Severity = (typeof SEVERITIES)[number]["value"]

export type Channel = {
  kind: "email" | "webhook"
  target: string
  kinds?: AlertKind[]
  minSeverity: Severity
}
/** A row in the form: a stable key for React, and kinds always present (empty = every kind). */
export type Row = {
  key: string
  kind: "email" | "webhook"
  target: string
  kinds: AlertKind[]
  minSeverity: Severity
}

let seq = 0
const nextKey = () => `ch_${++seq}`

export function toRows(channels: readonly Channel[]): Row[] {
  return channels.map((c) => ({
    key: nextKey(),
    kind: c.kind,
    target: c.target,
    kinds: [...(c.kinds ?? [])],
    minSeverity: c.minSeverity,
  }))
}

export const newRow = (kind: "email" | "webhook" = "email"): Row => ({
  key: nextKey(),
  kind,
  target: "",
  kinds: [],
  minSeverity: "warning",
})

/** The PUT body: targets trimmed, `kinds` left out when it's every kind, `defaultEmail` null when blank. */
export function toBody(
  rows: readonly Row[],
  defaultEmail: string,
): { channels: Channel[]; defaultEmail: string | null } {
  return {
    channels: rows.map((r) => ({
      kind: r.kind,
      target: r.target.trim(),
      ...(r.kinds.length ? { kinds: [...r.kinds] } : {}),
      minSeverity: r.minSeverity,
    })),
    defaultEmail: defaultEmail.trim() || null,
  }
}

const canonical = (b: { channels: Channel[]; defaultEmail: string | null }) =>
  JSON.stringify({
    channels: b.channels.map((c) => ({ ...c, kinds: [...(c.kinds ?? [])].sort() })),
    defaultEmail: b.defaultEmail,
  })

/** What the save bar says: "Nothing to save", or what changed in words. */
export function unsavedLine(
  saved: { channels: readonly Channel[]; defaultEmail: string | null },
  rows: readonly Row[],
  defaultEmail: string,
): string | null {
  const now = toBody(rows, defaultEmail)
  const was = { channels: [...saved.channels], defaultEmail: saved.defaultEmail }
  if (canonical(now) === canonical(was)) return null
  const parts: string[] = []
  const added = now.channels.length - was.channels.length
  if (added > 0) parts.push(`${added} channel${added === 1 ? "" : "s"} added`)
  if (added < 0) parts.push(`${-added} channel${added === -1 ? "" : "s"} removed`)
  const same = Math.min(now.channels.length, was.channels.length)
  let changed = 0
  for (let i = 0; i < same; i++) {
    const a = now.channels[i]
    const b = was.channels[i]
    if (
      a &&
      b &&
      canonical({ channels: [a], defaultEmail: null }) !== canonical({ channels: [b], defaultEmail: null })
    )
      changed++
  }
  if (changed) parts.push(`${changed} channel${changed === 1 ? "" : "s"} changed`)
  if (now.defaultEmail !== was.defaultEmail) parts.push("the default address changed")
  const s = parts.join(", ")
  return `Unsaved: ${s.charAt(0).toLowerCase()}${s.slice(1)}.`
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Problems the form can see before a round trip, by row index (the API checks the same and more). */
export function rowProblems(rows: readonly Row[]): Map<number, string> {
  const out = new Map<number, string>()
  rows.forEach((r, i) => {
    const t = r.target.trim()
    if (!t) out.set(i, r.kind === "email" ? "Enter an email address." : "Choose a webhook endpoint.")
    else if (r.kind === "email" && !EMAIL.test(t)) out.set(i, `${t} isn’t an email address.`)
  })
  return out
}

/** Where a 400's `field` points: `channels[2].target` → row 2's target; `defaultEmail` → the default field. */
export function fieldTarget(field: unknown): { row: number; key: string } | { defaultEmail: true } | null {
  if (typeof field !== "string") return null
  if (field === "defaultEmail") return { defaultEmail: true }
  const m = /^channels\[(\d+)\]\.([A-Za-z]+)$/.exec(field)
  if (!m) return null
  return { row: Number(m[1]), key: m[2] as string }
}

/** "Every kind", or "4 of 15". */
export const kindsLabel = (kinds: readonly string[]) =>
  kinds.length === 0 ? "Every kind" : `${kinds.length} of ${ALERT_KINDS.length}`

/**
 * Suppressions (HAL-3372, HANDOFF-ops §12–14): labels, what each row allows, the URL filters and reading a
 * CSV's header before it uploads.
 */
export type Reason = "hard_bounce" | "complaint" | "unsubscribe" | "manual"
export type Source = "cloudflare" | "events" | "manual" | "import"
export type CfState = "in-sync" | "missing" | "not-applicable" | "unchecked"
export type RemoveState = "removed" | "not-listed" | "read-only" | "not-connected" | "failed"

export const REASONS: Reason[] = ["hard_bounce", "complaint", "unsubscribe", "manual"]
export const SOURCES: Source[] = ["events", "cloudflare", "manual", "import"]
export const CF_STATES: CfState[] = ["in-sync", "missing", "not-applicable", "unchecked"]

export const REASON: Record<Reason, { label: string; tone: string }> = {
  hard_bounce: { label: "Hard bounce", tone: "pill-fail" },
  complaint: { label: "Complaint", tone: "pill-fail" },
  unsubscribe: { label: "Unsubscribe", tone: "pill-neutral" },
  manual: { label: "Added by hand", tone: "pill-neutral" },
}

export const SOURCE: Record<Source, string> = {
  events: "Delivery event",
  cloudflare: "Cloudflare’s list",
  manual: "By hand",
  import: "CSV import",
}

export const CF: Record<CfState, { label: string; tone: string }> = {
  "in-sync": { label: "In sync", tone: "pill-pass" },
  missing: { label: "Missing on Cloudflare", tone: "pill-warn" },
  "not-applicable": { label: "Not pushed: bulk only", tone: "pill-neutral" },
  unchecked: { label: "Not checked yet", tone: "pill-neutral" },
}

export type RowLike = { reason: Reason; bulkOnly: boolean; cloudflare: CfState; streams?: readonly string[] }

export const blocksLabel = (r: Pick<RowLike, "bulkOnly" | "reason">) =>
  r.bulkOnly || r.reason === "unsubscribe" ? "Campaigns and automations only" : "All mail"

/** Why Remove is off, or null. A complaint is permanent (the API answers 409 `complaint`). */
export function removeBlocked(r: Pick<RowLike, "reason">): { reason: string; who: string } | null {
  if (r.reason !== "complaint") return null
  return {
    reason: "A complaint can never be removed",
    who: "Gmail and Yahoo require it. To let transactional mail (receipts, password resets) reach this person again, set Bulk only: campaigns and automations stay blocked.",
  }
}

/** Why Push to Cloudflare is off, or null. */
export function pushBlocked(
  r: Pick<RowLike, "reason" | "bulkOnly" | "cloudflare">,
  cf: { writable: boolean } | null | undefined,
): { reason: string; who: string } | null {
  if (r.bulkOnly || r.reason === "unsubscribe")
    return {
      reason: "Not pushed: this row only blocks bulk mail",
      who: "Cloudflare’s list blocks every message, transactional too. Unsubscribes and bulk-only rows stay in Mailyard.",
    }
  if (r.cloudflare === "in-sync")
    return {
      reason: "Already on Cloudflare’s list",
      who: "Nothing to push: Cloudflare blocks it for every sender.",
    }
  if (cf && !cf.writable)
    return {
      reason: "Cloudflare isn’t connected",
      who: "This deploy has no Cloudflare write token. Add one with Email Sending write to the Worker’s secrets.",
    }
  return null
}

/** Bulk only is fixed for an unsubscribe: it only ever stops bulk mail. */
export const bulkOnlyFixed = (r: Pick<RowLike, "reason">) => r.reason === "unsubscribe"

export const REMOVE_RESULT: Record<RemoveState, { tone: "ok" | "warn" | "error"; text: string }> = {
  removed: {
    tone: "ok",
    text: "Cloudflare’s entries for the address are gone too. Mail can reach it again.",
  },
  "not-listed": { tone: "ok", text: "Cloudflare had no entry for it, so there was nothing to remove there." },
  "read-only": { tone: "warn", text: "Mailyard sends again, but Cloudflare may still refuse the address." },
  "not-connected": {
    tone: "warn",
    text: "Mailyard sends again, but Cloudflare may still refuse the address until its entry is removed by hand.",
  },
  failed: {
    tone: "error",
    text: "Removed in Mailyard; Cloudflare still lists it. Try again from the detail page.",
  },
}

/** The toast after a removal: “Cloudflare’s entry removed too · contact back to subscribed”. */
export function removeToastSub(state: RemoveState, contactStatus: string | null): string {
  const cf: Record<RemoveState, string> = {
    removed: "Cloudflare’s entry removed too",
    "not-listed": "Nothing to remove on Cloudflare",
    "read-only": "Cloudflare keeps its read-only entry",
    "not-connected": "Cloudflare not connected: its entry, if any, stays",
    failed: "Cloudflare still lists it",
  }
  return contactStatus ? `${cf[state]} · contact back to ${contactStatus}` : cf[state]
}

export type Filters = { reason?: Reason; source?: Source; cloudflare?: CfState; q?: string; cursor?: string }

const isIn = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v)

export function parseFilters(s: Record<string, unknown>): Filters {
  return {
    ...(isIn(REASONS, s.reason) ? { reason: s.reason } : {}),
    ...(isIn(SOURCES, s.source) ? { source: s.source } : {}),
    ...(isIn(CF_STATES, s.cloudflare) ? { cloudflare: s.cloudflare } : {}),
    ...(typeof s.q === "string" && s.q.trim() ? { q: s.q.trim().slice(0, 320) } : {}),
    ...(typeof s.cursor === "string" && s.cursor ? { cursor: s.cursor } : {}),
  }
}

/** The chips under the filter bar, each with what it removes. */
export function activeFilters(f: Filters): { key: keyof Filters; label: string; value: string }[] {
  const out: { key: keyof Filters; label: string; value: string }[] = []
  if (f.q) out.push({ key: "q", label: "Address", value: f.q })
  if (f.reason) out.push({ key: "reason", label: "Reason", value: REASON[f.reason].label.toLowerCase() })
  if (f.source) out.push({ key: "source", label: "Source", value: SOURCE[f.source].toLowerCase() })
  if (f.cloudflare) out.push({ key: "cloudflare", label: "On Cloudflare", value: f.cloudflare })
  return out
}

/** The query string the view is, for “This view is a link”. */
export function filtersQuery(f: Filters): string {
  const u = new URLSearchParams()
  for (const k of ["q", "reason", "source", "cloudflare"] as const) {
    const v = f[k]
    if (v) u.set(k, v)
  }
  const s = u.toString()
  return s ? `?${s}` : "?"
}

export const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

/** One CSV line into cells, honouring quotes (RFC 4180). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/** The header, the data row count and the first row, read in the browser before the upload. */
export function readCsv(text: string): { headers: string[]; rows: number; first: string[] } {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
  const headers = lines[0] ? splitCsvLine(lines[0]) : []
  return { headers, rows: Math.max(0, lines.length - 1), first: lines[1] ? splitCsvLine(lines[1]) : [] }
}

/** Guesses the email, reason and note columns from header names other providers use. */
export function guessColumns(headers: readonly string[]): { email?: string; reason?: string; note?: string } {
  const find = (re: RegExp) => headers.find((h) => re.test(h.trim()))
  const email = find(/^(e-?mail|email[_ ]?address|address|recipient)$/i) ?? find(/mail/i)
  const reason = find(/^(reason|status|type|suppression[_ ]?reason|category)$/i)
  const note = find(/^(note|notes|comment|comments|description|date|created(_at)?)$/i)
  return {
    ...(email ? { email } : {}),
    ...(reason && reason !== email ? { reason } : {}),
    ...(note && note !== email && note !== reason ? { note } : {}),
  }
}

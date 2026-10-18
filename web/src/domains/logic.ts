/**
 * Pure rules behind the Domains screens (HANDOFF-ops §24, §8, §14): what state a domain is in, how each record
 * check reads, whether the nameservers match, where a rate sits against Cloudflare's lines, and the BIND file.
 * Tested in logic.test.ts.
 */
import type { paths } from "../api/schema"
import { num } from "../lib/format.ts"

type Ok<P extends keyof paths, M extends "get" | "post"> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer R } } }
}
  ? R
  : never

export type DomainRow = Ok<"/v1/domains", "get">["domains"][number]
export type Domain = Ok<"/v1/domains/{id}", "get">
export type Check = Domain["checks"][number]
export type CheckStatus = Check["status"]
export type FixResult = Ok<"/v1/domains/{id}/fix", "post">
export type FixAction = FixResult["actions"][number]
export type Candidates = Ok<"/v1/domains/candidates", "get">
export type Candidate = Candidates["candidates"][number]
export type Reputation = Ok<"/v1/reputation", "get">
export type SendingEvents = Ok<"/v1/sending/events", "get">
export type DomainEvents = SendingEvents["domains"][number]

export type Tone = "pass" | "warn" | "fail" | "neutral" | "info"

/** The settable state words a pill shows, with its tone. */
export type State = { tone: Tone; label: string; spinner?: boolean }

export const TOKEN_SECRET = "CLOUDFLARE_DNS_TOKEN"
/** From the README: what the zone token needs. */
export const TOKEN_PERMISSIONS =
  "Zone, DNS and Email Sending: Read, plus Email Routing and Email Sending: Edit for fixing"
export const TOKEN_ISSUE = "HAL-3418"

export function recordCounts(checks: readonly Pick<Check, "status">[]) {
  return {
    passing: checks.filter((c) => c.status === "pass").length,
    total: checks.length,
    failing: checks.filter((c) => c.status === "fail" || c.status === "error").length,
    warning: checks.filter((c) => c.status === "warn").length,
    checking: checks.filter((c) => c.status === "checking").length,
  }
}

/** Whether Fix records has anything to do: the backend only fixes rows that fail or warn. */
export const hasFixable = (checks: readonly Pick<Check, "status">[]) =>
  checks.some((c) => c.status === "fail" || c.status === "warn")

export const isChecking = (
  d: Pick<DomainRow, "checkStatus"> & { checks?: readonly Pick<Check, "status">[] },
) => d.checkStatus === "checking" || (d.checks ?? []).some((c) => c.status === "checking")

export const isPendingZone = (zoneStatus: string | null | undefined) =>
  zoneStatus === "pending" || zoneStatus === "initializing"

/** A sending domain whose delivery events don't reach Mailyard (HAL-3341). */
export function eventsMissing(
  d: Pick<DomainRow, "id" | "sending">,
  events: readonly DomainEvents[] | undefined,
) {
  if (!d.sending || !events) return null
  const e = events.find((x) => x.domainId === d.id)
  return e && e.status === "warn" ? e : null
}

/**
 * The one pill a domain shows. Checking beats everything (it's about to change), then pending nameservers (which
 * explain failing rows), failing records, missing delivery events, a warning row, never checked, and healthy.
 */
export function domainState(
  d: Pick<DomainRow, "id" | "sending" | "checkStatus" | "lastCheckedAt" | "zoneStatus"> & {
    checks?: readonly Pick<Check, "status">[]
  },
  events?: readonly DomainEvents[],
): State {
  if (isChecking(d)) return { tone: "info", label: "Checking", spinner: true }
  // Records can't pass until the nameservers move, so pending explains a failing check.
  if (isPendingZone(d.zoneStatus)) return { tone: "warn", label: "Pending nameservers" }
  if (d.checkStatus === "fail" || d.checkStatus === "error") return { tone: "fail", label: "Records failing" }
  if (eventsMissing(d, events)) return { tone: "fail", label: "No delivery events" }
  if (d.checkStatus === "warn") return { tone: "warn", label: "Needs a look" }
  if (d.checkStatus === null || d.lastCheckedAt === null) return { tone: "neutral", label: "Not checked yet" }
  return { tone: "pass", label: "Healthy" }
}

/** The Zone column: the zone's status, or what can't be known without the token. */
export function zoneState(zoneStatus: string | null, connected: boolean): State | null {
  if (!connected) return null
  if (zoneStatus === null) return { tone: "neutral", label: "Not on this account" }
  if (zoneStatus === "active") return { tone: "pass", label: "Active" }
  if (isPendingZone(zoneStatus)) return { tone: "warn", label: "Pending nameservers" }
  if (zoneStatus === "moved") return { tone: "fail", label: "Moved away" }
  return { tone: "neutral", label: zoneStatus.charAt(0).toUpperCase() + zoneStatus.slice(1) }
}

const norm = (ns: string) => ns.trim().toLowerCase().replace(/\.$/, "")

/** Assigned (Cloudflare) against current (public DNS): match, mismatch, or unknown when either is missing. */
export function nameserverMatch(
  assigned: readonly string[] | null,
  current: readonly string[] | null,
): "match" | "mismatch" | "unknown" {
  if (!assigned?.length || !current?.length) return "unknown"
  const a = [...new Set(assigned.map(norm))].sort()
  const c = [...new Set(current.map(norm))].sort()
  return a.length === c.length && a.every((x, i) => x === c[i]) ? "match" : "mismatch"
}

const CHECK_LABEL: Record<Check["id"], string> = {
  mx: "MX",
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
  "bounce-mx": "Return-path MX",
  "bounce-spf": "Return-path SPF",
  "bounce-dkim": "Return-path DKIM",
}
export const checkLabel = (id: Check["id"]) => CHECK_LABEL[id] ?? id

/** "Receiving", "Sending" or "Return path" (the cf-bounce rows). */
export const checkPurpose = (c: Pick<Check, "id" | "purpose">) =>
  c.id.startsWith("bounce-") ? "Return path" : c.purpose === "receiving" ? "Receiving" : "Sending"

export const STATUS_PILL: Record<CheckStatus, State> = {
  pass: { tone: "pass", label: "Passing" },
  warn: { tone: "warn", label: "Needs a look" },
  fail: { tone: "fail", label: "Failing" },
  error: { tone: "fail", label: "Couldn’t check" },
  checking: { tone: "info", label: "Checking", spinner: true },
}

/** What public DNS answered, in words. */
export function foundLine(c: Pick<Check, "status" | "expected" | "actual">): { text: string; ok: boolean } {
  if (c.status === "checking") return { text: "Asking public DNS…", ok: false }
  if (c.actual.length === 0) return { text: "Found: nothing at this name", ok: false }
  if (c.actual.some((a) => a === c.expected)) {
    return c.actual.length === 1
      ? { text: "Found: the same value", ok: c.status === "pass" }
      : { text: `Found: the same value, plus ${c.actual.length - 1} more`, ok: c.status === "pass" }
  }
  return { text: `Found: ${c.actual.join(" · ")}`, ok: false }
}

/** The first failing row, for the callout above a failing domain. */
export function firstFailure(checks: readonly Check[]): Check | null {
  return (
    checks.find((c) => c.status === "fail" || c.status === "error") ??
    checks.find((c) => c.status === "warn") ??
    null
  )
}

/** Expected records as a BIND zone fragment, for "Copy all as a BIND file". */
export function toBind(records: readonly Domain["expectedRecords"][number][]): string {
  const lines = records.map((r) => {
    const name = `${r.name.replace(/\.$/, "")}.`
    if (r.type === "MX") {
      const m = r.value.match(/^(\S+)(?:\s*\(priority\s*(\d+)\))?$/)
      const host = m?.[1] ?? r.value
      const prio = m?.[2] ?? "10"
      return `${name}\t3600\tIN\tMX\t${prio} ${host.replace(/\.$/, "")}.`
    }
    if (r.type === "CNAME") return `${name}\t3600\tIN\tCNAME\t${r.value.replace(/\.$/, "")}.`
    return `${name}\t3600\tIN\tTXT\t"${r.value.replace(/"/g, '\\"')}"`
  })
  return `; Mailyard: the records these domains need\n${lines.join("\n")}\n`
}

const ACTION_TITLE: Record<FixAction["action"], string> = {
  enable_routing: "Turn Email Routing back on",
  fix_sending: "Re-apply the sending records",
  add_dmarc: "Add a DMARC record",
  manual: "Set by hand",
}
export function actionTitle(a: Pick<FixAction, "action" | "checks">): string {
  if (a.action === "manual")
    return `Set by hand: ${a.checks.map((c) => checkLabel(c as Check["id"])).join(", ")}`
  return ACTION_TITLE[a.action]
}

export type FixRefusal = "no_dns_token" | "zone_not_found" | "nothing_to_fix"
export function fixRefusal(body: { _tag?: string; reason?: string } | undefined): FixRefusal | null {
  const r = body?.reason
  return r === "no_dns_token" || r === "zone_not_found" || r === "nothing_to_fix" ? r : null
}

/** The zone a domain sits in: the domain itself or its parent ("news.coursified.app" → "coursified.app"). */
export const parentZone = (name: string) => {
  const parts = name.split(".")
  return parts.length > 2 ? parts.slice(-2).join(".") : name
}

/** A typed domain: lower-cased, no scheme, path or trailing dot; null when it can't be a domain. */
export function cleanDomain(input: string): string | null {
  let v = input.trim().toLowerCase()
  v = v
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "")
  if (v.startsWith("www.")) v = v.slice(4)
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v)) return null
  return v
}

/** Receiving defaults off for a zone whose mail already goes elsewhere, so adding it never takes that mail. */
export const defaultReceiving = (c: Pick<Candidate, "existingMx"> | null) => !(c && c.existingMx.length > 0)

// ── Reputation ────────────────────────────────────────────────────────────────────────────────────────

export type Level = Reputation["levels"]["bounce"]

/**
 * Where a rate and its two lines sit on the track: the at-risk line always at 62.5%, so the fill has room to
 * show how far past it a rate has gone (design: `.thresh-track`).
 */
export function thresholdGeometry(value: number | null, warningAt: number, atRiskAt: number) {
  const max = atRiskAt > 0 ? atRiskAt / 0.625 : 1
  const at = (v: number) => Math.max(0, Math.min(100, (v / max) * 100))
  return { fill: value === null ? null : at(value), warning: at(warningAt), risk: 62.5 }
}

export const LEVEL_PILL: Record<Level, State> = {
  ok: { tone: "pass", label: "Under warning" },
  warning: { tone: "warn", label: "Warning" },
  "at-risk": { tone: "fail", label: "At risk" },
  "insufficient-data": { tone: "neutral", label: "Not enough data yet" },
}
export const LEVEL_CLASS: Record<Level, string> = {
  ok: "is-ok",
  warning: "is-warning",
  "at-risk": "is-at-risk",
  "insufficient-data": "is-insufficient",
}

/** The account status Cloudflare reports ("healthy", "warning", "at_risk"), or Not connected. */
export function reputationState(r: Pick<Reputation, "status" | "source">): State {
  if (r.source === "not-connected") return { tone: "neutral", label: "Not connected" }
  const s = (r.status ?? "").toLowerCase().replace(/[-\s]/g, "_")
  if (s === "at_risk") return { tone: "fail", label: "At risk" }
  if (s === "warning") return { tone: "warn", label: "Warning" }
  if (s === "healthy" || s === "ok") return { tone: "pass", label: "Healthy" }
  if (s === "suspended") return { tone: "fail", label: "Suspended" }
  return { tone: "neutral", label: r.status ? r.status : "Not rated yet" }
}

/** When sending is suspended if the account stays at risk: grace start + `suspension_after_hours`. */
export function suspensionAt(
  r: Pick<Reputation, "graceStartedAt" | "statusSince" | "policy">,
): number | null {
  const start = Date.parse(r.graceStartedAt ?? r.statusSince ?? "")
  const hours = num(r.policy.suspension_after_hours)
  if (!Number.isFinite(start) || hours === null) return null
  return start + hours * 3_600_000
}

/** "147 h 52 min left", or "Suspension due now" once it has passed. */
export function countdown(at: number, now = Date.now()): string {
  const m = Math.floor((at - now) / 60_000)
  if (m <= 0) return "Suspension due now"
  const h = Math.floor(m / 60)
  return h ? `${h} h ${m % 60} min left` : `${m} min left`
}

export function policyLine(source: Reputation["policySource"]): string {
  return source === "account"
    ? "policy from this account"
    : "Cloudflare’s published lines, measured 16 Oct 2026"
}

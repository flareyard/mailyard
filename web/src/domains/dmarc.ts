/**
 * Pure rules behind DMARC reports (HAL-3375): how a sending source reads and sorts, what to add to `rua` so
 * reports reach Mailyard, and the policy change as a small state machine (preview with `dryRun=1`, then an
 * explicit confirm, then the write). Tested in dmarc.test.ts.
 */
import type { paths } from "../api/schema"
import { num } from "../lib/format.ts"
import type { State } from "./logic.ts"

type Ok<P extends keyof paths, M extends "get" | "patch"> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer R } } }
}
  ? R
  : never

export type Dmarc = Ok<"/v1/domains/{id}/dmarc", "get">
export type Source = Dmarc["sources"][number]
export type PolicyChange = Ok<"/v1/domains/{id}/dmarc", "patch">
export type DmarcP = "none" | "quarantine" | "reject"
export type Range = "7d" | "30d" | "90d"

export const RANGES: readonly Range[] = ["7d", "30d", "90d"]

/** A share of a count, or null when there's nothing to share. */
export function share(part: number | string, whole: number | string): number | null {
  const p = num(part)
  const w = num(whole)
  return p === null || w === null || w <= 0 ? null : p / w
}

/** What to call a source: someone's label, then the provider, then reverse DNS, then the address. */
export function sourceName(s: Pick<Source, "label" | "provider" | "ptr" | "ip">): string {
  return s.label?.trim() || s.provider || s.ptr || s.ip
}

/** Passing (every message passes DMARC), partly failing, or failing. Known sources never read as failing red. */
export function sourceState(s: Pick<Source, "messages" | "dmarcPass" | "known">): State {
  const m = num(s.messages) ?? 0
  const pass = num(s.dmarcPass) ?? 0
  if (m === 0 || pass >= m) return { tone: "pass", label: "Passing" }
  if (pass === 0 && !s.known) return { tone: "fail", label: "Failing" }
  return { tone: "warn", label: "Partly failing" }
}

/**
 * The order the table reads in: unknown sources that fail first (they're what blocks a stricter policy),
 * then by messages, most first; ties by name so the order is stable.
 */
export function sortSources<
  T extends Pick<Source, "messages" | "dmarcPass" | "known" | "label" | "provider" | "ptr" | "ip">,
>(sources: readonly T[]): T[] {
  const rank = (s: T) => {
    const failing = (num(s.dmarcPass) ?? 0) < (num(s.messages) ?? 0)
    return failing && !s.known ? 0 : failing ? 1 : 2
  }
  return [...sources].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (num(b.messages) ?? 0) - (num(a.messages) ?? 0) ||
      sourceName(a).localeCompare(sourceName(b)),
  )
}

/** "dkim: coursified.app (pass)" lines from a source's `dkimDomains` / `spfDomains` maps. */
export const authLines = (map: Record<string, string>) =>
  Object.entries(map).map(([domain, result]) => `${domain} (${result})`)

/**
 * The `rua` tag that sends reports to Mailyard as well as wherever they go now: the existing addresses kept,
 * Mailyard's added once. With nothing published yet, just Mailyard's.
 */
export function ruaWith(existing: readonly string[], address: string): string {
  const want = address.toLowerCase()
  const list = existing.map((a) => a.toLowerCase().replace(/^mailto:/, ""))
  const all = list.includes(want) ? list : [...list, want]
  return `rua=${all.map((a) => `mailto:${a}`).join(",")}`
}

export const P_LABEL: Record<DmarcP, string> = {
  none: "p=none: receivers report but take no action",
  quarantine: "p=quarantine: failing mail goes to spam",
  reject: "p=reject: failing mail is refused",
}

/** "quarantine at 25%" / "reject" — how a step reads in a button. */
export function stepLabel(next: { p: DmarcP; pct: number | string | null } | null): string | null {
  if (!next) return null
  const pct = num(next.pct)
  return pct !== null && pct < 100 ? `${next.p} at ${pct}%` : next.p
}

// ── The policy change ─────────────────────────────────────────────────────────────────────────────────

export type Refusal = { reason: string; message: string; requestId?: string }

export type PolicyFlow =
  | { step: "previewing" }
  | { step: "preview"; change: PolicyChange }
  | { step: "applying"; change: PolicyChange }
  | { step: "applied"; change: PolicyChange }
  | { step: "refused"; refusal: Refusal; change: PolicyChange | null }
  | { step: "error"; message: string; change: PolicyChange | null }

export type FlowEvent =
  | { type: "preview" }
  | { type: "previewed"; change: PolicyChange }
  | { type: "confirm" }
  | { type: "applied"; change: PolicyChange }
  | { type: "refused"; refusal: Refusal }
  | { type: "failed"; message: string }

const changeOf = (s: PolicyFlow): PolicyChange | null => ("change" in s ? s.change : null)

/**
 * The flow's only transitions. A write (`confirm`) is possible only from a preview the person has seen, so
 * nothing reaches DNS without a dry run first; any new choice of policy goes back to previewing.
 */
export function policyStep(s: PolicyFlow, e: FlowEvent): PolicyFlow {
  switch (e.type) {
    case "preview":
      return s.step === "applying" ? s : { step: "previewing" }
    case "previewed":
      return s.step === "previewing" ? { step: "preview", change: e.change } : s
    case "confirm":
      return s.step === "preview" && s.change.changed ? { step: "applying", change: s.change } : s
    case "applied":
      return s.step === "applying" ? { step: "applied", change: e.change } : s
    case "refused":
      return { step: "refused", refusal: e.refusal, change: changeOf(s) }
    case "failed":
      return { step: "error", message: e.message, change: changeOf(s) }
  }
}

/** Whether the write button may run: only on a preview that changes something. */
export const canConfirm = (s: PolicyFlow) => s.step === "preview" && s.change.changed

/** The refusal sentence the sheet shows; no zone token is the production state today (HAL-3418). */
export function refusalLine(r: Refusal): string {
  switch (r.reason) {
    case "no_dns_token":
      return "Mailyard can’t write DNS until a zone token is set."
    case "zone_not_found":
      return "The zone token can’t see this domain’s zone."
    case "several_records":
      return "There’s more than one DMARC record, so receivers ignore them all."
    case "write_failed":
      return "Cloudflare refused the change."
    default:
      return "Mailyard didn’t change the record."
  }
}

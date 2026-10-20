/**
 * A domain's DMARC record as tags, the next step up its policy, and whether the reports say it's safe
 * to take (HAL-3375). Pure code.
 */

export type DmarcPolicy = "none" | "quarantine" | "reject"

export interface DmarcTags {
  readonly raw: string
  /** Tag names lower-cased, in the record's order. */
  readonly tags: ReadonlyArray<readonly [string, string]>
}

export const parseRecord = (record: string): DmarcTags => ({
  raw: record,
  tags: record
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .map((part) => {
      const at = part.indexOf("=")
      return [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()] as const
    }),
})

export const tag = (record: DmarcTags, name: string) => record.tags.find(([k]) => k === name)?.[1] ?? null

export const policyOf = (record: DmarcTags): DmarcPolicy | null => {
  const p = tag(record, "p")?.toLowerCase()
  return p === "none" || p === "quarantine" || p === "reject" ? p : null
}

/** The `mailto:` addresses in `rua`, lower-cased, without size suffixes (`!10m`). */
export const ruaOf = (record: DmarcTags) =>
  (tag(record, "rua") ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => /^mailto:/i.test(u))
    .map((u) => u.slice("mailto:".length).replace(/!.*$/, "").toLowerCase())

/**
 * The record with `p` (and `pct`) set, every other tag kept as it was and in place. `v=DMARC1` stays
 * first; `pct=100` is dropped, since it's the default.
 */
export const withPolicy = (record: DmarcTags | null, p: DmarcPolicy, pct: number | null): string => {
  const tags: Array<[string, string]> = record
    ? record.tags.map(([k, v]) => [k, v])
    : [
        ["v", "DMARC1"],
        ["p", "none"],
      ]
  const set = (name: string, value: string | null) => {
    const i = tags.findIndex(([k]) => k === name)
    if (value === null) {
      if (i >= 0) tags.splice(i, 1)
      return
    }
    if (i >= 0) tags[i] = [name, value]
    else {
      // After p (or v), where the spec lists them.
      const after = tags.findIndex(([k]) => k === "p")
      tags.splice(after >= 0 ? after + 1 : tags.length, 0, [name, value])
    }
  }
  if (!tags.some(([k]) => k === "v")) tags.unshift(["v", "DMARC1"])
  set("p", p)
  set("pct", pct === null || pct >= 100 ? null : String(Math.max(0, Math.min(100, Math.round(pct)))))
  return tags.map(([k, v]) => `${k}=${v}`).join("; ")
}

/** One step up: none, then quarantine at full strength, then reject. Null at reject. */
export const nextStep = (
  p: DmarcPolicy | null,
  pct: number | null,
): { p: DmarcPolicy; pct: number | null } | null => {
  if (p === null || p === "none") return { p: "quarantine", pct: null }
  if (p === "quarantine" && pct !== null && pct < 100) return { p: "quarantine", pct: null }
  if (p === "quarantine") return { p: "reject", pct: null }
  return null
}

export interface SourceSummary {
  readonly ip: string
  readonly messages: number
  readonly dmarcPass: number
  readonly known: boolean
}

/** At least this many days of reports before a recommendation, so weekly senders show up. */
export const MIN_DAYS = 7
/** Unknown, failing mail may be at most this share of the total to tighten the policy. */
export const MAX_UNKNOWN_FAIL_SHARE = 0.005

export const recommend = (input: {
  readonly policy: DmarcPolicy | null
  readonly pct: number | null
  readonly days: number
  readonly messages: number
  readonly sources: ReadonlyArray<SourceSummary>
}) => {
  const blockers: Array<{ readonly kind: string; readonly message: string; readonly ip?: string }> = []
  if (input.days < MIN_DAYS)
    blockers.push({
      kind: "collecting",
      message: `${input.days} day${input.days === 1 ? "" : "s"} of reports so far; wait for at least ${MIN_DAYS}, so senders that mail weekly show up.`,
    })
  if (input.messages === 0) blockers.push({ kind: "no_mail", message: "No reported mail in this range." })
  const failingUnknown = input.sources.filter((s) => !s.known && s.dmarcPass < s.messages)
  const unknownFail = failingUnknown.reduce((n, s) => n + (s.messages - s.dmarcPass), 0)
  const share = input.messages > 0 ? unknownFail / input.messages : 0
  if (share > MAX_UNKNOWN_FAIL_SHARE)
    for (const s of failingUnknown
      .slice()
      .sort((a, b) => b.messages - b.dmarcPass - (a.messages - a.dmarcPass))
      .slice(0, 10))
      blockers.push({
        kind: "unknown_source",
        ip: s.ip,
        message: `${s.ip} sent ${s.messages - s.dmarcPass} message${s.messages - s.dmarcPass === 1 ? "" : "s"} that failed DMARC. Fix its SPF or DKIM if it's yours, or mark it known if it's a forwarder.`,
      })
  const next = nextStep(input.policy, input.pct)
  return {
    current: input.policy,
    unknownFailShare: Math.round(share * 10_000) / 10_000,
    safeToQuarantine: (input.policy === null || input.policy === "none") && blockers.length === 0,
    safeToReject: input.policy === "quarantine" && blockers.length === 0,
    blockers,
    next: blockers.length === 0 ? next : null,
  }
}

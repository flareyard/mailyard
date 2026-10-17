import { Effect } from "effect"
import { Dns, type DnsResult, type RecordType } from "../services/Dns.ts"

/**
 * What a domain's DNS must say for Mailyard to receive and send its mail, and whether it does.
 * Expected values measured 2026-10-17 from GET /zones/{id}/email/routing/dns and the Email Sending
 * onboarding records on bridgehook.dev.
 */
export const ROUTING_MX = [
  "route1.mx.cloudflare.net",
  "route2.mx.cloudflare.net",
  "route3.mx.cloudflare.net",
] as const
export const CLOUDFLARE_SPF_INCLUDE = "include:_spf.mx.cloudflare.net"
export const ROUTING_DKIM_SELECTOR = "cf2024-1"
export const SENDING_SUBDOMAIN = "cf-bounce"

export type CheckStatus = "pass" | "warn" | "fail" | "error"

export interface RecordCheck {
  readonly id: "mx" | "spf" | "dkim" | "dmarc" | "bounce-mx" | "bounce-spf" | "bounce-dkim"
  readonly purpose: "receiving" | "sending"
  readonly name: string
  readonly type: RecordType
  readonly expected: string
  readonly actual: ReadonlyArray<string>
  readonly status: CheckStatus
  readonly detail: string
}

export interface DomainCheck {
  readonly domain: string
  readonly checkedAt: number
  readonly status: CheckStatus
  readonly checks: ReadonlyArray<RecordCheck>
}

const RANK: Record<CheckStatus, number> = { pass: 0, warn: 1, error: 2, fail: 3 }
export const worst = (statuses: ReadonlyArray<CheckStatus>): CheckStatus =>
  statuses.reduce<CheckStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), "pass")

const mxHost = (data: string) => (data.trim().split(/\s+/).at(-1) ?? "").replace(/\.$/, "").toLowerCase()

const lookup = (name: string, type: RecordType) =>
  Effect.gen(function* () {
    const dns = yield* Dns
    return yield* Effect.result(dns.resolve(name, type))
  })

type Lookup = Effect.Success<ReturnType<typeof lookup>>

const unreachable = (
  base: Omit<RecordCheck, "actual" | "status" | "detail">,
  result: Lookup,
): RecordCheck | null =>
  result._tag === "Failure"
    ? { ...base, actual: [], status: "error", detail: `Lookup failed: ${result.failure.message}` }
    : null

const answers = (result: Lookup) =>
  result._tag === "Success" ? (result.success as DnsResult).answers.map((a) => a.data) : []

/** Every MX must be Cloudflare's: a single other host splits delivery between two providers. */
export const checkMx = (id: "mx" | "bounce-mx", name: string, result: Lookup): RecordCheck => {
  const base = {
    id,
    purpose: id === "mx" ? ("receiving" as const) : ("sending" as const),
    name,
    type: "MX" as const,
    expected: ROUTING_MX.join(", "),
  }
  const failed = unreachable(base, result)
  if (failed) return failed
  const actual = answers(result)
  const hosts = actual.map(mxHost)
  const foreign = hosts.filter((h) => !(ROUTING_MX as ReadonlyArray<string>).includes(h))
  const missing = ROUTING_MX.filter((h) => !hosts.includes(h))
  if (hosts.length === 0)
    return { ...base, actual, status: "fail", detail: "No MX records: mail for this name goes nowhere." }
  if (foreign.length > 0) {
    return {
      ...base,
      actual,
      status: "fail",
      detail: `MX points to ${foreign.join(", ")}: that provider receives this mail, not Mailyard.`,
    }
  }
  if (missing.length > 0) return { ...base, actual, status: "warn", detail: `Missing ${missing.join(", ")}.` }
  return { ...base, actual, status: "pass", detail: "All three Cloudflare MX hosts." }
}

/** Exactly one SPF record, and it includes Cloudflare. Two SPF records is a permanent error for receivers. */
export const checkSpf = (id: "spf" | "bounce-spf", name: string, result: Lookup): RecordCheck => {
  const base = {
    id,
    purpose: id === "spf" ? ("receiving" as const) : ("sending" as const),
    name,
    type: "TXT" as const,
    expected: `v=spf1 ${CLOUDFLARE_SPF_INCLUDE} ~all`,
  }
  const failed = unreachable(base, result)
  if (failed) return failed
  const spf = answers(result).filter((t) => /^v=spf1(\s|$)/i.test(t.trim()))
  if (spf.length === 0) return { ...base, actual: spf, status: "fail", detail: "No SPF record." }
  if (spf.length > 1) {
    return {
      ...base,
      actual: spf,
      status: "fail",
      detail: "More than one SPF record: receivers treat that as a permanent error.",
    }
  }
  const record = spf[0] ?? ""
  if (!record.toLowerCase().split(/\s+/).includes(CLOUDFLARE_SPF_INCLUDE)) {
    return {
      ...base,
      actual: spf,
      status: "fail",
      detail: `SPF doesn't include ${CLOUDFLARE_SPF_INCLUDE.slice(8)}.`,
    }
  }
  if (/\s\+all\b/i.test(record)) {
    return {
      ...base,
      actual: spf,
      status: "warn",
      detail: "SPF ends in +all, which lets anyone send as this domain.",
    }
  }
  return { ...base, actual: spf, status: "pass", detail: "SPF includes Cloudflare." }
}

/** A DKIM public key is published at the selector. */
export const checkDkim = (id: "dkim" | "bounce-dkim", name: string, result: Lookup): RecordCheck => {
  const base = {
    id,
    purpose: id === "dkim" ? ("receiving" as const) : ("sending" as const),
    name,
    type: "TXT" as const,
    expected: "v=DKIM1; … p=<public key>",
  }
  const failed = unreachable(base, result)
  if (failed) return failed
  const keys = answers(result).filter((t) => /(^|;)\s*p=/i.test(t))
  if (keys.length === 0)
    return { ...base, actual: answers(result), status: "fail", detail: "No DKIM key at this selector." }
  if (keys.some((k) => /(^|;)\s*p=\s*(;|$)/i.test(k))) {
    return { ...base, actual: keys, status: "fail", detail: "The DKIM key is empty: it has been revoked." }
  }
  return { ...base, actual: keys, status: "pass", detail: "DKIM key published." }
}

/** DMARC at `_dmarc`. `p=none` only monitors, so it passes with a warning. */
export const checkDmarc = (name: string, result: Lookup): RecordCheck => {
  const base = {
    id: "dmarc" as const,
    purpose: "sending" as const,
    name,
    type: "TXT" as const,
    expected: "v=DMARC1; p=quarantine (or reject)",
  }
  const failed = unreachable(base, result)
  if (failed) return failed
  const records = answers(result).filter((t) => /^v=DMARC1/i.test(t.trim()))
  if (records.length === 0) {
    return {
      ...base,
      actual: [],
      status: "fail",
      detail: "No DMARC record: Gmail and Yahoo require one for bulk senders.",
    }
  }
  if (records.length > 1)
    return { ...base, actual: records, status: "fail", detail: "More than one DMARC record." }
  const policy = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(records[0] ?? "")?.[1]?.toLowerCase()
  if (policy === "none") {
    return {
      ...base,
      actual: records,
      status: "warn",
      detail: "p=none only monitors; move to quarantine once reports look clean.",
    }
  }
  if (policy === "quarantine" || policy === "reject") {
    return { ...base, actual: records, status: "pass", detail: `p=${policy}.` }
  }
  return { ...base, actual: records, status: "fail", detail: "DMARC record has no valid p= policy." }
}

/** Runs the checks that apply: receiving needs MX, SPF and routing DKIM; sending needs cf-bounce and DMARC. */
export const checkDomain = Effect.fn("dns.checkDomain")(function* (
  domain: string,
  purposes: { readonly receiving: boolean; readonly sending: boolean },
) {
  const name = domain.toLowerCase()
  const bounce = `${SENDING_SUBDOMAIN}.${name}`
  const checks: Array<RecordCheck> = []
  const all = yield* Effect.all(
    {
      mx: purposes.receiving ? lookup(name, "MX") : Effect.succeed(null),
      spf: purposes.receiving ? lookup(name, "TXT") : Effect.succeed(null),
      dkim: purposes.receiving
        ? lookup(`${ROUTING_DKIM_SELECTOR}._domainkey.${name}`, "TXT")
        : Effect.succeed(null),
      dmarc: purposes.sending || purposes.receiving ? lookup(`_dmarc.${name}`, "TXT") : Effect.succeed(null),
      bounceMx: purposes.sending ? lookup(bounce, "MX") : Effect.succeed(null),
      bounceSpf: purposes.sending ? lookup(bounce, "TXT") : Effect.succeed(null),
      bounceDkim: purposes.sending
        ? lookup(`${SENDING_SUBDOMAIN}._domainkey.${name}`, "TXT")
        : Effect.succeed(null),
    },
    { concurrency: "unbounded" },
  )
  if (all.mx) checks.push(checkMx("mx", name, all.mx))
  if (all.spf) checks.push(checkSpf("spf", name, all.spf))
  if (all.dkim) checks.push(checkDkim("dkim", `${ROUTING_DKIM_SELECTOR}._domainkey.${name}`, all.dkim))
  if (all.bounceMx) checks.push(checkMx("bounce-mx", bounce, all.bounceMx))
  if (all.bounceSpf) checks.push(checkSpf("bounce-spf", bounce, all.bounceSpf))
  if (all.bounceDkim)
    checks.push(checkDkim("bounce-dkim", `${SENDING_SUBDOMAIN}._domainkey.${name}`, all.bounceDkim))
  if (all.dmarc) checks.push(checkDmarc(`_dmarc.${name}`, all.dmarc))
  return {
    domain: name,
    checkedAt: Date.now(),
    status: checks.length ? worst(checks.map((c) => c.status)) : "pass",
    checks,
  } satisfies DomainCheck
})

/** The records a domain needs, for the "add these to your DNS" view. */
export const expectedRecords = (
  domain: string,
  purposes: { readonly receiving: boolean; readonly sending: boolean },
) => {
  const name = domain.toLowerCase()
  const records: Array<{
    readonly purpose: string
    readonly type: RecordType
    readonly name: string
    readonly value: string
  }> = []
  if (purposes.receiving) {
    for (const host of ROUTING_MX) records.push({ purpose: "receiving", type: "MX", name, value: host })
    records.push({ purpose: "receiving", type: "TXT", name, value: `v=spf1 ${CLOUDFLARE_SPF_INCLUDE} ~all` })
    records.push({
      purpose: "receiving",
      type: "TXT",
      name: `${ROUTING_DKIM_SELECTOR}._domainkey.${name}`,
      value: "v=DKIM1; … (from Email Routing)",
    })
  }
  if (purposes.sending) {
    for (const host of ROUTING_MX)
      records.push({ purpose: "sending", type: "MX", name: `${SENDING_SUBDOMAIN}.${name}`, value: host })
    records.push({
      purpose: "sending",
      type: "TXT",
      name: `${SENDING_SUBDOMAIN}.${name}`,
      value: `v=spf1 ${CLOUDFLARE_SPF_INCLUDE} ~all`,
    })
    records.push({
      purpose: "sending",
      type: "TXT",
      name: `${SENDING_SUBDOMAIN}._domainkey.${name}`,
      value: "v=DKIM1; … (from Email Sending)",
    })
  }
  if (purposes.sending || purposes.receiving) {
    records.push({
      purpose: "sending",
      type: "TXT",
      name: `_dmarc.${name}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${name}`,
    })
  }
  return records
}

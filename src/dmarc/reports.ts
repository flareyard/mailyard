import { and, asc, eq, gte, inArray, lte } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { dmarcDaily, dmarcReports, dmarcSources, domains } from "../db/schema.ts"
import { recordAudit } from "../domain/audit.ts"
import { Ids } from "../kit/index.ts"
import { CloudflareZones } from "../services/CloudflareZones.ts"
import { RelayRefusalSchema, relayMessage, withRelay } from "../services/cloudflareApi.ts"
import { chunksOf, Database } from "../services/Database.ts"
import { Dns } from "../services/Dns.ts"
import type { DmarcReport } from "./parse.ts"
import { type DmarcPolicy, parseRecord, policyOf, recommend, ruaOf, tag, withPolicy } from "./policy.ts"
import { providerOf, reverseName } from "./providers.ts"

/**
 * DMARC aggregate reports for a domain (HAL-3375): stored as they arrive at `dmarc@<domain>`, read
 * back per range as totals, sources and a recommendation, and the policy changed with a preview.
 *
 * Reports are added into `dmarc_daily` (domain, day, source IP) when they arrive, so reading a range
 * costs days times sources. A report sent twice is stored once (`dmarc_reports_unique`).
 */

export const DMARC_LOCAL = "dmarc"
const DAY = 86_400_000
/** New IPs reverse-looked up per report; the rest are looked up on the next report naming them. */
const PTR_PER_REPORT = 50

export class DmarcDomainNotFound extends Schema.TaggedError<DmarcDomainNotFound>()("DmarcDomainNotFound", {
  id: Schema.String,
}) {}
export class DmarcChangeRefused extends Schema.TaggedError<DmarcChangeRefused>()("DmarcChangeRefused", {
  reason: Schema.Literals(["no_dns_token", "zone_not_found", "several_records", "write_failed", "invalid"]),
  message: Schema.String,
  relay: Schema.optionalKey(RelayRefusalSchema),
}) {}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const findDomain = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("dmarc.domain", (db) =>
      db.select().from(domains).where(eq(domains.id, id)).get(),
    )
    if (!row) return yield* new DmarcDomainNotFound({ id })
    return row
  })

/** The domain a report address belongs to, if it's one of this workspace's. */
export const domainForReportAddress = Effect.fn("dmarc.domainFor")(function* (address: string) {
  const [local, host] = address.trim().toLowerCase().split("@")
  if (local?.split("+")[0] !== DMARC_LOCAL || !host) return null
  const database = yield* Database
  const row = yield* database.query("dmarc.domainByName", (db) =>
    db.select({ id: domains.id, name: domains.name }).from(domains).where(eq(domains.name, host)).get(),
  )
  return row ?? null
})

const reverse = (ip: string) =>
  Effect.gen(function* () {
    const name = reverseName(ip)
    if (!name) return null
    const dns = yield* Dns
    const result = yield* Effect.result(dns.resolve(name, "PTR"))
    if (result._tag === "Failure") return null
    return result.success.answers[0]?.data.replace(/\.$/, "").toLowerCase() ?? null
  })

type Rollup = {
  messages: number
  dkimAligned: number
  spfAligned: number
  dmarcPass: number
  quarantined: number
  rejected: number
  dkimDomains: Record<string, string>
  spfDomains: Record<string, string>
  overrides: Set<string>
}

/** A result for a domain, keeping a pass over anything else seen for it. */
const merge = (into: Record<string, string>, domain: string, result: string) => {
  if (!domain) return
  if (into[domain] === "pass") return
  into[domain] = result
}

/**
 * Stores one report for a domain: the report row, its records added into the daily rollup, and the
 * sending IPs (reverse-looked up when new). Returns `duplicate` for a report already stored.
 */
export const storeReport = Effect.fn("dmarc.store")(function* (input: {
  readonly domainId: string
  readonly report: DmarcReport
  readonly inboundId: string | null
}) {
  const { report } = input
  const database = yield* Database
  const now = Date.now()
  const id = `dmr_${yield* (yield* Ids).next}`
  const messages = report.records.reduce((n, r) => n + r.count, 0)
  const inserted = yield* database.query("dmarc.reportInsert", (db) =>
    db
      .insert(dmarcReports)
      .values({
        id,
        domainId: input.domainId,
        orgName: report.orgName.slice(0, 200),
        email: report.email?.slice(0, 254) ?? null,
        reportId: report.reportId.slice(0, 200),
        begin: report.begin * 1000,
        end: report.end * 1000,
        policy: { ...report.policy },
        records: report.records.length,
        messages,
        inboundId: input.inboundId,
        receivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: dmarcReports.id })
      .all(),
  )
  if (inserted.length === 0) return { stored: false as const, duplicate: true as const, id: null }

  // The day the report is about: the middle of its range, so a midnight-to-midnight report lands on its day.
  const day = dayOf(((report.begin + report.end) / 2) * 1000)
  const byIp = new Map<string, Rollup>()
  for (const r of report.records) {
    const roll = byIp.get(r.sourceIp) ?? {
      messages: 0,
      dkimAligned: 0,
      spfAligned: 0,
      dmarcPass: 0,
      quarantined: 0,
      rejected: 0,
      dkimDomains: {},
      spfDomains: {},
      overrides: new Set<string>(),
    }
    roll.messages += r.count
    if (r.dkimAligned) roll.dkimAligned += r.count
    if (r.spfAligned) roll.spfAligned += r.count
    if (r.dkimAligned || r.spfAligned) roll.dmarcPass += r.count
    if (r.disposition === "quarantine") roll.quarantined += r.count
    if (r.disposition === "reject") roll.rejected += r.count
    for (const d of r.dkim) merge(roll.dkimDomains, d.domain, d.result)
    for (const s of r.spf) merge(roll.spfDomains, s.domain, s.result)
    for (const o of r.overrides) roll.overrides.add(o)
    byIp.set(r.sourceIp, roll)
  }
  const ips = [...byIp.keys()]
  // What's already counted for that day, merged in memory: one read and one write per IP.
  const existing = new Map<string, typeof dmarcDaily.$inferSelect>()
  for (const chunk of chunksOf(ips, 90)) {
    const rows = yield* database.query("dmarc.dailyRead", (db) =>
      db
        .select()
        .from(dmarcDaily)
        .where(
          and(
            eq(dmarcDaily.domainId, input.domainId),
            eq(dmarcDaily.day, day),
            inArray(dmarcDaily.sourceIp, chunk),
          ),
        )
        .all(),
    )
    for (const row of rows) existing.set(row.sourceIp, row)
  }
  for (const [ip, roll] of byIp) {
    const prior = existing.get(ip)
    const dkimDomains = { ...(prior?.dkimDomains ?? {}) }
    for (const [d, r] of Object.entries(roll.dkimDomains)) merge(dkimDomains, d, r)
    const spfDomains = { ...(prior?.spfDomains ?? {}) }
    for (const [d, r] of Object.entries(roll.spfDomains)) merge(spfDomains, d, r)
    const values = {
      domainId: input.domainId,
      day,
      sourceIp: ip,
      messages: (prior?.messages ?? 0) + roll.messages,
      dkimAligned: (prior?.dkimAligned ?? 0) + roll.dkimAligned,
      spfAligned: (prior?.spfAligned ?? 0) + roll.spfAligned,
      dmarcPass: (prior?.dmarcPass ?? 0) + roll.dmarcPass,
      quarantined: (prior?.quarantined ?? 0) + roll.quarantined,
      rejected: (prior?.rejected ?? 0) + roll.rejected,
      dkimDomains,
      spfDomains,
      overrides: [...new Set([...(prior?.overrides ?? []), ...roll.overrides])].slice(0, 20),
    }
    yield* database.query("dmarc.dailyWrite", (db) =>
      db
        .insert(dmarcDaily)
        .values(values)
        .onConflictDoUpdate({
          target: [dmarcDaily.domainId, dmarcDaily.day, dmarcDaily.sourceIp],
          set: values,
        })
        .run(),
    )
  }

  // The sources: new ones get a reverse name; every one's last-seen moves on.
  const known = new Map<string, typeof dmarcSources.$inferSelect>()
  for (const chunk of chunksOf(ips, 90)) {
    const rows = yield* database.query("dmarc.sourcesRead", (db) =>
      db
        .select()
        .from(dmarcSources)
        .where(and(eq(dmarcSources.domainId, input.domainId), inArray(dmarcSources.ip, chunk)))
        .all(),
    )
    for (const row of rows) known.set(row.ip, row)
  }
  const fresh = ips.filter((ip) => !known.has(ip) || known.get(ip)?.ptr === null)
  const ptrs = new Map<string, string | null>()
  yield* Effect.forEach(
    fresh.slice(0, PTR_PER_REPORT),
    (ip) => reverse(ip).pipe(Effect.map((ptr) => ptrs.set(ip, ptr))),
    { concurrency: 5 },
  )
  const seenAt = report.end * 1000
  for (const ip of ips) {
    const prior = known.get(ip)
    const ptr = ptrs.has(ip) ? (ptrs.get(ip) ?? null) : (prior?.ptr ?? null)
    yield* database.query("dmarc.sourceWrite", (db) =>
      db
        .insert(dmarcSources)
        .values({
          domainId: input.domainId,
          ip,
          ptr,
          provider: providerOf(ptr),
          firstSeen: Math.min(prior?.firstSeen ?? seenAt, seenAt),
          lastSeen: Math.max(prior?.lastSeen ?? seenAt, seenAt),
        })
        .onConflictDoUpdate({
          target: [dmarcSources.domainId, dmarcSources.ip],
          set: {
            ptr,
            provider: providerOf(ptr),
            firstSeen: Math.min(prior?.firstSeen ?? seenAt, seenAt),
            lastSeen: Math.max(prior?.lastSeen ?? seenAt, seenAt),
          },
        })
        .run(),
    )
  }
  return { stored: true as const, duplicate: false as const, id, records: report.records.length, messages }
})

/** The domain's DMARC record as DNS answers it now: none, one, or (wrongly) several. */
const liveRecord = (name: string) =>
  Effect.gen(function* () {
    const dns = yield* Dns
    const result = yield* Effect.result(dns.resolve(`_dmarc.${name}`, "TXT"))
    if (result._tag === "Failure") return { records: [] as Array<string>, error: result.failure.message }
    return {
      records: result.success.answers.map((a) => a.data).filter((t) => /^v=DMARC1/i.test(t.trim())),
      error: null,
    }
  })

const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const
export type DmarcRange = keyof typeof RANGES

const reasonFor = (s: {
  readonly known: boolean
  readonly label: string | null
  readonly messages: number
  readonly dmarcPass: number
  readonly dkimAligned: number
  readonly spfAligned: number
  readonly dkimDomains: Record<string, string>
  readonly spfDomains: Record<string, string>
  readonly overrides: ReadonlyArray<string>
  readonly domain: string
}) => {
  if (s.dmarcPass === s.messages) {
    if (s.dkimAligned === s.messages && s.spfAligned === s.messages) return "Passes DMARC with SPF and DKIM."
    return s.dkimAligned === s.messages ? "Passes DMARC with DKIM." : "Passes DMARC with SPF."
  }
  const notes: Array<string> = []
  if (s.dmarcPass > 0) notes.push(`${s.messages - s.dmarcPass} of ${s.messages} failed DMARC`)
  else notes.push("Fails DMARC")
  const otherSigners = Object.entries(s.dkimDomains)
    .filter(([d, r]) => r === "pass" && d !== s.domain && !d.endsWith(`.${s.domain}`))
    .map(([d]) => d)
  if (otherSigners.length > 0) notes.push(`signed by ${otherSigners.slice(0, 3).join(", ")}, not ${s.domain}`)
  else if (Object.keys(s.dkimDomains).length === 0) notes.push("no DKIM signature")
  const spfPassOther = Object.entries(s.spfDomains)
    .filter(([d, r]) => r === "pass" && d !== s.domain && !d.endsWith(`.${s.domain}`))
    .map(([d]) => d)
  if (spfPassOther.length > 0)
    notes.push(`SPF passes for ${spfPassOther.slice(0, 2).join(", ")}, which isn't aligned`)
  if (s.overrides.length > 0) notes.push(`receiver noted ${s.overrides.join(", ")}`)
  if (s.known) notes.push(s.label ? `marked known: ${s.label}` : "marked known")
  return `${notes.join("; ")}.`
}

/** `GET /v1/domains/{id}/dmarc`: what the reports say about a domain over a range. */
export const dmarcView = Effect.fn("dmarc.view")(function* (domainId: string, range: DmarcRange = "30d") {
  const domain = yield* findDomain(domainId)
  const database = yield* Database
  const days = RANGES[range]
  const to = Date.now()
  const from = to - days * DAY
  const reports = yield* database.query("dmarc.reports", (db) =>
    db
      .select({
        orgName: dmarcReports.orgName,
        email: dmarcReports.email,
        begin: dmarcReports.begin,
        end: dmarcReports.end,
        messages: dmarcReports.messages,
      })
      .from(dmarcReports)
      .where(and(eq(dmarcReports.domainId, domainId), gte(dmarcReports.end, from)))
      .orderBy(asc(dmarcReports.end))
      .all(),
  )
  const daily = yield* database.query("dmarc.daily", (db) =>
    db
      .select()
      .from(dmarcDaily)
      .where(
        and(
          eq(dmarcDaily.domainId, domainId),
          gte(dmarcDaily.day, dayOf(from)),
          lte(dmarcDaily.day, dayOf(to)),
        ),
      )
      .all(),
  )
  const sourceRows = new Map<string, typeof dmarcSources.$inferSelect>()
  const ips = [...new Set(daily.map((d) => d.sourceIp))]
  for (const chunk of chunksOf(ips, 90)) {
    const rows = yield* database.query("dmarc.sources", (db) =>
      db
        .select()
        .from(dmarcSources)
        .where(and(eq(dmarcSources.domainId, domainId), inArray(dmarcSources.ip, chunk)))
        .all(),
    )
    for (const row of rows) sourceRows.set(row.ip, row)
  }

  type Agg = {
    messages: number
    dkimAligned: number
    spfAligned: number
    dmarcPass: number
    quarantined: number
    rejected: number
    dkimDomains: Record<string, string>
    spfDomains: Record<string, string>
    overrides: Set<string>
    days: Set<string>
  }
  const byIp = new Map<string, Agg>()
  for (const d of daily) {
    const a = byIp.get(d.sourceIp) ?? {
      messages: 0,
      dkimAligned: 0,
      spfAligned: 0,
      dmarcPass: 0,
      quarantined: 0,
      rejected: 0,
      dkimDomains: {},
      spfDomains: {},
      overrides: new Set<string>(),
      days: new Set<string>(),
    }
    a.messages += d.messages
    a.dkimAligned += d.dkimAligned
    a.spfAligned += d.spfAligned
    a.dmarcPass += d.dmarcPass
    a.quarantined += d.quarantined
    a.rejected += d.rejected
    for (const [k, v] of Object.entries(d.dkimDomains)) merge(a.dkimDomains, k, v)
    for (const [k, v] of Object.entries(d.spfDomains)) merge(a.spfDomains, k, v)
    for (const o of d.overrides) a.overrides.add(o)
    a.days.add(d.day)
    byIp.set(d.sourceIp, a)
  }
  const sources = [...byIp.entries()]
    .map(([ip, a]) => {
      const row = sourceRows.get(ip)
      const markedKnown = row?.known ?? false
      const passes = a.messages > 0 && a.dmarcPass === a.messages
      const summary = {
        known: markedKnown,
        label: row?.label ?? null,
        messages: a.messages,
        dmarcPass: a.dmarcPass,
        dkimAligned: a.dkimAligned,
        spfAligned: a.spfAligned,
        dkimDomains: a.dkimDomains,
        spfDomains: a.spfDomains,
        overrides: [...a.overrides],
        domain: domain.name,
      }
      return {
        ip,
        ptr: row?.ptr ?? null,
        provider: row?.provider ?? null,
        messages: a.messages,
        spfPass: a.spfAligned,
        dkimPass: a.dkimAligned,
        dmarcPass: a.dmarcPass,
        quarantined: a.quarantined,
        rejected: a.rejected,
        /** Marked known by someone, or every message passed DMARC. */
        known: markedKnown || passes,
        markedKnown,
        label: row?.label ?? null,
        reason: reasonFor(summary),
        dkimDomains: a.dkimDomains,
        spfDomains: a.spfDomains,
        firstSeen: row?.firstSeen ?? null,
        lastSeen: row?.lastSeen ?? null,
      }
    })
    .sort((x, y) => y.messages - x.messages || x.ip.localeCompare(y.ip))

  const totals = sources.reduce(
    (t, s) => ({
      messages: t.messages + s.messages,
      dmarcPass: t.dmarcPass + s.dmarcPass,
      dkimPass: t.dkimPass + s.dkimPass,
      spfPass: t.spfPass + s.spfPass,
      quarantined: t.quarantined + s.quarantined,
      rejected: t.rejected + s.rejected,
    }),
    { messages: 0, dmarcPass: 0, dkimPass: 0, spfPass: 0, quarantined: 0, rejected: 0 },
  )
  const live = yield* liveRecord(domain.name)
  const parsed = live.records.length === 1 && live.records[0] ? parseRecord(live.records[0]) : null
  const p = parsed ? policyOf(parsed) : null
  const pctRaw = parsed ? tag(parsed, "pct") : null
  const pct = pctRaw !== null && Number.isFinite(Number(pctRaw)) ? Number(pctRaw) : null
  const reportDays = new Set(daily.map((d) => d.day))
  const reporters = new Map<
    string,
    { org: string; email: string | null; reports: number; messages: number }
  >()
  for (const r of reports) {
    const entry = reporters.get(r.orgName) ?? { org: r.orgName, email: r.email, reports: 0, messages: 0 }
    entry.reports += 1
    entry.messages += r.messages
    reporters.set(r.orgName, entry)
  }
  const rec = recommend({
    policy: p,
    pct,
    days: reportDays.size,
    messages: totals.messages,
    sources: sources.map((s) => ({ ip: s.ip, messages: s.messages, dmarcPass: s.dmarcPass, known: s.known })),
  })
  const rua = parsed ? ruaOf(parsed) : []
  const address = `${DMARC_LOCAL}@${domain.name}`
  return {
    domain: { id: domain.id, name: domain.name },
    range: { key: range, from, to, days },
    /** Where reports should go so Mailyard reads them, and whether the record sends them there. */
    receiving: {
      address,
      inRua: rua.includes(address),
      /** Mailyard receives mail for this domain; without it, reports to `address` never arrive. */
      routed: domain.routingEnabled,
    },
    reports: reports.length,
    reportDays: reportDays.size,
    lastReportAt: reports.at(-1)?.end ?? null,
    reporters: [...reporters.values()].sort((a, b) => b.messages - a.messages),
    policy: {
      record: live.records.length === 1 ? (live.records[0] ?? null) : null,
      records: live.records,
      lookupError: live.error,
      p,
      sp: parsed ? tag(parsed, "sp") : null,
      pct,
      adkim: parsed ? tag(parsed, "adkim") : null,
      aspf: parsed ? tag(parsed, "aspf") : null,
      rua,
    },
    totals,
    sources,
    recommendation: {
      ...rec,
      nextRecord: rec.next ? withPolicy(parsed, rec.next.p, rec.next.pct) : null,
    },
  }
})

/** Marks a sending IP as known (a forwarder, a service that's yours), or not. */
export const markSource = Effect.fn("dmarc.markSource")(function* (input: {
  readonly domainId: string
  readonly ip: string
  readonly known: boolean
  readonly label?: string | null | undefined
  readonly actor: string
}) {
  yield* findDomain(input.domainId)
  const database = yield* Database
  const now = Date.now()
  const label = input.known ? (input.label?.trim().slice(0, 100) ?? null) : null
  const row = yield* database.query("dmarc.mark", (db) =>
    db
      .insert(dmarcSources)
      .values({
        domainId: input.domainId,
        ip: input.ip,
        known: input.known,
        label,
        markedBy: input.actor,
        markedAt: now,
        firstSeen: now,
        lastSeen: now,
      })
      .onConflictDoUpdate({
        target: [dmarcSources.domainId, dmarcSources.ip],
        set: { known: input.known, label, markedBy: input.actor, markedAt: now },
      })
      .returning()
      .get(),
  )
  yield* recordAudit({
    actor: input.actor,
    action: input.known ? "dmarc.source.known" : "dmarc.source.unknown",
    target: input.domainId,
    after: { ip: input.ip, label },
  })
  return { ip: row.ip, known: row.known, label: row.label, markedBy: row.markedBy, markedAt: row.markedAt }
})

/**
 * Changes the domain's DMARC policy. With `dryRun`, only says what the record would become. Otherwise
 * writes it through the zone token: the one record updated in place (every other tag kept), or one
 * added when there's none. Several records are left for a person, since which one counts is unclear.
 */
export const changePolicy = Effect.fn("dmarc.changePolicy")(function* (input: {
  readonly domainId: string
  readonly p: DmarcPolicy
  readonly pct?: number | null | undefined
  readonly dryRun: boolean
  readonly actor: string
}) {
  const domain = yield* findDomain(input.domainId)
  if (input.pct !== undefined && input.pct !== null && (input.pct < 0 || input.pct > 100))
    return yield* new DmarcChangeRefused({ reason: "invalid", message: "pct is a percentage, 0 to 100." })
  const live = yield* liveRecord(domain.name)
  if (live.records.length > 1)
    return yield* new DmarcChangeRefused({
      reason: "several_records",
      message: `_dmarc.${domain.name} has ${live.records.length} DMARC records, so receivers ignore them all. Delete the extras by hand first.`,
    })
  const before = live.records[0] ?? null
  const parsed = before ? parseRecord(before) : null
  const withRua = parsed ?? parseRecord(`v=DMARC1; p=none; rua=mailto:${DMARC_LOCAL}@${domain.name}`)
  const after = withPolicy(withRua, input.p, input.pct ?? null)
  const name = `_dmarc.${domain.name}`
  if (input.dryRun) return { name, before, after, applied: false, changed: before !== after }
  if (before === after) return { name, before, after, applied: false, changed: false }
  const zones = yield* CloudflareZones
  if (!zones.connected)
    return yield* new DmarcChangeRefused({
      reason: "no_dns_token",
      message:
        "Mailyard can't reach Cloudflare to change DNS: install it through Flareyard, or set CLOUDFLARE_DNS_TOKEN. Until then, set the record shown by hand.",
    })
  const found = yield* zones.findZone(domain.name)
  const zone = found.value
  if (Option.isNone(zone))
    return yield* new DmarcChangeRefused({
      reason: "zone_not_found",
      message: found.relay ? relayMessage(found.relay) : `Mailyard can't see a zone for ${domain.name}.`,
      ...withRelay(found.relay),
    })
  const existing = yield* zones.txtRecords(zone.value.id, name)
  const dmarcRecords = Option.getOrElse(existing, () => []).filter((r) =>
    /^"?v=DMARC1/i.test(r.content.trim()),
  )
  if (dmarcRecords.length > 1)
    return yield* new DmarcChangeRefused({
      reason: "several_records",
      message: `The zone has ${dmarcRecords.length} DMARC records at ${name}. Delete the extras by hand first.`,
    })
  const target = dmarcRecords[0]
  const out = target
    ? yield* zones.updateTxt(zone.value.id, target.id, name, after)
    : yield* zones.createTxt(zone.value.id, name, after)
  if (!out.ok)
    return yield* new DmarcChangeRefused({
      reason: "write_failed",
      message: out.message,
      ...withRelay(out.relay),
    })
  yield* recordAudit({
    actor: input.actor,
    action: "dmarc.policy",
    target: input.domainId,
    before: { record: before },
    after: { record: after },
  })
  return { name, before, after, applied: true, changed: true }
})

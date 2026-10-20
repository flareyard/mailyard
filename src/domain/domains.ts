import { and, asc, count, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { domains, mailboxes } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import type { WriteOutcome } from "../services/CloudflareEmail.ts"
import { CloudflareZones } from "../services/CloudflareZones.ts"
import { type RelayRefusal, RelayRefusalSchema, relayMessage, withRelay } from "../services/cloudflareApi.ts"
import { Database } from "../services/Database.ts"
import { Dns } from "../services/Dns.ts"
import { clearAlert, raiseAlert } from "./alerts.ts"
import { recordAudit } from "./audit.ts"
import { checkDomain, type DomainCheck, expectedRecords, type RecordCheck } from "./dnsChecks.ts"
import { readZoneInfo } from "./zoneInfo.ts"

export class DomainNotFound extends Schema.TaggedError<DomainNotFound>()("DomainNotFound", {
  id: Schema.String,
}) {}
export class DomainInvalid extends Schema.TaggedError<DomainInvalid>()("DomainInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
export class DomainConflict extends Schema.TaggedError<DomainConflict>()("DomainConflict", {
  message: Schema.String,
}) {}

type DomainRow = typeof domains.$inferSelect

/** A hostname of at least two labels, each 1–63 letters, digits or hyphens, not starting or ending with one. */
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

export const normalizeDomain = (name: string) => name.trim().toLowerCase().replace(/\.$/, "")

const purposesOf = (d: DomainRow) => ({ receiving: d.routingEnabled, sending: d.sendingEnabled })

const describe = (d: DomainRow, mailboxCount: number) => {
  const checks = d.checks ?? null
  return {
    id: d.id,
    name: d.name,
    zoneId: d.zoneId,
    receiving: d.routingEnabled,
    sending: d.sendingEnabled,
    catchAll: d.catchAll,
    mailboxCount,
    lastCheckedAt: d.lastCheckedAt,
    checkStatus: checks ? worstOf(checks) : null,
    zoneStatus: d.zone?.zoneStatus ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

const RANK = { pass: 0, warn: 1, error: 2, fail: 3, checking: 4 } as const
const worstOf = (checks: DomainCheck["checks"]) =>
  checks.reduce<keyof typeof RANK>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "pass")

export type DomainSummary = ReturnType<typeof describe>

const findDomain = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("domains.find", (db) =>
      db.select().from(domains).where(eq(domains.id, id)).get(),
    )
    if (!row) return yield* new DomainNotFound({ id })
    return row
  })

const mailboxCountOf = (domainId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("domains.mailboxCount", (db) =>
      db.select({ n: count() }).from(mailboxes).where(eq(mailboxes.domainId, domainId)).get(),
    )
    return row?.n ?? 0
  })

export const listDomains = Effect.fn("domains.list")(function* () {
  const database = yield* Database
  const rows = yield* database.query("domains.list", (db) =>
    db.select().from(domains).orderBy(asc(domains.name)).all(),
  )
  const counts = yield* database.query("domains.counts", (db) =>
    db.select({ domainId: mailboxes.domainId, n: count() }).from(mailboxes).groupBy(mailboxes.domainId).all(),
  )
  const byDomain = new Map(counts.map((c) => [c.domainId, c.n]))
  return rows.map((d) => describe(d, byDomain.get(d.id) ?? 0))
})

/** The domain, its last check, the records it needs, and the addresses on it. */
export const getDomain = Effect.fn("domains.get")(function* (id: string) {
  const d = yield* findDomain(id)
  const database = yield* Database
  const addresses = yield* database.query("domains.addresses", (db) =>
    db
      .select({
        id: mailboxes.id,
        address: mailboxes.address,
        kind: mailboxes.kind,
        displayName: mailboxes.displayName,
      })
      .from(mailboxes)
      .where(eq(mailboxes.domainId, id))
      .orderBy(asc(mailboxes.address))
      .all(),
  )
  const zone = d.zone ?? null
  return {
    ...describe(d, addresses.length),
    zoneName: zone?.zoneName ?? null,
    nameservers: zone?.nameservers ?? null,
    currentNameservers: zone?.currentNameservers ?? null,
    registrar: zone?.registrar ?? null,
    dnssec: zone?.dnssec ?? null,
    complaints30d: zone?.complaints30d ?? null,
    returnPath: zone?.returnPath ?? (d.sendingEnabled ? `cf-bounce.${d.name}` : null),
    zoneCheckedAt: zone?.checkedAt ?? null,
    ...(zone?.relay ? { zoneRelay: zone.relay } : {}),
    checks: d.checks ?? [],
    expectedRecords: expectedRecords(d.name, purposesOf(d)),
    mailboxes: addresses,
  }
})

/** Re-reads the domain's DNS and stores the result. A lookup failure is recorded as `error`, not raised. */
export const recheckDomain = Effect.fn("domains.recheck")(function* (id: string) {
  const d = yield* findDomain(id)
  const database = yield* Database
  // While the lookups run, a reader sees each stored check as `checking` (HAL-3365).
  if (d.checks?.length)
    yield* database.query("domains.markChecking", (db) =>
      db
        .update(domains)
        .set({ checks: d.checks?.map((c) => ({ ...c, status: "checking" as const })) ?? null })
        .where(eq(domains.id, id))
        .run(),
    )
  const [fresh, zone] = yield* Effect.all(
    [checkDomain(d.name, purposesOf(d)), readZoneInfo(d.name, { sending: d.sendingEnabled })],
    { concurrency: 2 },
  )
  // Each check keeps when it last changed status, so the screens can say "failing since".
  const before = new Map((d.checks ?? []).map((c) => [c.id, c]))
  const result = {
    ...fresh,
    checks: fresh.checks.map((c) => {
      const prev = before.get(c.id)
      return {
        ...c,
        changedAt:
          prev && prev.status === c.status
            ? (prev.changedAt ?? d.lastCheckedAt ?? fresh.checkedAt)
            : fresh.checkedAt,
      }
    }),
  }
  const allPass = result.checks.length > 0 && result.checks.every((c) => c.status === "pass")
  const activating = allPass && d.activatedAt === null
  yield* database.query("domains.saveCheck", (db) =>
    db
      .update(domains)
      .set({
        checks: result.checks,
        zone: zone.info,
        ...(zone.zoneId && !d.zoneId ? { zoneId: zone.zoneId } : {}),
        lastCheckedAt: result.checkedAt,
        ...(activating ? { activatedAt: result.checkedAt } : {}),
      })
      .where(eq(domains.id, id))
      .run(),
  )
  if (activating)
    yield* raiseAlert({
      key: `domain_activated:${id}`,
      kind: "domain_activated",
      severity: "info",
      title: `${d.name} is ready`,
      detail: `Every DNS record checks out: ${
        d.routingEnabled && d.sendingEnabled
          ? "receiving and sending work"
          : d.routingEnabled
            ? "receiving works"
            : "sending works"
      } on ${d.name}.`,
      subject: { type: "domain", id },
    })
  yield* watchDrift(d, result.checks, activating)
  return yield* getDomain(id)
})

/**
 * `dns_drift:<domain>`: once a domain has been fully set up, a record that now fails is drift: someone
 * changed DNS, or a provider rewrote it. Lookup errors don't count (a resolver hiccup isn't drift).
 * Clears when every record passes again.
 */
const watchDrift = (
  d: typeof domains.$inferSelect,
  checks: ReadonlyArray<RecordCheck>,
  justActivated: boolean,
) =>
  Effect.gen(function* () {
    const key = `dns_drift:${d.id}`
    if (d.activatedAt === null && !justActivated) return
    const failing = checks.filter((c) => c.status === "fail")
    if (failing.length === 0) {
      if (checks.every((c) => c.status === "pass")) yield* clearAlert(key, "dns-check")
      return
    }
    const breaksMail = failing.some(
      (c) => c.id === "mx" || c.id === "bounce-mx" || c.id === "spf" || c.id === "dkim",
    )
    yield* raiseAlert({
      key,
      kind: "dns_drift",
      severity: breaksMail ? "critical" : "warning",
      title: `${d.name}'s DNS changed: ${failing.map((c) => c.id.toUpperCase()).join(", ")} ${failing.length === 1 ? "no longer passes" : "no longer pass"}`,
      detail: failing
        .map((c) => `${c.type} ${c.name}: ${c.detail}`)
        .join(" ")
        .slice(0, 1000),
      subject: { type: "domain", id: d.id },
      count: failing.length,
    })
  })

export interface DomainInput {
  readonly name: string
  readonly receiving?: boolean | undefined
  readonly sending?: boolean | undefined
  readonly catchAll?: "bounce" | "keep" | undefined
  readonly zoneId?: string | null | undefined
}

/**
 * Adds a domain Mailyard handles. Turning on Email Routing and Sending on Cloudflare's side stays with
 * the platform deploy; this records the domain and checks what its DNS says today.
 */
export const createDomain = Effect.fn("domains.create")(function* (input: DomainInput, actor: string) {
  const name = normalizeDomain(input.name)
  if (!HOSTNAME.test(name))
    return yield* new DomainInvalid({ field: "name", message: `${input.name} is not a domain name.` })
  if (input.catchAll === "keep") {
    return yield* new DomainInvalid({
      field: "catchAll",
      message: "Add the domain, then a catch-all mailbox on it, then set catchAll to keep.",
    })
  }
  const database = yield* Database
  const existing = yield* database.query("domains.byName", (db) =>
    db.select({ id: domains.id }).from(domains).where(eq(domains.name, name)).get(),
  )
  if (existing) return yield* new DomainConflict({ message: `${name} is already added.` })
  const id = `dom_${yield* (yield* Ids).next}`
  const now = Date.now()
  yield* database.query("domains.insert", (db) =>
    db
      .insert(domains)
      .values({
        id,
        name,
        zoneId: input.zoneId ?? null,
        routingEnabled: input.receiving ?? true,
        sendingEnabled: input.sending ?? true,
        catchAll: "bounce",
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  )
  yield* recordAudit({
    actor,
    action: "domain.created",
    target: id,
    after: { name, receiving: input.receiving ?? true, sending: input.sending ?? true },
  })
  return yield* recheckDomain(id)
})

/** Changes the catch-all policy or what the domain is used for. `keep` needs a catch-all mailbox first. */
export const updateDomain = Effect.fn("domains.update")(function* (
  id: string,
  patch: Omit<DomainInput, "name">,
  actor: string,
) {
  const d = yield* findDomain(id)
  const database = yield* Database
  if (patch.catchAll === "keep") {
    const catchAll = yield* database.query("domains.catchAllMailbox", (db) =>
      db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.domainId, id), eq(mailboxes.kind, "catch_all")))
        .get(),
    )
    if (!catchAll) {
      return yield* new DomainInvalid({
        field: "catchAll",
        message: `Create a catch_all mailbox on ${d.name} before keeping unknown addresses.`,
      })
    }
  }
  const set = {
    ...(patch.catchAll !== undefined ? { catchAll: patch.catchAll } : {}),
    ...(patch.receiving !== undefined ? { routingEnabled: patch.receiving } : {}),
    ...(patch.sending !== undefined ? { sendingEnabled: patch.sending } : {}),
    ...(patch.zoneId !== undefined ? { zoneId: patch.zoneId } : {}),
    updatedAt: Date.now(),
  }
  yield* database.query("domains.update", (db) => db.update(domains).set(set).where(eq(domains.id, id)).run())
  yield* recordAudit({
    actor,
    action: "domain.updated",
    target: id,
    before: {
      catchAll: d.catchAll,
      receiving: d.routingEnabled,
      sending: d.sendingEnabled,
      zoneId: d.zoneId,
    },
    after: set,
  })
  return yield* getDomain(id)
})

/** Removes a domain with no addresses left on it. */
export const deleteDomain = Effect.fn("domains.delete")(function* (id: string, actor: string) {
  const d = yield* findDomain(id)
  const n = yield* mailboxCountOf(id)
  if (n > 0)
    return yield* new DomainConflict({
      message: `${d.name} still has ${n} address${n === 1 ? "" : "es"}; remove them first.`,
    })
  const database = yield* Database
  yield* database.query("domains.delete", (db) => db.delete(domains).where(eq(domains.id, id)).run())
  yield* recordAudit({ actor, action: "domain.deleted", target: id, before: { name: d.name } })
  return describe(d, 0)
})

// ---------------------------------------------------------------------------------------------
// Fixing records, and the account's other zones (HAL-3365)
// ---------------------------------------------------------------------------------------------

export class DomainFixRefused extends Schema.TaggedError<DomainFixRefused>()("DomainFixRefused", {
  reason: Schema.Literals(["no_dns_token", "zone_not_found", "nothing_to_fix"]),
  message: Schema.String,
  relay: Schema.optionalKey(RelayRefusalSchema),
}) {}

export interface FixAction {
  readonly checks: ReadonlyArray<RecordCheck["id"]>
  readonly action: "enable_routing" | "fix_sending" | "add_dmarc" | "manual"
  readonly ok: boolean
  readonly detail: string
  /** Set when Flareyard's relay refused the change (HAL-3558). */
  readonly relay?: RelayRefusal
}

/** A fix's outcome as an action: what it did, or Cloudflare's (or the relay's) words and code. */
const actionOf = (
  checks: ReadonlyArray<RecordCheck["id"]>,
  action: FixAction["action"],
  out: WriteOutcome<unknown>,
  done: string,
): FixAction => ({
  checks,
  action,
  ok: out.ok,
  detail: out.ok ? done : out.message,
  ...(out.ok ? {} : withRelay(out.relay)),
})

const RECEIVING_CHECKS = new Set<RecordCheck["id"]>(["mx", "spf", "dkim"])
const SENDING_CHECKS = new Set<RecordCheck["id"]>(["bounce-mx", "bounce-spf", "bounce-dkim"])

/**
 * `POST /v1/domains/{id}/fix`: re-applies what fails, the way Cloudflare's own buttons do. Receiving
 * records (MX, SPF, routing DKIM) through Email Routing's "enable DNS", the cf-bounce records through
 * Email Sending's "fix DNS" (or by onboarding the subdomain), and a missing DMARC record as a TXT.
 * A DMARC record that exists but is wrong is left for a person: rewriting someone's policy is theirs
 * to decide. Then rechecks. Needs CLOUDFLARE_DNS_TOKEN with Email Routing: Edit and Email Sending: Edit.
 */
export const fixDomain = Effect.fn("domains.fix")(function* (id: string, actor: string) {
  const zones = yield* CloudflareZones
  if (!zones.connected)
    return yield* new DomainFixRefused({
      reason: "no_dns_token",
      message:
        "Mailyard can't reach Cloudflare to change DNS: install it through Flareyard, or set CLOUDFLARE_DNS_TOKEN. Until then, add the records shown by hand.",
    })
  const d = yield* findDomain(id)
  const failing = (d.checks ?? []).filter((c) => c.status === "fail" || c.status === "warn")
  if (failing.length === 0)
    return yield* new DomainFixRefused({
      reason: "nothing_to_fix",
      message: "Every record passed at the last check. Recheck first if DNS changed since.",
    })
  const found = yield* zones.findZone(d.name)
  const zone = found.value
  if (Option.isNone(zone))
    return yield* new DomainFixRefused({
      reason: "zone_not_found",
      message: found.relay
        ? relayMessage(found.relay)
        : `Mailyard can't see a zone for ${d.name}. Is the domain on this Cloudflare account?`,
      ...withRelay(found.relay),
    })
  const zoneId = zone.value.id
  const actions: Array<FixAction> = []
  const receiving = failing.filter((c) => RECEIVING_CHECKS.has(c.id)).map((c) => c.id)
  if (receiving.length > 0) {
    const out = yield* zones.enableRouting(zoneId, d.name)
    actions.push(
      actionOf(receiving, "enable_routing", out, "Email Routing re-added its MX, SPF and DKIM records."),
    )
  }
  const sending = failing.filter((c) => SENDING_CHECKS.has(c.id)).map((c) => c.id)
  if (sending.length > 0) {
    const out = yield* zones.fixSending(zoneId, d.name)
    actions.push(actionOf(sending, "fix_sending", out, "Email Sending re-applied the cf-bounce records."))
  }
  const dmarc = failing.find((c) => c.id === "dmarc")
  if (dmarc) {
    if (dmarc.actual.length === 0) {
      const out = yield* zones.createTxt(
        zoneId,
        `_dmarc.${d.name}`,
        `v=DMARC1; p=quarantine; rua=mailto:dmarc@${d.name}`,
      )
      actions.push(actionOf(["dmarc"], "add_dmarc", out, "Added a DMARC record with p=quarantine."))
    } else
      actions.push({
        checks: ["dmarc"],
        action: "manual",
        ok: false,
        detail: `There's already a DMARC record (${dmarc.detail}) Mailyard won't overwrite: edit it by hand.`,
      })
  }
  yield* recordAudit({ actor, action: "domain.fixed", target: id, after: { actions } })
  const domain = yield* recheckDomain(id)
  return { domain, actions }
})

/**
 * `GET /v1/domains/candidates`: the zones the token can see, each with whether it's in the workspace
 * (itself or a subdomain of it) and what its MX says today, so first-run can offer them.
 */
export const domainCandidates = Effect.fn("domains.candidates")(function* () {
  const zones = yield* CloudflareZones
  if (!zones.connected) return { connected: false, candidates: [] }
  const listed = yield* zones.zones
  const all = listed.value
  if (Option.isNone(all))
    return {
      connected: false,
      candidates: [],
      ...(listed.relay ? { message: relayMessage(listed.relay), relay: listed.relay } : {}),
    }
  const database = yield* Database
  const names = (yield* database.query("domains.names", (db) =>
    db.select({ name: domains.name }).from(domains).all(),
  )).map((r) => r.name)
  const dns = yield* Dns
  const candidates = yield* Effect.forEach(
    all.value,
    (z) =>
      Effect.gen(function* () {
        const mx = yield* dns.resolve(z.name, "MX").pipe(Effect.option)
        const inWorkspace = names.filter((n) => n === z.name || n.endsWith(`.${z.name}`))
        return {
          name: z.name,
          zoneId: z.id,
          zoneStatus: z.status,
          nameservers: (z.name_servers ?? []).map((n) => n.toLowerCase()),
          registrar: z.original_registrar ?? null,
          inWorkspace: inWorkspace.length > 0,
          workspaceDomains: inWorkspace,
          existingMx: Option.match(mx, { onNone: () => [], onSome: (r) => r.answers.map((a) => a.data) }),
        }
      }),
    { concurrency: 8 },
  )
  return { connected: true, candidates }
})

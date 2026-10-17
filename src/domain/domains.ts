import { and, asc, count, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { domains, mailboxes } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { clearAlert, raiseAlert } from "./alerts.ts"
import { recordAudit } from "./audit.ts"
import { checkDomain, type DomainCheck, expectedRecords, type RecordCheck } from "./dnsChecks.ts"

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
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

const RANK = { pass: 0, warn: 1, error: 2, fail: 3 } as const
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
  return {
    ...describe(d, addresses.length),
    checks: d.checks ?? [],
    expectedRecords: expectedRecords(d.name, purposesOf(d)),
    mailboxes: addresses,
  }
})

/** Re-reads the domain's DNS and stores the result. A lookup failure is recorded as `error`, not raised. */
export const recheckDomain = Effect.fn("domains.recheck")(function* (id: string) {
  const d = yield* findDomain(id)
  const result = yield* checkDomain(d.name, purposesOf(d))
  const database = yield* Database
  const allPass = result.checks.length > 0 && result.checks.every((c) => c.status === "pass")
  const activating = allPass && d.activatedAt === null
  yield* database.query("domains.saveCheck", (db) =>
    db
      .update(domains)
      .set({
        checks: result.checks,
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

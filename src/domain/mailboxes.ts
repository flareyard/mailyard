import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { apiKeys, domains, mailboxExports, mailboxes, mailboxMembers } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { SPAM_THRESHOLD } from "../rules/spam.ts"
import { Database, queryIn } from "../services/Database.ts"
import { Mailboxes } from "../services/Mailboxes.ts"
import type { Caller } from "./apiKeys.ts"
import { activeKey, isRevoked } from "./apiKeys.ts"
import { recordAudit } from "./audit.ts"

export class MailboxNotFound extends Schema.TaggedError<MailboxNotFound>()("MailboxNotFound", {
  id: Schema.String,
}) {}
export class MailboxInvalid extends Schema.TaggedError<MailboxInvalid>()("MailboxInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
export class MailboxConflict extends Schema.TaggedError<MailboxConflict>()("MailboxConflict", {
  message: Schema.String,
}) {}

export type MailboxKind = (typeof mailboxes.$inferSelect)["kind"]
type MailboxRow = typeof mailboxes.$inferSelect
type Signature = NonNullable<MailboxRow["signature"]>
type AutoReply = NonNullable<MailboxRow["autoReply"]>
type Forwarding = NonNullable<MailboxRow["forwarding"]>
export type MemberRole = (typeof mailboxMembers.$inferSelect)["role"]

/** Kinds that hold mail in their own MailboxDO; aliases and groups only point at them. */
export const HOLDS_MAIL: ReadonlySet<MailboxKind> = new Set(["user", "shared", "catch_all"])

/** RFC 5321 allows more, but these are the local parts every mail system accepts. */
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const MAX_FORWARD_TO = 10
export const MAX_GROUP_TARGETS = 100

const findMailbox = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("mailboxes.find", (db) =>
      db.select().from(mailboxes).where(eq(mailboxes.id, id)).get(),
    )
    if (!row) return yield* new MailboxNotFound({ id })
    return row
  })

const summary = (m: MailboxRow) => ({
  id: m.id,
  address: m.address,
  domainId: m.domainId,
  kind: m.kind,
  displayName: m.displayName,
  holdsMail: HOLDS_MAIL.has(m.kind),
  targetIds: m.targets ?? [],
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
})

export type MailboxSummary = ReturnType<typeof summary>

export const listMailboxes = Effect.fn("mailboxes.list")(function* (filter: {
  readonly domainId?: string | undefined
  readonly kind?: MailboxKind | undefined
}) {
  const database = yield* Database
  const rows = yield* database.query("mailboxes.list", (db) =>
    db
      .select()
      .from(mailboxes)
      .where(
        and(
          filter.domainId ? eq(mailboxes.domainId, filter.domainId) : undefined,
          filter.kind ? eq(mailboxes.kind, filter.kind) : undefined,
        ),
      )
      .orderBy(asc(mailboxes.address))
      .all(),
  )
  return rows.map(summary)
})

/** Everything the mailbox settings screen shows, including how much mail it holds and its last export. */
export const getMailbox = Effect.fn("mailboxes.get")(function* (id: string) {
  const m = yield* findMailbox(id)
  const database = yield* Database
  const targetRows = m.targets?.length
    ? yield* queryIn("mailboxes.targets", [...(m.targets ?? [])], (db, chunk) =>
        db
          .select({ id: mailboxes.id, address: mailboxes.address, kind: mailboxes.kind })
          .from(mailboxes)
          .where(inArray(mailboxes.id, chunk))
          .all(),
      )
    : []
  const byId = new Map(targetRows.map((t) => [t.id, t]))
  const members = yield* database.query("mailboxes.members", (db) =>
    db
      .select({
        apiKeyId: mailboxMembers.apiKeyId,
        role: mailboxMembers.role,
        name: apiKeys.name,
        revokedAt: apiKeys.revokedAt,
      })
      .from(mailboxMembers)
      .innerJoin(apiKeys, eq(apiKeys.id, mailboxMembers.apiKeyId))
      .where(eq(mailboxMembers.mailboxId, id))
      .orderBy(asc(apiKeys.name))
      .all(),
  )
  const lastExport = yield* database.query("mailboxes.lastExport", (db) =>
    db
      .select()
      .from(mailboxExports)
      .where(eq(mailboxExports.mailboxId, id))
      .orderBy(desc(mailboxExports.createdAt))
      .get(),
  )
  const messageCount = HOLDS_MAIL.has(m.kind) ? yield* (yield* Mailboxes).count(id) : null
  return {
    ...summary(m),
    targets: (m.targets ?? []).map((t) => byId.get(t) ?? { id: t, address: null, kind: null }),
    signature: m.signature ?? null,
    autoReply: m.autoReply ?? null,
    forwarding: m.forwarding ?? null,
    spamThreshold: m.spamThreshold ?? SPAM_THRESHOLD,
    spamThresholdIsDefault: m.spamThreshold === null,
    members: members.map((r) => ({
      apiKeyId: r.apiKeyId,
      name: r.name,
      role: r.role,
      revoked: isRevoked(r.revokedAt),
    })),
    messageCount,
    lastExport: lastExport
      ? {
          id: lastExport.id,
          status: lastExport.status,
          format: lastExport.format,
          messageCount: lastExport.messageCount,
          size: lastExport.size,
          createdAt: lastExport.createdAt,
          completedAt: lastExport.completedAt,
        }
      : null,
  }
})

/**
 * Checks proposed alias or group targets: they exist, aren't the mailbox itself, and between them reach at
 * least one mailbox that holds mail. Cycles through other aliases are tolerated (the resolver stops them)
 * as long as something real is reached.
 */
const checkTargets = Effect.fn("mailboxes.checkTargets")(function* (
  selfId: string | null,
  kind: MailboxKind,
  targets: ReadonlyArray<string>,
) {
  if (kind === "alias" && targets.length !== 1) {
    return yield* new MailboxInvalid({ field: "targets", message: "An alias points at exactly one mailbox." })
  }
  if (kind === "group" && (targets.length === 0 || targets.length > MAX_GROUP_TARGETS)) {
    return yield* new MailboxInvalid({
      field: "targets",
      message: `A group has 1 to ${MAX_GROUP_TARGETS} members.`,
    })
  }
  const unique = [...new Set(targets)]
  if (selfId && unique.includes(selfId)) {
    return yield* new MailboxInvalid({ field: "targets", message: "A mailbox can't deliver to itself." })
  }
  const seen = new Set<string>(selfId ? [selfId] : [])
  let frontier = unique
  let reachesMail = false
  for (let depth = 0; frontier.length > 0 && depth < 8; depth++) {
    const rows = yield* queryIn("mailboxes.expand", frontier, (db, chunk) =>
      db.select().from(mailboxes).where(inArray(mailboxes.id, chunk)).all(),
    )
    if (depth === 0) {
      const missing = unique.filter((id) => !rows.some((r) => r.id === id))
      if (missing.length > 0) {
        return yield* new MailboxInvalid({ field: "targets", message: `No mailbox ${missing.join(", ")}.` })
      }
    }
    for (const r of rows) seen.add(r.id)
    if (rows.some((r) => HOLDS_MAIL.has(r.kind))) reachesMail = true
    frontier = rows.flatMap((r) => (r.targets ?? []).filter((t) => !seen.has(t)))
  }
  if (!reachesMail) {
    return yield* new MailboxInvalid({
      field: "targets",
      message: "These targets don't reach any mailbox that holds mail.",
    })
  }
  return unique
})

const checkSignature = (signature: Signature | null | undefined) =>
  Effect.gen(function* () {
    if (!signature) return signature ?? null
    if (signature.text.length > 10_000 || (signature.html?.length ?? 0) > 50_000) {
      return yield* new MailboxInvalid({
        field: "signature",
        message: "A signature is at most 10,000 characters of text.",
      })
    }
    return signature
  })

const checkThreshold = (threshold: number | null) =>
  Effect.gen(function* () {
    if (threshold === null) return null
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 20)
      return yield* new MailboxInvalid({
        field: "spamThreshold",
        message: "A spam threshold is 1 to 20 points.",
      })
    return Math.round(threshold * 10) / 10
  })

const checkAutoReply = (autoReply: AutoReply | null | undefined) =>
  Effect.gen(function* () {
    if (!autoReply) return autoReply ?? null
    if (autoReply.enabled && (!autoReply.subject.trim() || !autoReply.body.trim())) {
      return yield* new MailboxInvalid({
        field: "autoReply",
        message: "An enabled auto-reply needs a subject and a body.",
      })
    }
    if (autoReply.startsAt !== null && autoReply.endsAt !== null && autoReply.endsAt <= autoReply.startsAt) {
      return yield* new MailboxInvalid({ field: "autoReply", message: "An auto-reply ends after it starts." })
    }
    return autoReply
  })

const checkForwarding = (forwarding: Forwarding | null | undefined, ownAddress: string) =>
  Effect.gen(function* () {
    if (!forwarding) return forwarding ?? null
    const to = [...new Set(forwarding.to.map((a) => a.trim().toLowerCase()))]
    if (forwarding.enabled && to.length === 0) {
      return yield* new MailboxInvalid({
        field: "forwarding",
        message: "Enabled forwarding needs an address.",
      })
    }
    if (to.length > MAX_FORWARD_TO) {
      return yield* new MailboxInvalid({
        field: "forwarding",
        message: `Forward to at most ${MAX_FORWARD_TO} addresses.`,
      })
    }
    const bad = to.find((a) => !EMAIL.test(a))
    if (bad)
      return yield* new MailboxInvalid({ field: "forwarding", message: `${bad} is not an email address.` })
    if (to.includes(ownAddress)) {
      return yield* new MailboxInvalid({ field: "forwarding", message: "A mailbox can't forward to itself." })
    }
    return { ...forwarding, to }
  })

export interface MailboxInput {
  readonly address: string
  readonly kind: MailboxKind
  readonly displayName?: string | null | undefined
  readonly targets?: ReadonlyArray<string> | undefined
  readonly signature?: Signature | null | undefined
  readonly autoReply?: AutoReply | null | undefined
  readonly forwarding?: Forwarding | null | undefined
  /** Spam points at or above which mail goes to spam (1 to 20); null for the default. */
  readonly spamThreshold?: number | null | undefined
}

export const createMailbox = Effect.fn("mailboxes.create")(function* (input: MailboxInput, actor: string) {
  const address = input.address.trim().toLowerCase()
  const at = address.lastIndexOf("@")
  const local = address.slice(0, at)
  const domainName = address.slice(at + 1)
  if (at <= 0 || !LOCAL_PART.test(local) || local.includes("..")) {
    return yield* new MailboxInvalid({
      field: "address",
      message: `${input.address} is not an address Mailyard can host.`,
    })
  }
  const database = yield* Database
  const domain = yield* database.query("mailboxes.domain", (db) =>
    db.select().from(domains).where(eq(domains.name, domainName)).get(),
  )
  if (!domain)
    return yield* new MailboxInvalid({ field: "address", message: `Add ${domainName} as a domain first.` })
  const taken = yield* database.query("mailboxes.byAddress", (db) =>
    db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, address)).get(),
  )
  if (taken) return yield* new MailboxConflict({ message: `${address} already exists.` })
  if (input.kind === "catch_all") {
    const existing = yield* database.query("mailboxes.catchAll", (db) =>
      db
        .select({ address: mailboxes.address })
        .from(mailboxes)
        .where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.kind, "catch_all")))
        .get(),
    )
    if (existing)
      return yield* new MailboxConflict({
        message: `${domainName} already has a catch-all mailbox, ${existing.address}.`,
      })
  }
  const pointsElsewhere = input.kind === "alias" || input.kind === "group"
  if (!pointsElsewhere && input.targets?.length) {
    return yield* new MailboxInvalid({
      field: "targets",
      message: `A ${input.kind} mailbox holds its own mail; only aliases and groups have targets.`,
    })
  }
  const targets = pointsElsewhere ? yield* checkTargets(null, input.kind, input.targets ?? []) : null
  const signature = yield* checkSignature(input.signature)
  const autoReply = yield* checkAutoReply(input.autoReply)
  const forwarding = yield* checkForwarding(input.forwarding, address)
  const spamThreshold = input.spamThreshold === undefined ? null : yield* checkThreshold(input.spamThreshold)
  const id = `mbx_${yield* (yield* Ids).next}`
  const now = Date.now()
  yield* database.query("mailboxes.insert", (db) =>
    db
      .insert(mailboxes)
      .values({
        id,
        domainId: domain.id,
        address,
        displayName: input.displayName?.trim() || null,
        kind: input.kind,
        targets,
        signature,
        autoReply,
        forwarding,
        spamThreshold,
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  )
  yield* recordAudit({
    actor,
    action: "mailbox.created",
    target: id,
    after: { address, kind: input.kind, targets },
  })
  return yield* getMailbox(id)
})

export type MailboxPatch = Omit<MailboxInput, "address" | "kind">

export const updateMailbox = Effect.fn("mailboxes.update")(function* (
  id: string,
  patch: MailboxPatch,
  actor: string,
) {
  const m = yield* findMailbox(id)
  const pointsElsewhere = m.kind === "alias" || m.kind === "group"
  if (patch.targets !== undefined && !pointsElsewhere) {
    return yield* new MailboxInvalid({ field: "targets", message: `A ${m.kind} mailbox has no targets.` })
  }
  const set = {
    ...(patch.displayName !== undefined ? { displayName: patch.displayName?.trim() || null } : {}),
    ...(patch.targets !== undefined ? { targets: yield* checkTargets(id, m.kind, patch.targets) } : {}),
    ...(patch.signature !== undefined ? { signature: yield* checkSignature(patch.signature) } : {}),
    ...(patch.autoReply !== undefined ? { autoReply: yield* checkAutoReply(patch.autoReply) } : {}),
    ...(patch.forwarding !== undefined
      ? { forwarding: yield* checkForwarding(patch.forwarding, m.address) }
      : {}),
    ...(patch.spamThreshold !== undefined
      ? { spamThreshold: yield* checkThreshold(patch.spamThreshold) }
      : {}),
    updatedAt: Date.now(),
  }
  const database = yield* Database
  yield* database.query("mailboxes.update", (db) =>
    db.update(mailboxes).set(set).where(eq(mailboxes.id, id)).run(),
  )
  yield* recordAudit({
    actor,
    action: "mailbox.updated",
    target: id,
    before: {
      displayName: m.displayName,
      targets: m.targets,
      autoReply: m.autoReply,
      forwarding: m.forwarding,
      spamThreshold: m.spamThreshold,
    },
    after: set,
  })
  return yield* getMailbox(id)
})

/** Replaces who may use a mailbox. Only secret keys that aren't revoked can be members. */
export const setMembers = Effect.fn("mailboxes.setMembers")(function* (
  id: string,
  members: ReadonlyArray<{ readonly apiKeyId: string; readonly role: MemberRole }>,
  actor: string,
) {
  const m = yield* findMailbox(id)
  if (!HOLDS_MAIL.has(m.kind)) {
    return yield* new MailboxInvalid({
      field: "members",
      message: "Aliases and groups have no members; give access to the mailboxes they reach.",
    })
  }
  const ids = [...new Set(members.map((x) => x.apiKeyId))]
  if (ids.length !== members.length)
    return yield* new MailboxInvalid({ field: "members", message: "A key is listed twice." })
  const database = yield* Database
  const keys = ids.length
    ? yield* queryIn("mailboxes.memberKeys", ids, (db, chunk) =>
        db
          .select({ id: apiKeys.id, kind: apiKeys.kind })
          .from(apiKeys)
          .where(and(inArray(apiKeys.id, chunk), activeKey()))
          .all(),
      )
    : []
  const usable = new Set(keys.filter((k) => k.kind === "secret").map((k) => k.id))
  const bad = ids.find((k) => !usable.has(k))
  if (bad)
    return yield* new MailboxInvalid({ field: "members", message: `${bad} is not an active secret key.` })
  const before = yield* database.query("mailboxes.membersBefore", (db) =>
    db
      .select({ apiKeyId: mailboxMembers.apiKeyId, role: mailboxMembers.role })
      .from(mailboxMembers)
      .where(eq(mailboxMembers.mailboxId, id))
      .all(),
  )
  yield* database.query("mailboxes.membersReplace", (db) =>
    db.batch([
      db.delete(mailboxMembers).where(eq(mailboxMembers.mailboxId, id)),
      ...members.map((x) =>
        db.insert(mailboxMembers).values({ mailboxId: id, apiKeyId: x.apiKeyId, role: x.role }),
      ),
    ] as unknown as Parameters<typeof db.batch>[0]),
  )
  yield* recordAudit({ actor, action: "mailbox.members", target: id, before, after: members })
  return yield* getMailbox(id)
})

/**
 * Removes an address. A mailbox that holds mail goes only once it's empty or a complete export of it
 * exists, so removing never destroys the only copy; its Durable Object is then erased. Nothing that
 * still delivers to it may be left pointing at it, and a domain keeping unknown mail needs its catch-all.
 */
export const deleteMailbox = Effect.fn("mailboxes.delete")(function* (id: string, actor: string) {
  const m = yield* findMailbox(id)
  const database = yield* Database
  const referrers = yield* database.query("mailboxes.referrers", (db) =>
    db
      .select({ address: mailboxes.address })
      .from(mailboxes)
      .where(sql`exists (select 1 from json_each(${mailboxes.targets}) where json_each.value = ${id})`)
      .all(),
  )
  if (referrers.length > 0) {
    return yield* new MailboxConflict({
      message: `${referrers.map((r) => r.address).join(", ")} still deliver${referrers.length === 1 ? "s" : ""} to ${m.address}; change ${referrers.length === 1 ? "it" : "them"} first.`,
    })
  }
  if (m.kind === "catch_all") {
    const domain = yield* database.query("mailboxes.catchAllDomain", (db) =>
      db
        .select({ catchAll: domains.catchAll, name: domains.name })
        .from(domains)
        .where(eq(domains.id, m.domainId))
        .get(),
    )
    if (domain?.catchAll === "keep") {
      return yield* new MailboxConflict({
        message: `${domain.name} keeps unknown mail in ${m.address}; set its catch-all policy to bounce first.`,
      })
    }
  }
  if (HOLDS_MAIL.has(m.kind)) {
    const store = yield* Mailboxes
    const held = yield* store.count(id)
    if (held > 0) {
      const exported = yield* database.query("mailboxes.completeExport", (db) =>
        db
          .select({ id: mailboxExports.id })
          .from(mailboxExports)
          .where(and(eq(mailboxExports.mailboxId, id), eq(mailboxExports.status, "complete")))
          .get(),
      )
      if (!exported) {
        return yield* new MailboxConflict({
          message: `${m.address} holds ${held} message${held === 1 ? "" : "s"}. Export it first (POST /v1/mailboxes/${id}/exports), then remove it.`,
        })
      }
    }
    yield* store.erase(id)
  }
  yield* database.query("mailboxes.delete", (db) => db.delete(mailboxes).where(eq(mailboxes.id, id)).run())
  yield* recordAudit({ actor, action: "mailbox.deleted", target: id, before: summary(m) })
  return summary(m)
})

export interface Identity {
  readonly address: string
  readonly displayName: string | null
  readonly mailboxId: string
  readonly kind: MailboxKind
  /** Why the key may send as it: every address (admin), membership, or an alias of a mailbox it's a member of. */
  readonly via: "admin" | "member" | "alias"
  /** The signature to start a message from this address with: its own, or, for an alias, its mailbox's. */
  readonly signature: { readonly text: string; readonly html: string | null } | null
}

/**
 * The addresses a key may send as. Root and admin keys may use every address, and any address on a
 * domain that sends. Other keys may use the mailboxes they are owner or member of, and the aliases
 * pointing at those mailboxes.
 */
export const identitiesFor = Effect.fn("mailboxes.identities")(function* (caller: Caller) {
  const database = yield* Database
  const all = yield* database.query("identities.all", (db) =>
    db.select().from(mailboxes).orderBy(asc(mailboxes.address)).all(),
  )
  const byId = new Map(all.map((m) => [m.id, m]))
  const signatureOf = (m: (typeof all)[number]) =>
    m.signature ?? (m.targets ?? []).map((t) => byId.get(t)?.signature).find((x) => x) ?? null
  if (caller.keyId === "root" || caller.scopes.includes("admin")) {
    const sending = yield* database.query("identities.sendingDomains", (db) =>
      db
        .select({ name: domains.name })
        .from(domains)
        .where(eq(domains.sendingEnabled, true))
        .orderBy(asc(domains.name))
        .all(),
    )
    return {
      identities: all.map(
        (m): Identity => ({
          address: m.address,
          displayName: m.displayName,
          mailboxId: m.id,
          kind: m.kind,
          via: "admin",
          signature: signatureOf(m),
        }),
      ),
      anyAddressOn: sending.map((d) => d.name),
    }
  }
  const rows = yield* database.query("identities.member", (db) =>
    db
      .select({ mailboxId: mailboxMembers.mailboxId, role: mailboxMembers.role })
      .from(mailboxMembers)
      .where(eq(mailboxMembers.apiKeyId, caller.keyId))
      .all(),
  )
  const sendable = new Set(rows.filter((r) => r.role !== "viewer").map((r) => r.mailboxId))
  const identities: Array<Identity> = []
  for (const m of all) {
    if (sendable.has(m.id))
      identities.push({
        address: m.address,
        displayName: m.displayName,
        mailboxId: m.id,
        kind: m.kind,
        via: "member",
        signature: signatureOf(m),
      })
    else if (m.kind === "alias" && m.targets?.some((t) => sendable.has(t))) {
      identities.push({
        address: m.address,
        displayName: m.displayName,
        mailboxId: m.id,
        kind: m.kind,
        via: "alias",
        signature: signatureOf(m),
      })
    }
  }
  return { identities, anyAddressOn: [] as Array<string> }
})

/** Whether a key may send as `address`; the Mail API's send path checks this (HAL-3152). */
export const canSendAs = Effect.fn("mailboxes.canSendAs")(function* (caller: Caller, address: string) {
  const wanted = address.trim().toLowerCase()
  const { identities, anyAddressOn } = yield* identitiesFor(caller)
  return (
    identities.some((i) => i.address === wanted) ||
    anyAddressOn.includes(wanted.slice(wanted.lastIndexOf("@") + 1))
  )
})

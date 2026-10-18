import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  agents,
  apiKeys,
  approvals,
  contacts,
  keyLimits,
  keySendDaily,
  mailboxes,
  mailboxMembers,
} from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database, queryIn } from "../services/Database.ts"
import { clearAlert, raiseAlert } from "./alerts.ts"
import { type Caller, createKey, revokeKey, type Scope } from "./apiKeys.ts"
import { recordAudit } from "./audit.ts"
import { createMailbox, type MailboxInput } from "./mailboxes.ts"
import { checkUrl, createEndpoint, emitSafely } from "./webhooks.ts"

/**
 * Agents and their guardrails (HAL-3460). An agent is a mailbox plus a `purpose: mcp` key that is a
 * member of it. Any key can carry limits: a daily cap, who it may write to, and whether every send
 * waits for a person's yes. The limits are checked on every path a key can send through: the MCP
 * send tools, `/v1/send`, a mailbox draft's send, and test sends. Campaigns are refused outright to
 * a limited key, since their audience can't be checked recipient by recipient.
 */

export const Limits = Schema.Struct({
  /** Messages a UTC day; null for no cap. */
  sendsPerDay: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
  recipients: Schema.Literals(["any", "contacts", "domains"]),
  /** With `recipients: "domains"`: the domains it may write to (subdomains included). */
  allowDomains: Schema.Array(Schema.String.check(Schema.isMaxLength(253))).check(Schema.isMaxLength(100)),
  requireApproval: Schema.Boolean,
})
export type Limits = typeof Limits.Type

export class AgentLimited extends Schema.TaggedError<AgentLimited>()("AgentLimited", {
  /** `agent_limit`: over the daily cap, or a kind of send a limited key can't make. `recipient_not_allowed`: outside the allow-list. */
  reason: Schema.Literals(["agent_limit", "recipient_not_allowed"]),
  message: Schema.String,
  limit: Schema.optionalKey(Schema.Number),
  sentToday: Schema.optionalKey(Schema.Number),
  resetsAt: Schema.optionalKey(Schema.Number),
  notAllowed: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()("AgentNotFound", {
  id: Schema.String,
}) {}
export class AgentInvalid extends Schema.TaggedError<AgentInvalid>()("AgentInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

const DAY = 86_400_000
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10)
const nextMidnight = (now: number) => (Math.floor(now / DAY) + 1) * DAY
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase()

const normalizeLimits = (limits: Limits): Limits => ({
  ...limits,
  allowDomains: [
    ...new Set(limits.allowDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)),
  ],
})

/** A key's limits, or null when it has none. People and the admin key have none. */
export const limitsOf = Effect.fn("agents.limitsOf")(function* (keyId: string) {
  const database = yield* Database
  const row = yield* database.query("keyLimits.get", (db) =>
    db.select().from(keyLimits).where(eq(keyLimits.keyId, keyId)).get(),
  )
  if (!row) return null
  return {
    sendsPerDay: row.sendsPerDay,
    recipients: row.recipients,
    allowDomains: row.allowDomains,
    requireApproval: row.requireApproval,
  } satisfies Limits
})

/** Sets (or, with null, clears) a key's limits. */
export const putLimits = Effect.fn("agents.putLimits")(function* (
  keyId: string,
  limits: Limits | null,
  actor: string,
) {
  const database = yield* Database
  const key = yield* database.query("keyLimits.key", (db) =>
    db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, keyId)).get(),
  )
  if (!key) return yield* new AgentNotFound({ id: keyId })
  if (limits === null) {
    yield* database.query("keyLimits.clear", (db) =>
      db.delete(keyLimits).where(eq(keyLimits.keyId, keyId)).run(),
    )
  } else {
    const value = normalizeLimits(limits)
    if (value.recipients === "domains" && value.allowDomains.length === 0)
      return yield* new AgentInvalid({
        field: "limits.allowDomains",
        message: "List the domains it may write to.",
      })
    const row = { keyId, ...value, updatedAt: Date.now() }
    yield* database.query("keyLimits.put", (db) =>
      db
        .insert(keyLimits)
        .values(row)
        .onConflictDoUpdate({ target: keyLimits.keyId, set: { ...value, updatedAt: row.updatedAt } })
        .run(),
    )
  }
  yield* recordAudit({ actor, action: "key.limits", target: keyId, after: limits })
  return yield* limitsOf(keyId)
})

/** Messages a key sent today (UTC). */
export const sentToday = Effect.fn("agents.sentToday")(function* (keyId: string, now = Date.now()) {
  const database = yield* Database
  const row = yield* database.query("keySendDaily.get", (db) =>
    db
      .select({ sends: keySendDaily.sends })
      .from(keySendDaily)
      .where(and(eq(keySendDaily.keyId, keyId), eq(keySendDaily.day, dayOf(now))))
      .get(),
  )
  return row?.sends ?? 0
})

/** Counts sends against today without enforcing the cap: an approved send, which a person allowed. */
export const countSends = Effect.fn("agents.countSends")(function* (
  keyId: string,
  n: number,
  now = Date.now(),
) {
  const database = yield* Database
  yield* database.query("keySendDaily.count", (db) =>
    db
      .insert(keySendDaily)
      .values({ keyId, day: dayOf(now), sends: n })
      .onConflictDoUpdate({
        target: [keySendDaily.keyId, keySendDaily.day],
        set: { sends: sql`${keySendDaily.sends} + ${n}` },
      })
      .run(),
  )
})

/**
 * Takes `n` sends from today's allowance in one statement, or none if that would pass the cap, so
 * two sends racing can't both slip under it.
 */
const takeAllowance = Effect.fn("agents.takeAllowance")(function* (
  keyId: string,
  n: number,
  cap: number,
  now = Date.now(),
) {
  const database = yield* Database
  if (n > cap) return false
  const row = yield* database.query("keySendDaily.take", (db) =>
    db
      .insert(keySendDaily)
      .values({ keyId, day: dayOf(now), sends: n })
      .onConflictDoUpdate({
        target: [keySendDaily.keyId, keySendDaily.day],
        set: { sends: sql`${keySendDaily.sends} + ${n}` },
        setWhere: sql`${keySendDaily.sends} + ${n} <= ${cap}`,
      })
      .returning({ sends: keySendDaily.sends })
      .get(),
  )
  return row !== undefined
})

/** Whether an address is inside a domain allow-list (the domain itself or any subdomain). */
const inDomains = (address: string, allow: ReadonlyArray<string>) => {
  const domain = domainOf(address)
  return allow.some((d) => domain === d || domain.endsWith(`.${d}`))
}

/**
 * The guard every send path runs for the calling key, before anything goes out:
 * - recipients outside the allow-list → `recipient_not_allowed`;
 * - `requireApproval` → `"hold"` where the path can hold the send, else `agent_limit`;
 * - over the daily cap → `agent_limit`, with when it resets.
 * Returns `"go"` (the allowance already taken) or `"hold"`.
 */
export const checkSend = Effect.fn("agents.checkSend")(function* (
  caller: Caller,
  input: {
    readonly recipients: ReadonlyArray<string>
    /** Messages this send makes (one per recipient for transactional mail, one for a draft). */
    readonly messages: number
    /** Whether this path can hold the send for approval; tests and campaigns can't. */
    readonly holdable: boolean
    /** What's being sent, for the refusal's wording. */
    readonly what: string
  },
  now = Date.now(),
) {
  if (caller.member || caller.keyId === "root") return "go" as const
  const limits = yield* limitsOf(caller.keyId)
  if (!limits) return "go" as const
  const recipients = [...new Set(input.recipients.map((r) => r.trim().toLowerCase()))]
  if (limits.recipients === "domains") {
    const notAllowed = recipients.filter((r) => !inDomains(r, limits.allowDomains))
    if (notAllowed.length > 0)
      return yield* new AgentLimited({
        reason: "recipient_not_allowed",
        message: `This key may only write to ${limits.allowDomains.join(", ")}.`,
        notAllowed,
      })
  }
  if (limits.recipients === "contacts" && recipients.length > 0) {
    const known = new Set(
      (yield* queryIn("agents.knownContacts", recipients, (db, chunk) =>
        db.select({ email: contacts.email }).from(contacts).where(inArray(contacts.email, chunk)).all(),
      )).map((c) => c.email),
    )
    const notAllowed = recipients.filter((r) => !known.has(r))
    if (notAllowed.length > 0)
      return yield* new AgentLimited({
        reason: "recipient_not_allowed",
        message: "This key may only write to people already in contacts.",
        notAllowed,
      })
  }
  if (limits.requireApproval) {
    if (input.holdable) return "hold" as const
    return yield* new AgentLimited({
      reason: "agent_limit",
      message: `This key's sends wait for approval, and ${input.what} can't be held. Ask a person to send it.`,
    })
  }
  if (limits.sendsPerDay !== null) {
    const ok = yield* takeAllowance(caller.keyId, input.messages, limits.sendsPerDay, now)
    if (!ok)
      return yield* new AgentLimited({
        reason: "agent_limit",
        message: `This key may send ${limits.sendsPerDay} messages a day, and has used them. It resets at midnight UTC.`,
        limit: limits.sendsPerDay,
        sentToday: yield* sentToday(caller.keyId, now),
        resetsAt: nextMidnight(now),
      })
  }
  return "go" as const
})

/** A campaign reaches a segment that can't be checked person by person: limited keys can't send one. */
export const refuseCampaignForLimitedKey = Effect.fn("agents.refuseCampaign")(function* (caller: Caller) {
  if (caller.member || caller.keyId === "root") return
  if (yield* limitsOf(caller.keyId))
    return yield* new AgentLimited({
      reason: "agent_limit",
      message: "Keys with send limits can't send campaigns; a person schedules those.",
    })
})

// ---------------------------------------------------------------------------------------------
// Holding a send for approval
// ---------------------------------------------------------------------------------------------

/** Raises (or brings up to date) the one open "sends waiting" alert. */
const raisePending = Effect.fn("agents.raisePending")(function* () {
  const database = yield* Database
  const n = yield* database.query("approvals.pendingCount", (db) =>
    db.select({ n: sql<number>`count(*)` }).from(approvals).where(eq(approvals.status, "pending")).get(),
  )
  const count = n?.n ?? 0
  yield* raiseAlert({
    key: "approval_pending",
    kind: "approval_pending",
    severity: "warning",
    title: count === 1 ? "A send is waiting for approval" : `${count} sends are waiting for approval`,
    detail: "An agent's key needs a person's yes before it sends. Approve or reject them in Approvals.",
    count,
  })
})

/** Holds a send: the approval row, the alert, and the `approval.pending` webhook. */
export const holdSend = Effect.fn("agents.holdSend")(function* (
  caller: Caller,
  input: {
    readonly kind: "transactional" | "draft"
    readonly mailboxId?: string | null
    readonly draftId?: string | null
    readonly request: Record<string, unknown>
    readonly recipients: ReadonlyArray<string>
    readonly subject: string
    readonly from?: string | null
  },
  now = Date.now(),
) {
  const database = yield* Database
  const id = `apv_${yield* (yield* Ids).next}`
  const row = {
    id,
    keyId: caller.keyId,
    kind: input.kind,
    mailboxId: input.mailboxId ?? null,
    draftId: input.draftId ?? null,
    request: input.request,
    recipients: [...input.recipients],
    subject: input.subject.slice(0, 998),
    from: input.from ?? null,
    status: "pending" as const,
    createdAt: now,
  }
  yield* database.query("approvals.hold", (db) => db.insert(approvals).values(row).run())
  yield* raisePending().pipe(
    Effect.catchCause((cause) => Effect.logWarning("approval alert not raised", cause)),
  )
  yield* emitSafely("approval.pending", {
    approvalId: id,
    keyId: caller.keyId,
    kind: input.kind,
    recipients: row.recipients,
    subject: row.subject,
    mailboxId: row.mailboxId,
  })
  return { id, status: "pending" as const }
})

/** Clears the alert once nothing waits. */
export const settlePending = Effect.fn("agents.settlePending")(function* () {
  const database = yield* Database
  const n = yield* database.query("approvals.pendingCount", (db) =>
    db.select({ n: sql<number>`count(*)` }).from(approvals).where(eq(approvals.status, "pending")).get(),
  )
  if ((n?.n ?? 0) > 0) return yield* raisePending()
  yield* clearAlert("approval_pending", "system").pipe(Effect.ignore)
})

// ---------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------

const DEFAULT_AGENT_SCOPES: ReadonlyArray<Scope> = ["read", "send"]

/** The `claude mcp add` line for a key, with the key in it (shown once, at creation). */
export const mcpCommand = (origin: string, key: string) =>
  `claude mcp add --transport http mailyard ${origin.replace(/\/$/, "")}/mcp --header "Authorization: Bearer ${key}"`

const agentView = Effect.fn("agents.view")(function* (row: typeof agents.$inferSelect, now = Date.now()) {
  const database = yield* Database
  const key = yield* database.query("agents.key", (db) =>
    db.select().from(apiKeys).where(eq(apiKeys.id, row.keyId)).get(),
  )
  const mailbox = yield* database.query("agents.mailbox", (db) =>
    db
      .select({ id: mailboxes.id, address: mailboxes.address })
      .from(mailboxes)
      .where(eq(mailboxes.id, row.mailboxId))
      .get(),
  )
  const pending = yield* database.query("agents.pending", (db) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(approvals)
      .where(and(eq(approvals.keyId, row.keyId), eq(approvals.status, "pending")))
      .get(),
  )
  return {
    id: row.id,
    name: row.name,
    mailbox: mailbox ?? { id: row.mailboxId, address: null },
    key: key
      ? {
          id: key.id,
          prefix: key.prefix,
          scopes: key.scopes as ReadonlyArray<Scope>,
          lastUsedAt: key.lastUsedAt,
          revoked: key.revokedAt !== null && key.revokedAt <= now,
        }
      : null,
    limits: yield* limitsOf(row.keyId),
    sentToday: yield* sentToday(row.keyId, now),
    pendingApprovals: pending?.n ?? 0,
    createdAt: row.createdAt,
    removedAt: row.removedAt,
  }
})

const findAgent = Effect.fn("agents.find")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("agents.get", (db) =>
    db.select().from(agents).where(eq(agents.id, id)).get(),
  )
  if (!row) return yield* new AgentNotFound({ id })
  return row
})

/**
 * `POST /v1/agents`: the mailbox, an MCP key that's a member of it, and its limits, in one go.
 * The key is returned once, with the `claude mcp add` line that uses it.
 */
export const createAgent = Effect.fn("agents.create")(function* (
  caller: Caller,
  input: {
    readonly name: string
    readonly address: string
    readonly displayName?: string | undefined
    readonly scopes?: ReadonlyArray<Scope> | undefined
    readonly limits?: Limits | undefined
    /** Where to POST `mail.received` for the agent's mailbox: the agent-wake webhook preset (HAL-3461). */
    readonly wake?: { readonly url: string } | undefined
  },
  origin: string,
) {
  const name = input.name.trim()
  if (!name) return yield* new AgentInvalid({ field: "name", message: "Name the agent." })
  const scopes = input.scopes ?? DEFAULT_AGENT_SCOPES
  if (scopes.includes("admin"))
    return yield* new AgentInvalid({ field: "scopes", message: "An agent's key can't have the admin scope." })
  if (input.limits?.recipients === "domains" && normalizeLimits(input.limits).allowDomains.length === 0)
    return yield* new AgentInvalid({
      field: "limits.allowDomains",
      message: "List the domains it may write to.",
    })
  // Check the wake URL before making anything, so a bad one leaves nothing half-made.
  if (input.wake) {
    const problem = checkUrl(input.wake.url)
    if (problem) return yield* new AgentInvalid({ field: "wake.url", message: problem })
  }
  const mailbox = yield* createMailbox(
    { address: input.address, kind: "user", displayName: input.displayName ?? name } as MailboxInput,
    caller.keyId,
  )
  const { key, record } = yield* createKey({
    name: `${name} (agent)`,
    kind: "secret",
    scopes,
    purpose: "mcp",
    createdBy: caller.keyId,
  })
  const database = yield* Database
  yield* database.query("agents.membership", (db) =>
    db.insert(mailboxMembers).values({ mailboxId: mailbox.id, apiKeyId: record.id, role: "owner" }).run(),
  )
  if (input.limits) yield* putLimits(record.id, input.limits, caller.keyId)
  const id = `agt_${yield* (yield* Ids).next}`
  const now = Date.now()
  const row = { id, name, keyId: record.id, mailboxId: mailbox.id, createdBy: caller.keyId, createdAt: now }
  yield* database.query("agents.create", (db) => db.insert(agents).values(row).run())
  yield* recordAudit({
    actor: caller.keyId,
    action: "agent.create",
    target: id,
    after: { name, mailbox: mailbox.address, scopes, limits: input.limits ?? null },
  })
  const wake = input.wake
    ? yield* createEndpoint({
        url: input.wake.url,
        description: `Wakes ${name} when mail reaches ${mailbox.address}`,
        preset: { kind: "agent-wake", mailboxId: mailbox.id },
      }).pipe(
        Effect.map((w) => ({ endpointId: w.endpoint.id, secret: w.secret })),
        Effect.catchTag("WebhookInvalid", (e) =>
          Effect.fail(new AgentInvalid({ field: "wake.url", message: e.message })),
        ),
      )
    : null
  return {
    agent: yield* agentView({ ...row, removedAt: null }),
    key,
    mcp: { url: `${origin.replace(/\/$/, "")}/mcp`, command: mcpCommand(origin, key) },
    wake,
  }
})

export const listAgents = Effect.fn("agents.list")(function* () {
  const database = yield* Database
  const rows = yield* database.query("agents.list", (db) =>
    db.select().from(agents).where(isNull(agents.removedAt)).orderBy(asc(agents.name)).limit(500).all(),
  )
  const out = []
  for (const row of rows) out.push(yield* agentView(row))
  return { agents: out }
})

export const getAgent = Effect.fn("agents.get")(function* (id: string) {
  return yield* agentView(yield* findAgent(id))
})

/** `PATCH /v1/agents/{id}`: its name and limits. */
export const updateAgent = Effect.fn("agents.update")(function* (
  caller: Caller,
  id: string,
  input: { readonly name?: string | undefined; readonly limits?: Limits | null | undefined },
) {
  const row = yield* findAgent(id)
  const database = yield* Database
  if (input.name !== undefined) {
    if (!input.name.trim()) return yield* new AgentInvalid({ field: "name", message: "Name the agent." })
    yield* database.query("agents.rename", (db) =>
      db
        .update(agents)
        .set({ name: input.name?.trim() ?? row.name })
        .where(eq(agents.id, id))
        .run(),
    )
  }
  if (input.limits !== undefined) yield* putLimits(row.keyId, input.limits, caller.keyId)
  yield* recordAudit({ actor: caller.keyId, action: "agent.update", target: id, after: input })
  return yield* getAgent(id)
})

/**
 * `DELETE /v1/agents/{id}`: revokes its key (so its MCP connection stops at once), and keeps the
 * mailbox and everything in it; removing the mailbox is its own step, with its export guard.
 */
export const removeAgent = Effect.fn("agents.remove")(function* (caller: Caller, id: string) {
  const row = yield* findAgent(id)
  yield* revokeKey(row.keyId)
  const database = yield* Database
  const now = Date.now()
  yield* database.query("agents.remove", (db) =>
    db.update(agents).set({ removedAt: now }).where(eq(agents.id, id)).run(),
  )
  // Anything it still had waiting for approval can't be sent by a revoked key.
  yield* database.query("agents.rejectPending", (db) =>
    db
      .update(approvals)
      .set({ status: "rejected", decidedAt: now, decidedBy: caller.keyId, reason: "The agent was removed." })
      .where(and(eq(approvals.keyId, row.keyId), eq(approvals.status, "pending")))
      .run(),
  )
  yield* settlePending()
  yield* recordAudit({ actor: caller.keyId, action: "agent.remove", target: id })
  return yield* getAgent(id)
})

/** `GET /v1/approvals`: held sends, newest first. */
export const listApprovals = Effect.fn("approvals.list")(function* (
  status?: "pending" | "approved" | "rejected" | "failed" | undefined,
) {
  const database = yield* Database
  const rows = yield* database.query("approvals.list", (db) =>
    db
      .select()
      .from(approvals)
      .where(status ? eq(approvals.status, status) : undefined)
      .orderBy(desc(approvals.createdAt))
      .limit(200)
      .all(),
  )
  return rows
})

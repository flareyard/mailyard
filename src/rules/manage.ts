import { and, asc, eq, inArray, max } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { apiKeys, mailboxes, mailboxRules, mailboxSenders, webhookEndpoints } from "../db/schema.ts"
import { isRevoked } from "../domain/apiKeys.ts"
import { recordAudit } from "../domain/audit.ts"
import { Ids } from "../kit/index.ts"
import { callMailbox } from "../mail/rpc.ts"
import type { Folder, StoredMessage } from "../mailbox/types.ts"
import { Database, queryIn } from "../services/Database.ts"
import { type Action, type Condition, evaluate, type Rule } from "./engine.ts"
import { authScore } from "./spam.ts"

export class RuleInvalid extends Schema.TaggedError<RuleInvalid>()("RuleInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
export class RuleNotFound extends Schema.TaggedError<RuleNotFound>()("RuleNotFound", { id: Schema.String }) {}

export const MAX_RULES = 100
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SENDER_VALUE = /^(?:[^\s@]+@[^\s@]+\.[^\s@]+|@[a-z0-9.-]+\.[a-z]{2,})$/

type RuleRow = typeof mailboxRules.$inferSelect

const describe = (r: RuleRow) => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  match: r.match,
  conditions: r.conditions,
  actions: r.actions,
  stop: r.stop,
  position: r.position,
  matchCount: r.matchCount,
  lastMatchedAt: r.lastMatchedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
})

export type RuleSummary = ReturnType<typeof describe>

/** Labels must exist in the mailbox, webhooks must exist, forwards must go somewhere real and elsewhere. */
const checkActions = Effect.fn("rules.checkActions")(function* (
  mailboxId: string,
  actions: ReadonlyArray<Action>,
) {
  if (actions.length === 0)
    return yield* new RuleInvalid({ field: "actions", message: "A rule needs at least one action." })
  const database = yield* Database
  const labelIds = actions.flatMap((a) => (a.type === "label" ? [a.labelId] : []))
  if (labelIds.length > 0) {
    const labels = yield* callMailbox(mailboxId, (s) => s.labels())
    const missing = labelIds.filter((id) => !labels.some((l) => l.id === id))
    if (missing.length)
      return yield* new RuleInvalid({
        field: "actions",
        message: `No label ${missing.join(", ")} in this mailbox.`,
      })
  }
  const endpointIds = actions.flatMap((a) => (a.type === "webhook" ? [a.endpointId] : []))
  if (endpointIds.length > 0) {
    const found = yield* queryIn("rules.endpoints", endpointIds, (db, chunk) =>
      db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(inArray(webhookEndpoints.id, chunk))
        .all(),
    )
    const missing = endpointIds.filter((id) => !found.some((f) => f.id === id))
    if (missing.length)
      return yield* new RuleInvalid({
        field: "actions",
        message: `No webhook endpoint ${missing.join(", ")}.`,
      })
  }
  const assignees = actions.flatMap((a) => (a.type === "assign" ? [a.assignee] : []))
  for (const assignee of assignees) {
    if (assignee === "root") continue
    const key = yield* database.query("rules.assignee", (db) =>
      db
        .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, assignee))
        .get(),
    )
    if (!key || isRevoked(key.revokedAt))
      return yield* new RuleInvalid({
        field: "actions",
        message: `No active API key ${assignee} to assign to.`,
      })
  }
  const mailbox = yield* database.query("rules.mailboxAddress", (db) =>
    db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.id, mailboxId)).get(),
  )
  for (const a of actions) {
    if (a.type !== "forward") continue
    const bad = a.to.find((t) => !EMAIL.test(t.trim()))
    if (bad) return yield* new RuleInvalid({ field: "actions", message: `${bad} is not an email address.` })
    if (a.to.some((t) => t.trim().toLowerCase() === mailbox?.address)) {
      return yield* new RuleInvalid({
        field: "actions",
        message: "A rule can't forward a mailbox to itself.",
      })
    }
  }
  const moves = actions.filter((a) => a.type === "archive" || a.type === "trash" || a.type === "spam")
  if (moves.length > 1)
    return yield* new RuleInvalid({
      field: "actions",
      message: "A rule moves a message to one folder at most.",
    })
  return actions.map((a) =>
    a.type === "forward" ? { ...a, to: a.to.map((t) => t.trim().toLowerCase()) } : a,
  )
})

const findRule = (mailboxId: string, ruleId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("rules.find", (db) =>
      db
        .select()
        .from(mailboxRules)
        .where(and(eq(mailboxRules.id, ruleId), eq(mailboxRules.mailboxId, mailboxId)))
        .get(),
    )
    if (!row) return yield* new RuleNotFound({ id: ruleId })
    return row
  })

export const listRules = Effect.fn("rules.list")(function* (mailboxId: string) {
  const database = yield* Database
  const rows = yield* database.query("rules.list", (db) =>
    db
      .select()
      .from(mailboxRules)
      .where(eq(mailboxRules.mailboxId, mailboxId))
      .orderBy(asc(mailboxRules.position), asc(mailboxRules.createdAt))
      .all(),
  )
  return rows.map(describe)
})

export interface RuleInput {
  readonly name: string
  readonly enabled?: boolean | undefined
  readonly match?: "all" | "any" | undefined
  readonly conditions: ReadonlyArray<Condition>
  readonly actions: ReadonlyArray<Action>
  readonly stop?: boolean | undefined
}

export const createRule = Effect.fn("rules.create")(function* (
  mailboxId: string,
  input: RuleInput,
  actor: string,
) {
  const name = input.name.trim()
  if (!name || name.length > 200)
    return yield* new RuleInvalid({ field: "name", message: "A rule's name is 1 to 200 characters." })
  if (input.conditions.length > 20)
    return yield* new RuleInvalid({ field: "conditions", message: "A rule has at most 20 conditions." })
  const actions = yield* checkActions(mailboxId, input.actions)
  const database = yield* Database
  const existing = yield* database.query("rules.count", (db) =>
    db
      .select({ last: max(mailboxRules.position) })
      .from(mailboxRules)
      .where(eq(mailboxRules.mailboxId, mailboxId))
      .get(),
  )
  const count = (yield* listRules(mailboxId)).length
  if (count >= MAX_RULES)
    return yield* new RuleInvalid({ field: "rules", message: `A mailbox has at most ${MAX_RULES} rules.` })
  const id = `rul_${yield* (yield* Ids).next}`
  const now = Date.now()
  yield* database.query("rules.insert", (db) =>
    db
      .insert(mailboxRules)
      .values({
        id,
        mailboxId,
        position: (existing?.last ?? -1) + 1,
        name,
        enabled: input.enabled ?? true,
        match: input.match ?? "all",
        conditions: input.conditions,
        actions,
        stop: input.stop ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  )
  yield* recordAudit({
    actor,
    action: "rule.created",
    target: id,
    after: { mailboxId, name, conditions: input.conditions, actions },
  })
  return describe(yield* findRule(mailboxId, id))
})

export const updateRule = Effect.fn("rules.update")(function* (
  mailboxId: string,
  ruleId: string,
  patch: Partial<RuleInput>,
  actor: string,
) {
  const before = yield* findRule(mailboxId, ruleId)
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 200)) {
    return yield* new RuleInvalid({ field: "name", message: "A rule's name is 1 to 200 characters." })
  }
  if (patch.conditions && patch.conditions.length > 20)
    return yield* new RuleInvalid({ field: "conditions", message: "A rule has at most 20 conditions." })
  const set = {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.match !== undefined ? { match: patch.match } : {}),
    ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
    ...(patch.actions !== undefined ? { actions: yield* checkActions(mailboxId, patch.actions) } : {}),
    ...(patch.stop !== undefined ? { stop: patch.stop } : {}),
    updatedAt: Date.now(),
  }
  const database = yield* Database
  yield* database.query("rules.update", (db) =>
    db.update(mailboxRules).set(set).where(eq(mailboxRules.id, ruleId)).run(),
  )
  yield* recordAudit({ actor, action: "rule.updated", target: ruleId, before: describe(before), after: set })
  return describe(yield* findRule(mailboxId, ruleId))
})

export const deleteRule = Effect.fn("rules.delete")(function* (
  mailboxId: string,
  ruleId: string,
  actor: string,
) {
  const before = yield* findRule(mailboxId, ruleId)
  const database = yield* Database
  yield* database.query("rules.delete", (db) =>
    db.delete(mailboxRules).where(eq(mailboxRules.id, ruleId)).run(),
  )
  yield* recordAudit({ actor, action: "rule.deleted", target: ruleId, before: describe(before) })
  return { deleted: ruleId }
})

/** Puts the rules in the given order. The list must name every rule of the mailbox exactly once. */
export const reorderRules = Effect.fn("rules.reorder")(function* (
  mailboxId: string,
  ruleIds: ReadonlyArray<string>,
  actor: string,
) {
  const current = yield* listRules(mailboxId)
  const ids = new Set(current.map((r) => r.id))
  if (
    ruleIds.length !== ids.size ||
    new Set(ruleIds).size !== ruleIds.length ||
    ruleIds.some((id) => !ids.has(id))
  ) {
    return yield* new RuleInvalid({
      field: "ruleIds",
      message: "List every rule of this mailbox exactly once.",
    })
  }
  const database = yield* Database
  yield* database.query("rules.reorder", (db) =>
    db.batch(
      ruleIds.map((id, position) =>
        db.update(mailboxRules).set({ position, updatedAt: Date.now() }).where(eq(mailboxRules.id, id)),
      ) as unknown as Parameters<typeof db.batch>[0],
    ),
  )
  yield* recordAudit({
    actor,
    action: "rule.reordered",
    target: mailboxId,
    before: current.map((r) => r.id),
    after: ruleIds,
  })
  return yield* listRules(mailboxId)
})

/** Runs one rule over mail already in the mailbox, a page at a time; never sends anything. */
export const applyRule = Effect.fn("rules.apply")(function* (
  mailboxId: string,
  ruleId: string,
  options: {
    readonly folder?: Folder | undefined
    readonly cursor?: string | undefined
    readonly limit?: number | undefined
  },
  actor: string,
) {
  const row = yield* findRule(mailboxId, ruleId)
  const rule: Rule = { ...describe(row), enabled: true }
  const result = yield* callMailbox(mailboxId, (s) =>
    s.applyRule(rule, {
      folder: options.folder ?? null,
      cursor: options.cursor ?? null,
      limit: options.limit ?? 200,
    }),
  )
  yield* recordAudit({
    actor,
    action: "rule.applied",
    target: ruleId,
    after: { mailboxId, examined: result.examined, matched: result.matched, changed: result.changed },
  })
  return result
})

/** Which rules would match a message already in the mailbox, and what they'd do: "why did this happen?". */
export const testRules = Effect.fn("rules.test")(function* (
  mailboxId: string,
  message: StoredMessage,
  bodyText: string,
) {
  const rules: Array<Rule> = (yield* listRules(mailboxId)).map((r) => ({ ...r }))
  const outcome = evaluate(rules, {
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    listId: message.listId,
    tag: message.tag,
    body: bodyText,
    hasAttachment: message.attachments.some((a) => !a.related),
    automated: message.automated,
  })
  const fromDomain = message.from?.address.slice(message.from.address.lastIndexOf("@") + 1) ?? null
  return {
    matched: rules.filter((r) => outcome.matched.includes(r.id)).map((r) => ({ id: r.id, name: r.name })),
    outcome,
    authScore: authScore(message.auth, { fromDomain }),
    filedWith: {
      folder: message.folder,
      spamScore: message.spamScore,
      spamReasons: message.spamReasons,
      rulesMatched: message.rulesMatched,
    },
  }
})

export const listSenders = Effect.fn("rules.senders")(function* (
  mailboxId: string,
  list?: "allow" | "block" | undefined,
) {
  const database = yield* Database
  return yield* database.query("rules.sendersList", (db) =>
    db
      .select({
        value: mailboxSenders.value,
        list: mailboxSenders.list,
        source: mailboxSenders.source,
        createdAt: mailboxSenders.createdAt,
      })
      .from(mailboxSenders)
      .where(and(eq(mailboxSenders.mailboxId, mailboxId), list ? eq(mailboxSenders.list, list) : undefined))
      .orderBy(asc(mailboxSenders.value))
      .all(),
  )
})

/** Adds or moves a sender (an address, or `@domain`) to the allow or block list. */
export const putSender = Effect.fn("rules.putSender")(function* (
  mailboxId: string,
  value: string,
  list: "allow" | "block",
  source: "user" | "not_spam" | "spam",
) {
  const normalized = value.trim().toLowerCase()
  if (!SENDER_VALUE.test(normalized)) {
    return yield* new RuleInvalid({ field: "value", message: `${value} is neither an address nor @domain.` })
  }
  const database = yield* Database
  yield* database.query("rules.putSender", (db) =>
    db
      .insert(mailboxSenders)
      .values({ mailboxId, value: normalized, list, source })
      .onConflictDoUpdate({ target: [mailboxSenders.mailboxId, mailboxSenders.value], set: { list, source } })
      .run(),
  )
  return { value: normalized, list, source }
})

export const removeSender = Effect.fn("rules.removeSender")(function* (mailboxId: string, value: string) {
  const database = yield* Database
  yield* database.query("rules.removeSender", (db) =>
    db
      .delete(mailboxSenders)
      .where(
        and(eq(mailboxSenders.mailboxId, mailboxId), eq(mailboxSenders.value, value.trim().toLowerCase())),
      )
      .run(),
  )
  return { removed: value.trim().toLowerCase() }
})

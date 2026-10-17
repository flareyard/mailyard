import * as Schema from "effect/Schema"
import type { Folder } from "../mailbox/types.ts"

/**
 * Inbox rules: an ordered list per mailbox, each a set of conditions and the actions to take when they
 * hold. Pure, so every case is a fixture test (test/rules/engine.test.ts). Text matching is
 * case-insensitive and literal: no regular expressions, so a rule can't be made to run for ever.
 */

export const TextField = Schema.Literals([
  "from",
  "to",
  "cc",
  "recipients",
  "subject",
  "listId",
  "tag",
  "body",
])
export type TextField = typeof TextField.Type

export const TextOp = Schema.Literals(["contains", "notContains", "equals", "startsWith", "endsWith"])
export type TextOp = typeof TextOp.Type

export const Condition = Schema.Union([
  Schema.Struct({
    field: TextField,
    op: TextOp,
    value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  Schema.Struct({ field: Schema.Literal("hasAttachment"), value: Schema.Boolean }),
  Schema.Struct({ field: Schema.Literal("automated"), value: Schema.Boolean }),
])
export type Condition = typeof Condition.Type

export const Action = Schema.Union([
  Schema.Struct({ type: Schema.Literal("label"), labelId: Schema.String }),
  Schema.Struct({ type: Schema.Literals(["archive", "trash", "spam", "markRead", "star", "skipSpamCheck"]) }),
  Schema.Struct({
    type: Schema.Literal("forward"),
    to: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  }),
  Schema.Struct({
    type: Schema.Literal("autoReply"),
    subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(998)),
    body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  }),
  Schema.Struct({ type: Schema.Literal("webhook"), endpointId: Schema.String }),
])
export type Action = typeof Action.Type

export interface Rule {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  /** `all`: every condition holds. `any`: at least one does. No conditions: matches everything. */
  readonly match: "all" | "any"
  readonly conditions: ReadonlyArray<Condition>
  readonly actions: ReadonlyArray<Action>
  /** Later rules don't run once this one matched. */
  readonly stop: boolean
}

export interface RuleInput {
  readonly from: { readonly name: string | null; readonly address: string } | null
  readonly to: ReadonlyArray<{ readonly name: string | null; readonly address: string }>
  readonly cc: ReadonlyArray<{ readonly name: string | null; readonly address: string }>
  readonly subject: string
  readonly listId: string | null
  readonly tag: string | null
  readonly body: string
  readonly hasAttachment: boolean
  readonly automated: boolean
}

export interface RuleOutcome {
  readonly matched: ReadonlyArray<string>
  /** The folder the last matching move action chose, or null to leave it to the spam check. */
  readonly folder: Extract<Folder, "archive" | "trash" | "spam"> | null
  readonly labelIds: ReadonlyArray<string>
  readonly markRead: boolean
  readonly star: boolean
  readonly skipSpamCheck: boolean
  readonly forwards: ReadonlyArray<{ readonly ruleId: string; readonly to: ReadonlyArray<string> }>
  readonly autoReplies: ReadonlyArray<{
    readonly ruleId: string
    readonly subject: string
    readonly body: string
  }>
  readonly webhooks: ReadonlyArray<{ readonly ruleId: string; readonly endpointId: string }>
}

const party = (p: { readonly name: string | null; readonly address: string }) =>
  [p.name, p.address].filter(Boolean).join(" ").toLowerCase()

/** The texts a field compares against: every party for address fields, each on its own. */
const textsOf = (field: TextField, m: RuleInput): ReadonlyArray<string> => {
  switch (field) {
    case "from":
      return m.from ? [party(m.from), m.from.address.toLowerCase()] : [""]
    case "to":
      return m.to.length ? m.to.flatMap((p) => [party(p), p.address.toLowerCase()]) : [""]
    case "cc":
      return m.cc.length ? m.cc.flatMap((p) => [party(p), p.address.toLowerCase()]) : [""]
    case "recipients":
      return [...m.to, ...m.cc].length
        ? [...m.to, ...m.cc].flatMap((p) => [party(p), p.address.toLowerCase()])
        : [""]
    case "subject":
      return [m.subject.toLowerCase()]
    case "listId":
      return [(m.listId ?? "").toLowerCase()]
    case "tag":
      return [(m.tag ?? "").toLowerCase()]
    case "body":
      return [m.body.toLowerCase()]
  }
}

const compare = (op: TextOp, text: string, value: string) => {
  switch (op) {
    case "contains":
      return text.includes(value)
    case "notContains":
      return !text.includes(value)
    case "equals":
      return text === value
    case "startsWith":
      return text.startsWith(value)
    case "endsWith":
      return text.endsWith(value)
  }
}

export const conditionHolds = (c: Condition, m: RuleInput): boolean => {
  if (c.field === "hasAttachment") return m.hasAttachment === c.value
  if (c.field === "automated") return m.automated === c.value
  const value = c.value.toLowerCase()
  const texts = textsOf(c.field, m)
  // A negative condition holds only if no text contains the value; a positive one if any text matches.
  return c.op === "notContains"
    ? texts.every((t) => compare(c.op, t, value))
    : texts.some((t) => compare(c.op, t, value))
}

export const ruleMatches = (rule: Rule, m: RuleInput) => {
  if (!rule.enabled) return false
  if (rule.conditions.length === 0) return true
  return rule.match === "all"
    ? rule.conditions.every((c) => conditionHolds(c, m))
    : rule.conditions.some((c) => conditionHolds(c, m))
}

/** Runs the rules in order and merges what the matching ones ask for. */
export const evaluate = (rules: ReadonlyArray<Rule>, m: RuleInput): RuleOutcome => {
  const matched: Array<string> = []
  let folder: RuleOutcome["folder"] = null
  const labels = new Set<string>()
  let markRead = false
  let star = false
  let skipSpamCheck = false
  const forwards: Array<RuleOutcome["forwards"][number]> = []
  const autoReplies: Array<RuleOutcome["autoReplies"][number]> = []
  const webhooks: Array<RuleOutcome["webhooks"][number]> = []
  for (const rule of rules) {
    if (!ruleMatches(rule, m)) continue
    matched.push(rule.id)
    for (const action of rule.actions) {
      switch (action.type) {
        case "label":
          labels.add(action.labelId)
          break
        case "archive":
        case "trash":
        case "spam":
          folder = action.type
          break
        case "markRead":
          markRead = true
          break
        case "star":
          star = true
          break
        case "skipSpamCheck":
          skipSpamCheck = true
          break
        case "forward":
          forwards.push({ ruleId: rule.id, to: action.to })
          break
        case "autoReply":
          autoReplies.push({ ruleId: rule.id, subject: action.subject, body: action.body })
          break
        case "webhook":
          webhooks.push({ ruleId: rule.id, endpointId: action.endpointId })
          break
      }
    }
    if (rule.stop) break
  }
  return {
    matched,
    folder,
    labelIds: [...labels],
    markRead,
    star,
    skipSpamCheck,
    forwards,
    autoReplies,
    webhooks,
  }
}

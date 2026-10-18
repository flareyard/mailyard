import { and, or, type SQL, sql } from "drizzle-orm"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import * as Schema from "effect/Schema"
import { contacts, events, messagesOut, subscriptions } from "../db/schema.ts"
import { ENGAGEMENT_DAYS } from "../domain/contacts.ts"

/**
 * A segment is a tree of rules over contacts: `all` and `any` groups of leaves. The tree compiles to
 * one SQL condition over `contacts`, with every value bound as a parameter. Only validated field
 * names are written into the SQL, and only so a field's expression index can match.
 * Times are relative ("in the last 7 days") and are worked out by SQLite when the query runs, so a
 * saved segment never goes stale.
 */

export const FIELD_OPS = [
  "eq",
  "neq",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "missing",
  /** One of a list (`value` is an array, at most 50): text compares ignoring case. */
  "in",
] as const
export type FieldOp = (typeof FIELD_OPS)[number]

const STATUSES = ["subscribed", "unconfirmed", "unsubscribed", "bounced", "complained", "suppressed"] as const
const ENGAGEMENTS = ["active", "cooling", "dormant"] as const
const STATES = ["subscribed", "unconfirmed", "unsubscribed"] as const

const Days = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 3650 }))

export const FieldRule = Schema.Struct({
  type: Schema.Literal("field"),
  /** `email`, `name`, or a custom field name. */
  field: Schema.String,
  op: Schema.Literals(FIELD_OPS),
  /** A string, number or boolean; for `in`, an array of them. */
  value: Schema.optionalKey(
    Schema.Union([
      Schema.String,
      Schema.Number,
      Schema.Boolean,
      Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
    ]),
  ),
})
export const StatusRule = Schema.Struct({
  type: Schema.Literal("status"),
  in: Schema.Array(Schema.Literals(STATUSES)),
})
export const TopicRule = Schema.Struct({
  type: Schema.Literal("topic"),
  topicId: Schema.String,
  state: Schema.optionalKey(Schema.Literals(STATES)),
  /** false: the contact is not in that state for the topic, including never having joined it. */
  is: Schema.optionalKey(Schema.Boolean),
})
export const EventRule = Schema.Struct({
  type: Schema.Literal("event"),
  name: Schema.String,
  /** false: did it fewer than `atLeast` times in the window (by default, not at all). */
  did: Schema.optionalKey(Schema.Boolean),
  withinDays: Schema.optionalKey(Days),
  atLeast: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1000 })),
  ),
})
export const EngagementRule = Schema.Struct({
  type: Schema.Literal("engagement"),
  in: Schema.Array(Schema.Literals(ENGAGEMENTS)),
})
export const CampaignRule = Schema.Struct({
  type: Schema.Literal("campaign"),
  /** Left out: any campaign (HAL-3423). */
  campaignId: Schema.optionalKey(Schema.String),
  activity: Schema.Literals(["received", "opened", "clicked"]),
  did: Schema.optionalKey(Schema.Boolean),
  /** Only campaign mail sent in the last `withinDays`. */
  withinDays: Schema.optionalKey(Days),
})
export const CreatedRule = Schema.Struct({
  type: Schema.Literal("created"),
  withinDays: Schema.optionalKey(Days),
  olderThanDays: Schema.optionalKey(Days),
})

export type Leaf =
  | typeof FieldRule.Type
  | typeof StatusRule.Type
  | typeof TopicRule.Type
  | typeof EventRule.Type
  | typeof EngagementRule.Type
  | typeof CampaignRule.Type
  | typeof CreatedRule.Type
export interface Group {
  readonly type: "all" | "any"
  readonly rules: ReadonlyArray<Rule>
}
export type Rule = Group | Leaf

export const isGroup = (rule: Rule): rule is Group => rule.type === "all" || rule.type === "any"

/**
 * The segment rule tree, published in the OpenAPI document as `SegmentRule` (HAL-3423). A tree that
 * decodes but can't work (a missing value, a bad field name, too deep) is refused with the path of
 * the rule at fault in `field`, as `filter.rules[1].rules[0]`.
 */
export const Rule: Schema.Codec<Rule> = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["all", "any"]),
    rules: Schema.Array(Schema.suspend((): Schema.Codec<Rule> => Rule)),
  }),
  FieldRule,
  StatusRule,
  TopicRule,
  EventRule,
  EngagementRule,
  CampaignRule,
  CreatedRule,
]).annotate({
  identifier: "SegmentRule",
  description:
    "A segment: `all` and `any` groups of field, status, topic, event, engagement, campaign and created rules, at most 4 deep and 50 rules.",
})

export const LIMITS = { depth: 4, leaves: 50, params: 90, fieldIndexes: 20 } as const
export const BUILTIN_FIELDS = ["email", "name"] as const
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export class RuleInvalid extends Schema.TaggedError<RuleInvalid>()("RuleInvalid", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Checks what the Schema can't: nesting, size, field names, and that every value an operator needs is there. */
export const validate = (root: Rule): RuleInvalid | null => {
  let leaves = 0
  const visit = (rule: Rule, path: string, depth: number): RuleInvalid | null => {
    if (isGroup(rule)) {
      if (depth > LIMITS.depth)
        return new RuleInvalid({ path, message: `Groups nest at most ${LIMITS.depth} deep.` })
      for (const [i, child] of rule.rules.entries()) {
        const problem = visit(child, `${path}.rules[${i}]`, depth + 1)
        if (problem) return problem
      }
      return null
    }
    leaves++
    if (leaves > LIMITS.leaves)
      return new RuleInvalid({ path, message: `At most ${LIMITS.leaves} rules in a segment.` })
    switch (rule.type) {
      case "field": {
        if (!FIELD_NAME.test(rule.field)) {
          return new RuleInvalid({ path, message: `"${rule.field}" isn't a field name.` })
        }
        const needsValue = rule.op !== "exists" && rule.op !== "missing"
        if (needsValue && rule.value === undefined) {
          return new RuleInvalid({ path, message: `The "${rule.op}" operator needs a value.` })
        }
        if (rule.op === "in") {
          if (!Array.isArray(rule.value) || rule.value.length === 0 || rule.value.length > 50)
            return new RuleInvalid({ path, message: `The "in" operator takes a list of 1 to 50 values.` })
          return null
        }
        if (Array.isArray(rule.value))
          return new RuleInvalid({ path, message: `Only the "in" operator takes a list.` })
        const textual = ["contains", "notContains", "startsWith", "endsWith"].includes(rule.op)
        if (textual && typeof rule.value !== "string") {
          return new RuleInvalid({ path, message: `The "${rule.op}" operator compares text.` })
        }
        return null
      }
      case "status":
      case "engagement":
        return rule.in.length === 0 ? new RuleInvalid({ path, message: "Pick at least one value." }) : null
      case "event":
        return rule.name.length === 0 || rule.name.length > 100
          ? new RuleInvalid({ path, message: "An event name is 1 to 100 characters." })
          : null
      case "created":
        return rule.withinDays === undefined && rule.olderThanDays === undefined
          ? new RuleInvalid({ path, message: "Give withinDays, olderThanDays or both." })
          : null
      default:
        return null
    }
  }
  return visit(root, "filter", 1)
}

const NOW = sql`(unixepoch('subsec') * 1000)`
const ago = (days: number) => sql`(${NOW} - ${days * 86_400_000})`
const bind = (v: string | number | boolean) => (typeof v === "boolean" ? (v ? 1 : 0) : v)
/** LIKE with the user's text taken literally: %, _ and \ in it match only themselves. */
const likeText = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")

const fieldExpr = (field: string): SQL => {
  if (field === "email") return sql`${contacts.email}`
  if (field === "name") return sql`${contacts.name}`
  return sql`json_extract(${contacts.fields}, ${sql.raw(`'$.${field}'`)})`
}

const compileField = (rule: typeof FieldRule.Type): SQL => {
  const expr = fieldExpr(rule.field)
  if (rule.op === "in") {
    const values = (Array.isArray(rule.value) ? rule.value : []).map(bind)
    const texts = values.filter((v): v is string => typeof v === "string")
    const others = values.filter((v) => typeof v !== "string")
    const parts = [
      texts.length
        ? sql`${expr} collate nocase in (${sql.join(
            texts.map((v) => sql`${v}`),
            sql`, `,
          )})`
        : undefined,
      others.length
        ? sql`${expr} in (${sql.join(
            others.map((v) => sql`${v}`),
            sql`, `,
          )})`
        : undefined,
    ].filter((p): p is SQL => p !== undefined)
    return parts.length === 1 ? (parts[0] as SQL) : sql`(${or(...parts)})`
  }
  const value =
    rule.value === undefined || Array.isArray(rule.value)
      ? undefined
      : bind(rule.value as string | number | boolean)
  // Text equality ignores case through NOCASE, which an expression index built with NOCASE can serve;
  // LIKE already ignores ASCII case. Numbers and booleans compare as they are.
  const text = typeof value === "string"
  switch (rule.op) {
    case "eq":
      return text ? sql`${expr} = ${value} collate nocase` : sql`${expr} = ${value}`
    case "neq":
      return text
        ? sql`(${expr} is null or ${expr} <> ${value} collate nocase)`
        : sql`(${expr} is null or ${expr} <> ${value})`
    case "contains":
      return sql`${expr} like ${`%${likeText(String(value))}%`} escape '\\'`
    case "notContains":
      return sql`(${expr} is null or ${expr} not like ${`%${likeText(String(value))}%`} escape '\\')`
    case "startsWith":
      return sql`${expr} like ${`${likeText(String(value))}%`} escape '\\'`
    case "endsWith":
      return sql`${expr} like ${`%${likeText(String(value))}`} escape '\\'`
    case "gt":
      return sql`${expr} > ${value}`
    case "gte":
      return sql`${expr} >= ${value}`
    case "lt":
      return sql`${expr} < ${value}`
    case "lte":
      return sql`${expr} <= ${value}`
    case "exists":
      return sql`${expr} is not null`
    case "missing":
      return sql`${expr} is null`
  }
}

const engagedAt = sql`max(coalesce(${contacts.lastEventAt}, 0), coalesce(${contacts.lastOpenedAt}, 0), coalesce(${contacts.lastClickedAt}, 0))`
const engagementCondition = (e: (typeof ENGAGEMENTS)[number]): SQL => {
  if (e === "active") return sql`${engagedAt} >= ${ago(ENGAGEMENT_DAYS.active)}`
  if (e === "cooling") {
    return sql`(${engagedAt} < ${ago(ENGAGEMENT_DAYS.active)} and ${engagedAt} >= ${ago(ENGAGEMENT_DAYS.cooling)})`
  }
  return sql`${engagedAt} < ${ago(ENGAGEMENT_DAYS.cooling)}`
}

const inList = (values: ReadonlyArray<string>) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )

const compileLeaf = (rule: Leaf): SQL => {
  switch (rule.type) {
    case "field":
      return compileField(rule)
    case "status":
      return sql`${contacts.status} in (${inList(rule.in)})`
    case "topic": {
      const exists = sql`exists (select 1 from ${subscriptions} where ${subscriptions.contactId} = ${contacts.id} and ${subscriptions.topicId} = ${rule.topicId} and ${subscriptions.state} = ${rule.state ?? "subscribed"})`
      return rule.is === false ? sql`not ${exists}` : exists
    }
    case "event": {
      const window = rule.withinDays ? sql` and ${events.at} >= ${ago(rule.withinDays)}` : sql``
      const times = sql`(select count(*) from ${events} where ${events.contactId} = ${contacts.id} and ${events.name} = ${rule.name}${window})`
      const atLeast = rule.atLeast ?? 1
      return rule.did === false ? sql`${times} < ${atLeast}` : sql`${times} >= ${atLeast}`
    }
    case "engagement":
      return sql`(${sql.join(rule.in.map(engagementCondition), sql` or `)})`
    case "campaign": {
      const activity =
        rule.activity === "received"
          ? sql`${messagesOut.status} in ('sent', 'delivered')`
          : rule.activity === "opened"
            ? sql`${messagesOut.firstOpenedAt} is not null`
            : sql`${messagesOut.firstClickedAt} is not null`
      const which = rule.campaignId
        ? sql`${messagesOut.campaignId} = ${rule.campaignId}`
        : sql`${messagesOut.stream} = 'campaign'`
      const window = rule.withinDays ? sql` and ${messagesOut.createdAt} >= ${ago(rule.withinDays)}` : sql``
      const exists = sql`exists (select 1 from ${messagesOut} where ${messagesOut.contactId} = ${contacts.id} and ${which} and ${activity}${window})`
      return rule.did === false ? sql`not ${exists}` : exists
    }
    case "created":
      return (
        and(
          rule.withinDays ? sql`${contacts.createdAt} >= ${ago(rule.withinDays)}` : undefined,
          rule.olderThanDays ? sql`${contacts.createdAt} < ${ago(rule.olderThanDays)}` : undefined,
        ) ?? sql`1`
      )
  }
}

/** The tree as one SQL condition over `contacts`. An empty `all` matches everyone, an empty `any` no one. */
export const compile = (rule: Rule): SQL => {
  if (isGroup(rule)) {
    const parts = rule.rules.map(compile)
    if (parts.length === 0) return rule.type === "all" ? sql`1` : sql`0`
    return sql`(${(rule.type === "all" ? and : or)(...parts)})`
  }
  return compileLeaf(rule)
}

const dialect = new SQLiteSyncDialect()

/** The condition as text plus its parameters, which is how a segment stores it for campaigns to reuse. */
export const toQuery = (condition: SQL) => {
  const query = dialect.sqlToQuery(condition)
  return { sql: query.sql, params: query.params as ReadonlyArray<unknown> }
}

export interface FieldUse {
  readonly field: string
  /** Compared as text (equality ignoring case, LIKE): served by a NOCASE index. */
  readonly text: boolean
  /** Compared as a number or boolean, or tested for presence: served by a plain index. */
  readonly plain: boolean
}

/** The custom fields a tree filters on and how, so each can get the expression index it needs. */
export const customFields = (rule: Rule): ReadonlyArray<FieldUse> => {
  const found = new Map<string, { text: boolean; plain: boolean }>()
  const visit = (r: Rule) => {
    if (isGroup(r)) {
      r.rules.forEach(visit)
      return
    }
    if (r.type !== "field" || (BUILTIN_FIELDS as ReadonlyArray<string>).includes(r.field)) return
    const use = found.get(r.field) ?? { text: false, plain: false }
    const list = Array.isArray(r.value) ? r.value : []
    const textual =
      typeof r.value === "string" ||
      list.some((v) => typeof v === "string") ||
      ["contains", "notContains", "startsWith", "endsWith"].includes(r.op)
    if (textual) use.text = true
    if (!textual || list.some((v) => typeof v !== "string")) use.plain = true
    found.set(r.field, use)
  }
  visit(rule)
  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, use]) => ({ field, ...use }))
}

/**
 * The segment rule tree (`SegmentRule`, GAPS-audience A3.1–A3.6), as pure functions: paths, immutable edits,
 * the sentence a rule reads as, and the API's own validation (`src/segments/rules.ts`), with its messages
 * word for word, so the builder marks a bad rule before the round trip and a 400's `field` path lands on the
 * same rule. `ruleText` and `RuleSentence` (in RuleSentence.tsx) are the read-only renderings other screens use.
 */
import type { components } from "../../api/client.ts"

export type Rule = components["schemas"]["SegmentRule"]
export type Group = Extract<Rule, { type: "all" | "any" }>
export type Leaf = Exclude<Rule, Group>
export type LeafType = Leaf["type"]
export type FieldRule = Extract<Rule, { type: "field" }>
export type FieldOp = FieldRule["op"]
export type Scalar = string | number | boolean
export type Status = Extract<Rule, { type: "status" }>["in"][number]
export type Engagement = Extract<Rule, { type: "engagement" }>["in"][number]
export type TopicState = NonNullable<Extract<Rule, { type: "topic" }>["state"]>
export type Activity = Extract<Rule, { type: "campaign" }>["activity"]

export const STATUSES: readonly Status[] = [
  "subscribed",
  "unconfirmed",
  "unsubscribed",
  "bounced",
  "complained",
  "suppressed",
]
export const ENGAGEMENTS: readonly Engagement[] = ["active", "cooling", "dormant"]
export const TOPIC_STATES: readonly TopicState[] = ["subscribed", "unconfirmed", "unsubscribed"]
export const ACTIVITIES: readonly Activity[] = ["received", "opened", "clicked"]

export const LIMITS = { depth: 4, leaves: 50, inValues: 50 } as const

export const isGroup = (r: Rule): r is Group => r.type === "all" || r.type === "any"

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** A rule's place in the tree, as child indices from the root group. */
export type Path = readonly number[]

/** `filter.rules[1].rules[0]`, the form a 400's `field` uses. */
export const pathString = (p: Path) => `filter${p.map((i) => `.rules[${i}]`).join("")}`

/** The indices back out of `filter.rules[1].rules[0]`; null for anything else. */
export function parsePath(s: string | null | undefined): Path | null {
  if (!s?.startsWith("filter")) return null
  const rest = s.slice("filter".length)
  if (rest !== "" && !/^(\.rules\[\d+\])+$/.test(rest)) return null
  return [...rest.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
}

export function getAt(root: Rule, p: Path): Rule | undefined {
  let cur: Rule | undefined = root
  for (const i of p) {
    if (!cur || !isGroup(cur)) return undefined
    cur = cur.rules[i]
  }
  return cur
}

/** A new tree with the rule at `p` replaced by `fn(rule)`. The root is path []. */
export function updateAt(root: Rule, p: Path, fn: (r: Rule) => Rule): Rule {
  if (p.length === 0) return fn(root)
  if (!isGroup(root)) return root
  const [head, ...tail] = p as [number, ...number[]]
  const child = root.rules[head]
  if (!child) return root
  const rules = root.rules.slice()
  rules[head] = updateAt(child, tail, fn)
  return { ...root, rules }
}

export function removeAt(root: Rule, p: Path): Rule {
  if (p.length === 0) return root
  const parent = p.slice(0, -1)
  const idx = p[p.length - 1] as number
  return updateAt(root, parent, (g) =>
    isGroup(g) ? { ...g, rules: g.rules.filter((_, i) => i !== idx) } : g,
  )
}

/** Appends a rule to the group at `p`. */
export function appendTo(root: Rule, p: Path, rule: Rule): Rule {
  return updateAt(root, p, (g) => (isGroup(g) ? { ...g, rules: [...g.rules, rule] } : g))
}

export const depthOf = (p: Path) => p.length + 1

export function countLeaves(r: Rule): number {
  return isGroup(r) ? r.rules.reduce((n, c) => n + countLeaves(c), 0) : 1
}

/** Whether another group can go inside the group at `p` (groups nest at most 4 deep). */
export const canNestAt = (p: Path) => depthOf(p) < LIMITS.depth

// ---------------------------------------------------------------------------------------------
// New rules
// ---------------------------------------------------------------------------------------------

/** What "Rule on" picks: a leaf type, or a field by key. */
export type Subject = { kind: Exclude<LeafType, "field"> } | { kind: "field"; field: string }

export const subjectKey = (s: Subject) => (s.kind === "field" ? `field:${s.field}` : s.kind)
export function parseSubject(v: string): Subject {
  if (v.startsWith("field:")) return { kind: "field", field: v.slice(6) }
  return { kind: v as Exclude<LeafType, "field"> }
}
export const subjectOf = (r: Leaf): Subject =>
  r.type === "field" ? { kind: "field", field: r.field } : { kind: r.type }

export type FieldTypeName = "string" | "number" | "boolean" | "date"

/** A sensible starting rule for a subject. `ctx` gives a topic to start from and the field's type. */
export function newLeaf(s: Subject, ctx: { topicId?: string; fieldType?: FieldTypeName } = {}): Leaf {
  switch (s.kind) {
    case "status":
      return { type: "status", in: ["subscribed"] }
    case "engagement":
      return { type: "engagement", in: ["active"] }
    case "topic":
      return { type: "topic", topicId: ctx.topicId ?? "", state: "subscribed" }
    case "event":
      return { type: "event", name: "", withinDays: 30 }
    case "campaign":
      return { type: "campaign", activity: "opened", withinDays: 30 }
    case "created":
      return { type: "created", withinDays: 30 }
    case "field":
      return ctx.fieldType === "boolean"
        ? { type: "field", field: s.field, op: "eq", value: true }
        : ctx.fieldType === "number"
          ? { type: "field", field: s.field, op: "gte", value: 1 }
          : { type: "field", field: s.field, op: "eq", value: "" }
  }
}

export const emptyTree = (): Group => ({ type: "all", rules: [] })

// ---------------------------------------------------------------------------------------------
// Field operators
// ---------------------------------------------------------------------------------------------

export const OP_LABEL: Record<FieldOp, string> = {
  in: "is any of",
  eq: "is",
  neq: "isn’t",
  contains: "contains",
  notContains: "doesn’t contain",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: "more than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  exists: "is set",
  missing: "is empty",
}

const TEXT_OPS: readonly FieldOp[] = ["contains", "notContains", "startsWith", "endsWith"]
const ORDER_OPS: readonly FieldOp[] = ["gt", "gte", "lt", "lte"]

/** The operators that make sense for a field's type, in the picker's order. */
export function opsFor(t: FieldTypeName | undefined): FieldOp[] {
  if (t === "boolean") return ["eq", "neq", "exists", "missing"]
  if (t === "number" || t === "date")
    return ["eq", "neq", "gt", "gte", "lt", "lte", "in", "exists", "missing"]
  return ["in", "eq", "neq", ...TEXT_OPS, ...ORDER_OPS, "exists", "missing"]
}

export const opNeedsValue = (op: FieldOp) => op !== "exists" && op !== "missing"

/** Keeps the value in a shape the new operator takes: a list for `in`, a scalar otherwise, none for exists. */
export function withOp(r: FieldRule, op: FieldOp): FieldRule {
  const { value: _drop, ...base } = r
  if (!opNeedsValue(op)) return { ...base, op }
  const v = r.value
  if (op === "in") {
    const list = Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]
    return { ...base, op, value: list }
  }
  const scalar = Array.isArray(v) ? (v[0] ?? "") : (v ?? "")
  return { ...base, op, value: TEXT_OPS.includes(op) ? String(scalar) : scalar }
}

/** A typed cell to the value the API stores: numbers for number fields, booleans for yes/no. */
export function coerce(raw: string, t: FieldTypeName | undefined): Scalar {
  if (t === "number") {
    const n = Number(raw.replace(/,/g, ""))
    return raw.trim() !== "" && Number.isFinite(n) ? n : raw
  }
  if (t === "boolean") return raw === "true" ? true : raw === "false" ? false : raw
  return raw
}

/** Adds a value to an `in` list: trimmed, no blanks, no repeats (ignoring case for text), 50 at most. */
export function addValue(list: readonly Scalar[], raw: string, t?: FieldTypeName): Scalar[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const out = [...list]
  for (const p of parts) {
    if (out.length >= LIMITS.inValues) break
    const v = coerce(p, t)
    const dup = out.some((x) =>
      typeof x === "string" && typeof v === "string" ? x.toLowerCase() === v.toLowerCase() : x === v,
    )
    if (!dup) out.push(v)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Validation (the API's rules and messages, src/segments/rules.ts)
// ---------------------------------------------------------------------------------------------

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export type RuleProblem = { path: string; message: string }

/** The first problem in the tree, in the API's order and words; null when it would be accepted. */
export function validate(root: Rule): RuleProblem | null {
  let leaves = 0
  const visit = (r: Rule, p: Path): RuleProblem | null => {
    const path = pathString(p)
    if (isGroup(r)) {
      if (depthOf(p) > LIMITS.depth) return { path, message: `Groups nest at most ${LIMITS.depth} deep.` }
      for (const [i, c] of r.rules.entries()) {
        const bad = visit(c, [...p, i])
        if (bad) return bad
      }
      return null
    }
    leaves++
    if (leaves > LIMITS.leaves) return { path, message: `At most ${LIMITS.leaves} rules in a segment.` }
    switch (r.type) {
      case "field": {
        if (!FIELD_NAME.test(r.field)) return { path, message: `"${r.field}" isn't a field name.` }
        if (opNeedsValue(r.op) && (r.value === undefined || r.value === ""))
          return { path, message: `The "${r.op}" operator needs a value.` }
        if (r.op === "in") {
          if (!Array.isArray(r.value) || r.value.length === 0 || r.value.length > LIMITS.inValues)
            return { path, message: `The "in" operator takes a list of 1 to 50 values.` }
          return null
        }
        if (Array.isArray(r.value)) return { path, message: `Only the "in" operator takes a list.` }
        if (TEXT_OPS.includes(r.op) && typeof r.value !== "string")
          return { path, message: `The "${r.op}" operator compares text.` }
        return null
      }
      case "status":
      case "engagement":
        return r.in.length === 0 ? { path, message: "Pick at least one value." } : null
      case "event":
        return r.name.length === 0 || r.name.length > 100
          ? { path, message: "An event name is 1 to 100 characters." }
          : null
      case "created":
        return r.withinDays === undefined && r.olderThanDays === undefined
          ? { path, message: "Give withinDays, olderThanDays or both." }
          : null
      case "campaign":
        return r.includeMachine !== undefined && r.activity === "received"
          ? { path, message: "includeMachine goes with opened or clicked." }
          : null
      case "topic":
        return r.topicId ? null : { path, message: "Pick a topic." }
      default:
        return null
    }
  }
  return visit(root, [])
}

/** Days are whole numbers from 1 to 3,650; anything else leaves the window off ("ever"). */
export function parseDays(raw: string): number | undefined {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : undefined
}

/** Sets or clears an optional numeric key without leaving `undefined` behind (exact optional types). */
export function setOpt<T extends object, K extends keyof T>(obj: T, key: K, v: T[K] | undefined): T {
  const out = { ...obj }
  if (v === undefined) delete out[key]
  else out[key] = v
  return out
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

export type Names = {
  topic?: (id: string) => string | undefined
  campaign?: (id: string) => string | undefined
  field?: (key: string) => string | undefined
}

const list = (xs: readonly (string | number | boolean)[]) => xs.map(String).join(", ")

/** One leaf as a sentence fragment: "engagement is active", "did lesson_completed in the last 7 days". */
export function leafText(r: Leaf, n: Names = {}): string {
  switch (r.type) {
    case "status":
      return `status is ${r.in.length ? list(r.in) : "…"}`
    case "engagement":
      return `engagement is ${r.in.length ? list(r.in) : "…"}`
    case "topic": {
      const name = n.topic?.(r.topicId) ?? (r.topicId || "a topic")
      const state = r.state ?? "subscribed"
      return r.is === false ? `topic ${name} isn’t ${state}` : `topic ${name} is ${state}`
    }
    case "event": {
      const times = r.atLeast && r.atLeast > 1 ? ` at least ${r.atLeast} times` : ""
      const when = r.withinDays ? ` in the last ${r.withinDays} days` : " ever"
      return `${r.did === false ? "didn’t do" : "did"} ${r.name || "an event"}${times}${when}`
    }
    case "campaign": {
      const which = r.campaignId ? (n.campaign?.(r.campaignId) ?? r.campaignId) : "any campaign"
      const verb =
        r.did === false
          ? `didn’t ${r.activity === "received" ? "receive" : r.activity.replace(/ed$/, "")}`
          : r.activity
      const machine = r.includeMachine ? " (machine opens and clicks count)" : ""
      const when = r.withinDays ? ` in the last ${r.withinDays} days` : ""
      return `${verb} ${which}${when}${machine}`
    }
    case "created": {
      if (r.withinDays && r.olderThanDays)
        return `joined between ${r.olderThanDays} and ${r.withinDays} days ago`
      if (r.withinDays) return `joined in the last ${r.withinDays} days`
      if (r.olderThanDays) return `joined more than ${r.olderThanDays} days ago`
      return "joined …"
    }
    case "field": {
      const label = n.field?.(r.field) ?? r.field
      if (!opNeedsValue(r.op)) return `${label} ${OP_LABEL[r.op]}`
      const v = Array.isArray(r.value) ? list(r.value) : String(r.value ?? "…")
      return `${label} ${OP_LABEL[r.op]} ${v}`
    }
  }
}

/** A whole tree as nested sentences, for the phone and anywhere the rules are read, not edited. */
export type Sentence = { text: string; conj: "and" | "or" | null; children?: Sentence[] }

export function ruleText(root: Rule, n: Names = {}): Sentence {
  const walk = (r: Rule, conj: "and" | "or" | null): Sentence => {
    if (!isGroup(r)) return { text: leafText(r, n), conj }
    const word = r.type === "all" ? "and" : "or"
    return {
      text: r.type,
      conj,
      children: r.rules.map((c, i) => walk(c, i === 0 ? null : word)),
    }
  }
  return walk(root, null)
}

/** One line for a list row: groups in brackets, top-level rules joined by " · ". */
export function ruleSummary(root: Rule, n: Names = {}): string {
  const inner = (r: Rule): string => {
    if (!isGroup(r)) return leafText(r, n)
    const word = r.type === "all" ? ", and " : ", or "
    return r.rules.map(inner).join(word)
  }
  if (!isGroup(root)) return cap(leafText(root, n))
  if (!root.rules.length) return "Everyone"
  return cap(root.rules.map(inner).join(root.type === "all" ? " · " : " · or "))
}

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase())

/** The first field a tree filters on, for the sample's tag (the design shows each sample's country). */
export function firstField(root: Rule): string | null {
  if (!isGroup(root)) return root.type === "field" ? root.field : null
  for (const c of root.rules) {
    const f = firstField(c)
    if (f) return f
  }
  return null
}

/**
 * The tree without its last top-level rule, to say what the count would be without it when nothing matches.
 * Null when there's nothing to take away.
 */
export function withoutLast(root: Rule): Rule | null {
  if (!isGroup(root) || root.type !== "all" || root.rules.length < 2) return null
  return { ...root, rules: root.rules.slice(0, -1) }
}

/** The same tree plus "email is X": a count of 1 means that contact matches. */
export function forContact(root: Rule, email: string): Rule {
  return { type: "all", rules: [root, { type: "field", field: "email", op: "eq", value: email.trim() }] }
}

export const EXCLUDED_LABEL: Record<
  "unconfirmed" | "unsubscribed" | "bounced" | "complained" | "suppressed",
  string
> = {
  unconfirmed: "Unconfirmed: haven’t confirmed double opt-in",
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  complained: "Complained",
  suppressed: "Suppressed",
}

/** Numbers the `?` placeholders so they read `?1 … ?n` against the params list (already numbered stays). */
export function numberParams(sql: string): string {
  if (/\?\d/.test(sql)) return sql
  let i = 0
  return sql.replace(/\?/g, () => `?${++i}`)
}

const KEYWORDS =
  /\b(SELECT|FROM|WHERE|AND|OR|NOT|EXISTS|IN|IS|NULL|COLLATE|NOCASE|COUNT|LIKE|ESCAPE|AS|ON|JOIN|LEFT|GROUP BY|ORDER BY|LIMIT|BETWEEN|CASE|WHEN|THEN|ELSE|END|DISTINCT)\b/gi

export type SqlToken = { t: "kw" | "pm" | "txt"; s: string }

/** Splits SQL into keywords, placeholders and the rest, for `pre.sql > .kw, .pm`. */
export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = []
  const re = new RegExp(`${KEYWORDS.source}|(\\?\\d+)`, "gi")
  let last = 0
  for (const m of sql.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push({ t: "txt", s: sql.slice(last, at) })
    out.push({ t: m[2] ? "pm" : "kw", s: m[0] })
    last = at + m[0].length
  }
  if (last < sql.length) out.push({ t: "txt", s: sql.slice(last) })
  return out
}

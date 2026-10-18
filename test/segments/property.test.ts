import { env } from "cloudflare:workers"
import fc from "fast-check"
import { beforeAll, describe, expect, it } from "vitest"
import { type FieldOp, isGroup, type Leaf, type Rule } from "../../src/segments/rules.ts"
import { ADMIN, call, json } from "../helpers.ts"

/**
 * The compiled SQL must pick exactly the contacts an in-memory reading of the same tree picks.
 * The dataset avoids every time boundary by at least a day, so the few milliseconds between
 * SQLite's clock and ours never change an answer.
 */

const DAY = 86_400_000
const NOW = Date.now()
const PLANS = ["free", "pro", "team"] as const
const COUNTRIES = ["ng", "gb", "us"] as const
const STATUSES = ["subscribed", "unconfirmed", "unsubscribed", "bounced", "complained", "suppressed"] as const
const EVENTS = ["signed-up", "paid", "churned"] as const
const STATES = ["subscribed", "unconfirmed", "unsubscribed"] as const
const AGES = [2, 10, 45, 120, 400] as const

interface Person {
  id: string
  email: string
  name: string | null
  status: (typeof STATUSES)[number]
  fields: { plan?: string; seats?: number; country?: string | null; vip?: boolean }
  createdAt: number
  lastEventAt: number | null
  lastOpenedAt: number | null
  lastClickedAt: number | null
  topics: Map<string, (typeof STATES)[number]>
  events: Array<{ name: string; at: number }>
  campaign: { received: boolean; opened: boolean; clicked: boolean } | null
}

const TOPICS = ["top_prop_a", "top_prop_b"]
const CAMPAIGN = "cmp_prop"
const people: Array<Person> = []

/** A small seeded generator, so a failing case reproduces. */
const rng = (() => {
  let s = 0x2f6e2b1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 0x1_0000_0000
  }
})()
const pick = <T>(xs: ReadonlyArray<T>) => xs[Math.floor(rng() * xs.length)] as T
const maybe = <T>(x: T, p = 0.5) => (rng() < p ? x : null)

beforeAll(async () => {
  const statements: Array<D1PreparedStatement> = []
  for (const id of TOPICS) {
    statements.push(
      env.DB.prepare("insert into topics (id, name, double_opt_in) values (?, ?, 0)").bind(id, id),
    )
  }
  statements.push(
    env.DB.prepare(
      "insert into campaigns (id, name, from_address, subject) values (?, 'Prop', 'a@b.co', 'Hi')",
    ).bind(CAMPAIGN),
  )
  for (let i = 0; i < 160; i++) {
    const p: Person = {
      id: `prop_${String(i).padStart(3, "0")}`,
      email:
        `${pick(["ada", "Grace", "linus", "ken"])}.${i}@${pick(["Example.net", "mail.test"])}`.toLowerCase(),
      name: maybe(`${pick(["Ada", "Grace", "Linus"])} ${i}`, 0.7),
      status: pick(STATUSES),
      fields: {},
      createdAt: NOW - pick(AGES) * DAY,
      lastEventAt: rng() < 0.6 ? NOW - pick(AGES) * DAY : null,
      lastOpenedAt: rng() < 0.4 ? NOW - pick(AGES) * DAY : null,
      lastClickedAt: rng() < 0.3 ? NOW - pick(AGES) * DAY : null,
      topics: new Map(),
      events: [],
      campaign: null,
    }
    if (rng() < 0.8) p.fields.plan = pick(PLANS)
    if (rng() < 0.7) p.fields.seats = Math.floor(rng() * 50)
    if (rng() < 0.6) p.fields.country = rng() < 0.15 ? null : pick(COUNTRIES)
    if (rng() < 0.5) p.fields.vip = rng() < 0.5
    for (const t of TOPICS) if (rng() < 0.6) p.topics.set(t, pick(STATES))
    const n = Math.floor(rng() * 4)
    for (let k = 0; k < n; k++) p.events.push({ name: pick(EVENTS), at: NOW - pick(AGES) * DAY })
    if (rng() < 0.5) {
      const opened = rng() < 0.5
      p.campaign = { received: rng() < 0.85, opened, clicked: opened && rng() < 0.5 }
    }
    people.push(p)
    statements.push(
      env.DB.prepare(
        "insert into contacts (id, email, name, fields, status, created_at, last_event_at, last_opened_at, last_clicked_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        p.id,
        p.email,
        p.name,
        JSON.stringify(p.fields),
        p.status,
        p.createdAt,
        p.lastEventAt,
        p.lastOpenedAt,
        p.lastClickedAt,
      ),
    )
    for (const [t, state] of p.topics) {
      statements.push(
        env.DB.prepare(
          "insert into subscriptions (contact_id, topic_id, state, source, changed_at) values (?, ?, ?, 'seed', ?)",
        ).bind(p.id, t, state, NOW),
      )
    }
    for (const [k, e] of p.events.entries()) {
      statements.push(
        env.DB.prepare("insert into events (id, contact_id, name, at) values (?, ?, ?, ?)").bind(
          `${p.id}_e${k}`,
          p.id,
          e.name,
          e.at,
        ),
      )
    }
    if (p.campaign) {
      statements.push(
        env.DB.prepare(
          "insert into messages_out (id, stream, contact_id, campaign_id, recipient, sender, subject, status, first_opened_at, first_clicked_at) values (?, 'campaign', ?, ?, ?, 'a@b.co', 'Hi', ?, ?, ?)",
        ).bind(
          `${p.id}_m`,
          p.id,
          CAMPAIGN,
          p.email,
          p.campaign.received ? "delivered" : "bounced",
          p.campaign.opened ? NOW - DAY : null,
          p.campaign.clicked ? NOW - DAY : null,
        ),
      )
    }
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50))
})

// ---------------------------------------------------------------------------------------------
// The in-memory reading of a tree
// ---------------------------------------------------------------------------------------------

const fieldValue = (p: Person, field: string): string | number | boolean | null | undefined => {
  if (field === "email") return p.email
  if (field === "name") return p.name
  return (p.fields as Record<string, string | number | boolean | null | undefined>)[field]
}
/** SQLite's json_extract turns booleans into 1 and 0, and lower() turns numbers into text. */
const asSql = (v: string | number | boolean | null | undefined) =>
  v === undefined || v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : v
const lower = (v: string | number) => String(v).toLowerCase()

const fieldMatches = (
  p: Person,
  op: FieldOp,
  field: string,
  value: string | number | boolean | ReadonlyArray<string | number | boolean> | undefined,
) => {
  const v = asSql(fieldValue(p, field))
  if (op === "in")
    return (
      v !== null &&
      (Array.isArray(value) ? value : []).some((x) => {
        const b = asSql(x)
        return typeof b === "string" ? typeof v === "string" && lower(v) === b.toLowerCase() : v === b
      })
    )
  const b =
    value === undefined || Array.isArray(value) ? undefined : asSql(value as string | number | boolean)
  switch (op) {
    case "exists":
      return v !== null
    case "missing":
      return v === null
    // NOCASE equality only ever matches text to text; a number never equals a string.
    case "eq":
      return (
        v !== null &&
        (typeof b === "string" ? typeof v === "string" && lower(v) === b.toLowerCase() : v === b)
      )
    case "neq":
      return (
        v === null ||
        (typeof b === "string" ? typeof v !== "string" || lower(v) !== b.toLowerCase() : v !== b)
      )
    case "contains":
      return v !== null && lower(v).includes(String(b).toLowerCase())
    case "notContains":
      return v === null || !lower(v).includes(String(b).toLowerCase())
    case "startsWith":
      return v !== null && lower(v).startsWith(String(b).toLowerCase())
    case "endsWith":
      return v !== null && lower(v).endsWith(String(b).toLowerCase())
    case "gt":
      return v !== null && typeof v === "number" && v > (b as number)
    case "gte":
      return v !== null && typeof v === "number" && v >= (b as number)
    case "lt":
      return v !== null && typeof v === "number" && v < (b as number)
    case "lte":
      return v !== null && typeof v === "number" && v <= (b as number)
  }
}

const engagement = (p: Person) => {
  const last = Math.max(p.lastEventAt ?? 0, p.lastOpenedAt ?? 0, p.lastClickedAt ?? 0)
  if (last >= NOW - 30 * DAY) return "active"
  if (last >= NOW - 90 * DAY) return "cooling"
  return "dormant"
}

const leafMatches = (p: Person, rule: Leaf): boolean => {
  switch (rule.type) {
    case "field":
      return fieldMatches(p, rule.op, rule.field, rule.value)
    case "status":
      return rule.in.includes(p.status)
    case "topic": {
      const has = p.topics.get(rule.topicId) === (rule.state ?? "subscribed")
      return rule.is === false ? !has : has
    }
    case "event": {
      const times = p.events.filter(
        (e) => e.name === rule.name && (!rule.withinDays || e.at >= NOW - rule.withinDays * DAY),
      ).length
      const atLeast = rule.atLeast ?? 1
      return rule.did === false ? times < atLeast : times >= atLeast
    }
    case "engagement":
      return rule.in.includes(engagement(p))
    case "campaign": {
      const c = p.campaign
      const did =
        c !== null &&
        (rule.activity === "received" ? c.received : rule.activity === "opened" ? c.opened : c.clicked)
      return rule.did === false ? !did : did
    }
    case "created":
      return (
        (!rule.withinDays || p.createdAt >= NOW - rule.withinDays * DAY) &&
        (!rule.olderThanDays || p.createdAt < NOW - rule.olderThanDays * DAY)
      )
  }
}

const matches = (p: Person, rule: Rule): boolean => {
  if (isGroup(rule))
    return rule.type === "all"
      ? rule.rules.every((r) => matches(p, r))
      : rule.rules.some((r) => matches(p, r))
  return leafMatches(p, rule)
}

// ---------------------------------------------------------------------------------------------
// Random trees
// ---------------------------------------------------------------------------------------------

/** Windows sit between the seeded ages, so no contact lands on a boundary. */
const WINDOWS = [1, 5, 30, 60, 200, 1000]

const textField = fc.record({
  type: fc.constant("field" as const),
  field: fc.constantFrom("plan", "country", "email", "name"),
  op: fc.constantFrom<FieldOp>(
    "eq",
    "neq",
    "contains",
    "notContains",
    "startsWith",
    "endsWith",
    "exists",
    "missing",
  ),
  value: fc.constantFrom("pro", "PRO", "free", "ng", "gb", "ada", "grace", ".net", "mail.test", "1"),
})
const numberField = fc.record({
  type: fc.constant("field" as const),
  field: fc.constant("seats"),
  op: fc.constantFrom<FieldOp>("eq", "neq", "gt", "gte", "lt", "lte", "exists", "missing"),
  value: fc.integer({ min: 0, max: 50 }),
})
const boolField = fc.record({
  type: fc.constant("field" as const),
  field: fc.constant("vip"),
  op: fc.constantFrom<FieldOp>("eq", "neq", "exists", "missing"),
  value: fc.boolean(),
})
const leaf: fc.Arbitrary<Leaf> = fc.oneof(
  textField,
  numberField,
  boolField,
  fc.record({
    type: fc.constant("status" as const),
    in: fc.uniqueArray(fc.constantFrom(...STATUSES), { minLength: 1, maxLength: 3 }),
  }),
  fc.record(
    {
      type: fc.constant("topic" as const),
      topicId: fc.constantFrom(...TOPICS),
      state: fc.constantFrom(...STATES),
      is: fc.boolean(),
    },
    { requiredKeys: ["type", "topicId"] },
  ),
  fc.record(
    {
      type: fc.constant("event" as const),
      name: fc.constantFrom(...EVENTS),
      did: fc.boolean(),
      withinDays: fc.constantFrom(...WINDOWS),
      atLeast: fc.integer({ min: 1, max: 3 }),
    },
    { requiredKeys: ["type", "name"] },
  ),
  fc.record({
    type: fc.constant("engagement" as const),
    in: fc.uniqueArray(fc.constantFrom("active", "cooling", "dormant" as const), {
      minLength: 1,
      maxLength: 2,
    }),
  }),
  fc.record(
    {
      type: fc.constant("campaign" as const),
      campaignId: fc.constant(CAMPAIGN),
      activity: fc.constantFrom("received", "opened", "clicked" as const),
      did: fc.boolean(),
    },
    { requiredKeys: ["type", "campaignId", "activity"] },
  ),
  fc
    .record(
      {
        type: fc.constant("created" as const),
        withinDays: fc.constantFrom(...WINDOWS),
        olderThanDays: fc.constantFrom(...WINDOWS),
      },
      { requiredKeys: ["type"] },
    )
    .filter((r) => r.withinDays !== undefined || r.olderThanDays !== undefined),
) as fc.Arbitrary<Leaf>

const tree: fc.Arbitrary<Rule> = fc
  .letrec<{ rule: Rule }>((tie) => ({
    rule: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      leaf,
      fc.record({
        type: fc.constantFrom("all" as const, "any" as const),
        rules: fc.array(tie("rule"), { maxLength: 4 }),
      }),
    ),
  }))
  .rule.map((r) => (r.type === "all" || r.type === "any" ? r : { type: "all" as const, rules: [r] }))

const depthOf = (r: Rule): number =>
  r.type === "all" || r.type === "any" ? 1 + Math.max(0, ...r.rules.map(depthOf)) : 0

describe("segments compile to the same set as the rules say", () => {
  it("matches an in-memory evaluator on random trees", async () => {
    // Trees that match nobody or everybody prove little; most generated trees must pick a real subset.
    let partial = 0
    let runs = 0
    await fc.assert(
      fc.asyncProperty(
        tree.filter((r) => depthOf(r) <= 4),
        async (filter) => {
          const response = await call("/v1/segments/preview", {
            method: "POST",
            key: ADMIN,
            json: { filter },
          })
          const body = await json<{ count: number; sql: string; params: Array<unknown> }>(response)
          expect(response.status, JSON.stringify(body)).toBe(200)
          const rows = await env.DB.prepare(
            `select id from contacts where id like 'prop_%' and (${body.sql})`,
          )
            .bind(...body.params)
            .all<{ id: string }>()
          const got = rows.results.map((r) => r.id).sort()
          const want = people
            .filter((p) => matches(p, filter))
            .map((p) => p.id)
            .sort()
          expect(got).toEqual(want)
          runs++
          if (want.length > 0 && want.length < people.length) partial++
        },
      ),
      { numRuns: 150, seed: 20261017 },
    )
    expect(partial / runs).toBeGreaterThan(0.5)
  }, 120_000)
})

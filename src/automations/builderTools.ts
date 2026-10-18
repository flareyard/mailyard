import { and, desc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { contacts, events } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { findAutomation, graphOf, publishedVersion } from "./automations.ts"
import { postAutomationWebhook } from "./runs.ts"

/**
 * What the automation builder's inspector asks for beyond the graph itself (HAL-3417): sending one
 * webhook step's request for real, and the `trigger.*` keys an event actually carries.
 */

export class StepNotTestable extends Schema.TaggedError<StepNotTestable>()("StepNotTestable", {
  field: Schema.String,
  message: Schema.String,
}) {}

/** Who the test request is about when no contact is named: clearly a sample. */
const SAMPLE_CONTACT = {
  id: "con_test",
  email: "test.contact@example.com",
  name: "Test Contact",
  fields: { first_name: "Test" } as Record<string, unknown>,
}

/**
 * Sends one webhook step's request now, as a run would (same body shape, same signature), marked as
 * a test: `"test": true` in the body and an `x-mailyard-test: true` header. The draft's step by
 * default, or a published version's. Nothing about any run changes.
 */
export const testWebhookStep = Effect.fn("automations.testWebhookStep")(function* (input: {
  readonly automationId: string
  readonly nodeId: string
  readonly version?: number | undefined
  readonly contactId?: string | undefined
}) {
  const automation = yield* findAutomation(input.automationId)
  const graph = input.version
    ? (yield* publishedVersion(input.automationId, input.version)).graph
    : graphOf(automation)
  const node = graph.nodes.find((n) => n.id === input.nodeId)
  if (!node) return yield* new StepNotTestable({ field: "nodeId", message: `No step ${input.nodeId}.` })
  if (node.type !== "webhook")
    return yield* new StepNotTestable({
      field: "nodeId",
      message: `Only webhook steps can send a test request; ${input.nodeId} is a ${node.type} step.`,
    })
  let url: URL
  try {
    url = new URL(node.config.url)
  } catch {
    return yield* new StepNotTestable({ field: "url", message: "The step's URL isn't a URL." })
  }
  if (url.protocol !== "https:")
    return yield* new StepNotTestable({ field: "url", message: "Webhooks go to https:// addresses." })

  let contact = SAMPLE_CONTACT
  if (input.contactId) {
    const database = yield* Database
    const row = yield* database.query("automations.testContact", (db) =>
      db
        .select({ id: contacts.id, email: contacts.email, name: contacts.name, fields: contacts.fields })
        .from(contacts)
        .where(eq(contacts.id, input.contactId as string))
        .get(),
    )
    if (!row)
      return yield* new StepNotTestable({ field: "contactId", message: `No contact ${input.contactId}.` })
    contact = { id: row.id, email: row.email, name: row.name ?? "", fields: row.fields ?? {} }
  }
  const at = Date.now()
  const result = yield* postAutomationWebhook({
    automationId: input.automationId,
    deliveryId: `test:${input.nodeId}:${at}`,
    url: url.toString(),
    test: true,
    body: {
      type: "automation.webhook",
      test: true,
      automationId: input.automationId,
      runId: null,
      step: input.nodeId,
      ...(node.config.payload ?? {}),
      contact,
    },
  })
  return {
    nodeId: input.nodeId,
    url: `${url.origin}${url.pathname}`,
    status: result.status,
    ok: result.status >= 200 && result.status < 300,
    tookMs: result.tookMs,
    error: result.error,
    /** The first 500 characters of what the endpoint answered. */
    response: result.response,
    contact: { id: contact.id, email: contact.email, sample: contact === SAMPLE_CONTACT },
  }
})

const SAMPLE = 500
const MAX_DEPTH = 3
const MAX_KEYS = 200

type KeyStat = { key: string; seen: number; types: Set<string>; example: unknown }

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v)

const shorten = (v: unknown): unknown => {
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 79)}…` : v
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`
  return v
}

/**
 * The `trigger.*` keys an event carries, from its most recent occurrences (up to 500, read newest
 * first through the `(name, at)` index, so the cost is bounded whatever the table's size). Nested
 * objects are walked to three levels as dotted keys (`trigger.order.total`), the way merge tags
 * reach them. `example` is the newest value seen, shortened; it's omitted for callers who can't read
 * contacts.
 */
export const eventKeys = Effect.fn("automations.eventKeys")(function* (input: {
  readonly name: string
  readonly withExamples: boolean
}) {
  const database = yield* Database
  const rows = yield* database.query("events.keys", (db) =>
    db
      .select({ data: events.data, at: events.at })
      .from(events)
      .where(and(eq(events.name, input.name)))
      .orderBy(desc(events.at))
      .limit(SAMPLE)
      .all(),
  )
  const stats = new Map<string, KeyStat>()
  const walk = (value: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(value)) {
      const key = prefix ? `${prefix}.${k}` : k
      const isObject = v !== null && typeof v === "object" && !Array.isArray(v)
      if (isObject && depth < MAX_DEPTH) {
        walk(v as Record<string, unknown>, key, depth + 1)
        continue
      }
      let stat = stats.get(key)
      if (!stat) {
        if (stats.size >= MAX_KEYS) continue
        stat = { key, seen: 0, types: new Set(), example: undefined }
        stats.set(key, stat)
      }
      stat.seen += 1
      stat.types.add(typeOf(v))
      if (stat.example === undefined && v !== null && v !== "") stat.example = v
    }
  }
  for (const row of rows) if (row.data && typeof row.data === "object") walk(row.data, "", 1)
  const keys = [...stats.values()]
    .sort((a, b) => b.seen - a.seen || a.key.localeCompare(b.key))
    .map((s) => ({
      key: s.key,
      /** The merge tag that reaches it in an automation email. */
      tag: `trigger.${s.key}`,
      seen: s.seen,
      types: [...s.types].sort(),
      example: input.withExamples && s.example !== undefined ? shorten(s.example) : null,
    }))
  return {
    name: input.name,
    sampled: rows.length,
    from: rows.at(-1)?.at ?? null,
    to: rows[0]?.at ?? null,
    keys,
  }
})

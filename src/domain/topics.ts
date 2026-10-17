import { and, asc, count, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { subscriptions, topics } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { recordAudit } from "./audit.ts"

export class TopicNotFound extends Schema.TaggedError<TopicNotFound>()("TopicNotFound", {
  id: Schema.String,
}) {}
export class TopicInvalid extends Schema.TaggedError<TopicInvalid>()("TopicInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

export type TopicRow = typeof topics.$inferSelect

const describe = (t: TopicRow, subscribers: number) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  doubleOptIn: t.doubleOptIn,
  sender: t.sender,
  archived: t.archived,
  subscribers,
  createdAt: t.createdAt,
})
export type TopicSummary = ReturnType<typeof describe>

/** "Name <address>" or a bare address; the sender's domain must be one Mailyard can send from. */
const checkSender = (sender: string | null | undefined) =>
  Effect.gen(function* () {
    if (sender === undefined || sender === null) return sender
    const trimmed = sender.trim()
    const address = /<([^>]+)>\s*$/.exec(trimmed)?.[1] ?? trimmed
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
      return yield* new TopicInvalid({
        field: "sender",
        message: 'A sender is "Name <address>" or an address.',
      })
    }
    return trimmed
  })

const checkName = (name: string) =>
  Effect.gen(function* () {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 100) {
      return yield* new TopicInvalid({ field: "name", message: "A topic name is 1 to 100 characters." })
    }
    return trimmed
  })

export const findTopic = Effect.fn("topics.find")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("topics.find", (db) =>
    db.select().from(topics).where(eq(topics.id, id)).get(),
  )
  if (!row) return yield* new TopicNotFound({ id })
  return row
})

const subscribersOf = (topicId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("topics.subscribers", (db) =>
      db
        .select({ n: count() })
        .from(subscriptions)
        .where(and(eq(subscriptions.topicId, topicId), eq(subscriptions.state, "subscribed")))
        .get(),
    )
    return row?.n ?? 0
  })

/** Every topic with its count of confirmed subscribers, archived ones last. */
export const listTopics = Effect.fn("topics.list")(function* () {
  const database = yield* Database
  const rows = yield* database.query("topics.list", (db) =>
    db.select().from(topics).orderBy(asc(topics.archived), asc(topics.name)).all(),
  )
  const counts = yield* database.query("topics.counts", (db) =>
    db
      .select({ topicId: subscriptions.topicId, n: count() })
      .from(subscriptions)
      .where(eq(subscriptions.state, "subscribed"))
      .groupBy(subscriptions.topicId)
      .all(),
  )
  const byTopic = new Map(counts.map((c) => [c.topicId, c.n]))
  return rows.map((t) => describe(t, byTopic.get(t.id) ?? 0))
})

export const getTopic = Effect.fn("topics.get")(function* (id: string) {
  const row = yield* findTopic(id)
  return describe(row, yield* subscribersOf(id))
})

export const createTopic = Effect.fn("topics.create")(function* (
  input: {
    readonly name: string
    readonly description?: string | null
    readonly doubleOptIn?: boolean
    readonly sender?: string | null
  },
  actor: string,
) {
  const database = yield* Database
  const name = yield* checkName(input.name)
  const sender = yield* checkSender(input.sender)
  const id = `top_${yield* (yield* Ids).next}`
  const row = yield* database.query("topics.insert", (db) =>
    db
      .insert(topics)
      .values({
        id,
        name,
        description: input.description ?? null,
        doubleOptIn: input.doubleOptIn ?? true,
        sender: sender ?? null,
      })
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "topic.create", target: id, after: row })
  return describe(row, 0)
})

export const updateTopic = Effect.fn("topics.update")(function* (
  id: string,
  input: {
    readonly name?: string
    readonly description?: string | null
    readonly doubleOptIn?: boolean
    readonly sender?: string | null
    readonly archived?: boolean
  },
  actor: string,
) {
  const database = yield* Database
  const before = yield* findTopic(id)
  const name = input.name === undefined ? undefined : yield* checkName(input.name)
  const sender = yield* checkSender(input.sender)
  const row = yield* database.query("topics.update", (db) =>
    db
      .update(topics)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.doubleOptIn !== undefined ? { doubleOptIn: input.doubleOptIn } : {}),
        ...(sender !== undefined ? { sender } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      })
      .where(eq(topics.id, id))
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "topic.update", target: id, before, after: row })
  return describe(row ?? before, yield* subscribersOf(id))
})

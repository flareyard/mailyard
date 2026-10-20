import { and, asc, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { assistantSummaries, assistantUsage, contactFields, settings, topics } from "../db/schema.ts"
import { bodyTextOf } from "../mail/compose.ts"
import type { StoredMessage, ThreadSummary } from "../mailbox/types.ts"
import { Assistant, type AssistantFeature } from "../services/Assistant.ts"
import { Database } from "../services/Database.ts"
import { prepare, previewSegment } from "./segments.ts"

/**
 * The mailbox and audience helpers (HAL-3305): a thread's summary, a reply draft, a category for
 * inbound mail, and a segment from a sentence. Every one is off until turned on in Settings, and only
 * runs when a provider is configured (MAILYARD_ASSISTANT). Each mailbox gets a daily number of calls
 * per helper, and every call's tokens are counted in `assistant_usage`.
 *
 * What a model writes is only ever a suggestion: a summary shown beside the thread, a draft saved for
 * a person to edit and send, a label, a rule tree checked by the segment code before it's shown. A
 * model never sends mail and never writes SQL.
 */

export const AssistantSettings = Schema.Struct({
  summaries: Schema.Boolean,
  drafts: Schema.Boolean,
  categories: Schema.Boolean,
  segments: Schema.Boolean,
  /** Calls a mailbox (or, for segments, the workspace) may make per helper per UTC day. */
  dailyCallsPerMailbox: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 100_000 }),
  ),
})
export type AssistantSettings = typeof AssistantSettings.Type

export const ASSISTANT_DEFAULTS: AssistantSettings = {
  summaries: false,
  drafts: false,
  categories: false,
  segments: false,
  dailyCallsPerMailbox: 200,
}

const FEATURE_SETTING: Record<AssistantFeature, keyof Omit<AssistantSettings, "dailyCallsPerMailbox">> = {
  summary: "summaries",
  draft: "drafts",
  category: "categories",
  segment: "segments",
}

export class AssistantUnavailable extends Schema.TaggedError<AssistantUnavailable>()("AssistantUnavailable", {
  reason: Schema.Literals(["off", "disabled", "cap", "no_answer", "invalid"]),
  message: Schema.String,
}) {}

const KEY = "assistant"
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10)

export const getAssistantSettings = Effect.fn("assistant.settings")(function* () {
  const database = yield* Database
  const row = yield* database.query("assistant.settings", (db) =>
    db.select().from(settings).where(eq(settings.key, KEY)).get(),
  )
  const decoded = Schema.decodeUnknownOption(AssistantSettings)(row?.value)
  return decoded._tag === "Some" ? decoded.value : ASSISTANT_DEFAULTS
})

/** What Settings → Assistant shows: the provider, the helpers, and today's calls and tokens. */
export const describeAssistant = Effect.fn("assistant.describe")(function* (now = Date.now()) {
  const assistant = yield* Assistant
  const value = yield* getAssistantSettings()
  const database = yield* Database
  const today = yield* database.query("assistant.usageToday", (db) =>
    db
      .select({
        feature: assistantUsage.feature,
        calls: sql<number>`sum(${assistantUsage.calls})`,
        inputTokens: sql<number>`sum(${assistantUsage.inputTokens})`,
        outputTokens: sql<number>`sum(${assistantUsage.outputTokens})`,
        milliNeurons: sql<number>`sum(${assistantUsage.milliNeurons})`,
      })
      .from(assistantUsage)
      .where(eq(assistantUsage.day, dayOf(now)))
      .groupBy(assistantUsage.feature)
      .all(),
  )
  return {
    ...value,
    provider: assistant.source,
    model: assistant.model,
    available: assistant.source !== "off",
    today: {
      day: dayOf(now),
      byFeature: today.map((t) => ({
        feature: t.feature,
        calls: Number(t.calls),
        inputTokens: Number(t.inputTokens),
        outputTokens: Number(t.outputTokens),
        neurons: Number(t.milliNeurons) / 1000,
      })),
    },
  }
})

export const putAssistantSettings = Effect.fn("assistant.putSettings")(function* (value: AssistantSettings) {
  const database = yield* Database
  const now = Date.now()
  yield* database.query("assistant.settings.put", (db) =>
    db
      .insert(settings)
      .values({ key: KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run(),
  )
  return yield* describeAssistant()
})

/**
 * One model call for a helper: refused when the helper is off, no provider is configured, or the
 * mailbox used today's calls. The cap is taken in one conditional upsert, so two calls racing can't
 * both slip under it; a call that brought nothing back still counts, as it cost.
 */
const ask = (input: {
  readonly feature: AssistantFeature
  readonly mailboxId: string
  readonly system: string
  readonly user: string
  readonly maxTokens: number
  readonly json?: boolean
}) =>
  Effect.gen(function* () {
    const assistant = yield* Assistant
    if (assistant.source === "off")
      return yield* new AssistantUnavailable({
        reason: "off",
        message: "No model is configured: set MAILYARD_ASSISTANT to workers-ai or openai.",
      })
    const value = yield* getAssistantSettings()
    if (!value[FEATURE_SETTING[input.feature]])
      return yield* new AssistantUnavailable({
        reason: "disabled",
        message: `The ${input.feature} helper is off. Turn it on in Settings, Assistant.`,
      })
    const database = yield* Database
    const now = Date.now()
    const cap = value.dailyCallsPerMailbox
    const taken = yield* database.query("assistant.take", (db) =>
      db
        .insert(assistantUsage)
        .values({ day: dayOf(now), mailboxId: input.mailboxId, feature: input.feature, calls: 1 })
        .onConflictDoUpdate({
          target: [assistantUsage.day, assistantUsage.mailboxId, assistantUsage.feature],
          set: { calls: sql`${assistantUsage.calls} + 1` },
          setWhere: sql`${assistantUsage.calls} < ${cap}`,
        })
        .returning({ calls: assistantUsage.calls })
        .all(),
    )
    if (taken.length === 0 || cap === 0)
      return yield* new AssistantUnavailable({
        reason: "cap",
        message: `This ${input.mailboxId ? "mailbox" : "workspace"} has used today's ${cap} ${input.feature} calls.`,
      })
    const reply = yield* assistant.complete({
      feature: input.feature,
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens,
      ...(input.json ? { json: true } : {}),
    })
    yield* database.query("assistant.usage", (db) =>
      db
        .update(assistantUsage)
        .set({
          inputTokens: sql`${assistantUsage.inputTokens} + ${reply.inputTokens}`,
          outputTokens: sql`${assistantUsage.outputTokens} + ${reply.outputTokens}`,
          milliNeurons: sql`${assistantUsage.milliNeurons} + ${Math.round((reply.neurons ?? 0) * 1000)}`,
        })
        .where(
          and(
            eq(assistantUsage.day, dayOf(now)),
            eq(assistantUsage.mailboxId, input.mailboxId),
            eq(assistantUsage.feature, input.feature),
          ),
        )
        .run(),
    )
    if (reply.text === null)
      return yield* new AssistantUnavailable({
        reason: "no_answer",
        message: "The model didn't answer. Try again.",
      })
    return { text: reply.text, model: reply.model }
  })

/** The first JSON object in a reply, tolerating prose or a code fence around it. */
export const jsonIn = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const nameOf = (p: { readonly name: string | null; readonly address: string } | null) =>
  p ? (p.name ? `${p.name} <${p.address}>` : p.address) : "(unknown)"

/** The conversation as a model reads it: the last messages, oldest first, each clipped. */
const transcript = (messages: ReadonlyArray<StoredMessage>) =>
  Effect.gen(function* () {
    const recent = messages.slice(-12)
    const parts: Array<string> = []
    let budget = 12_000
    for (const m of recent) {
      const text = clip((yield* bodyTextOf(m)).replace(/\n{3,}/g, "\n\n").trim(), 1_500)
      const part = `From: ${nameOf(m.from)}\nDate: ${new Date(m.date ?? m.receivedAt).toISOString()}\nSubject: ${m.subject}\n\n${text}`
      budget -= part.length
      if (budget < 0) break
      parts.push(part)
    }
    return parts.join("\n\n---\n\n")
  })

const versionOf = (thread: ThreadSummary) => `${thread.latestMessageId}:${thread.messageCount}`

const SUMMARY_SYSTEM = `You summarise an email conversation for the person who has to handle it. Answer only with JSON: {"summary": "<one or two sentences: who wants what, and where it stands>", "bullets": ["<up to four short facts, asks or deadlines>"]}. Use the conversation's language. Never invent facts.`

/**
 * A thread's summary, cached until the thread changes. `refresh` asks again even when cached (and
 * counts against the cap).
 */
export const summarizeThread = Effect.fn("assistant.summarize")(function* (input: {
  readonly mailboxId: string
  readonly thread: ThreadSummary
  readonly messages: ReadonlyArray<StoredMessage>
  readonly refresh?: boolean | undefined
}) {
  const database = yield* Database
  const version = versionOf(input.thread)
  if (!input.refresh) {
    const cached = yield* database.query("assistant.summaryCached", (db) =>
      db
        .select()
        .from(assistantSummaries)
        .where(
          and(
            eq(assistantSummaries.mailboxId, input.mailboxId),
            eq(assistantSummaries.threadId, input.thread.id),
          ),
        )
        .get(),
    )
    if (cached && cached.version === version)
      return {
        summary: cached.summary,
        bullets: [...cached.bullets],
        version,
        cached: true,
        model: cached.model,
        generatedAt: cached.createdAt,
      }
  }
  const answer = yield* ask({
    feature: "summary",
    mailboxId: input.mailboxId,
    system: SUMMARY_SYSTEM,
    user: yield* transcript(input.messages),
    maxTokens: 300,
    json: true,
  })
  const parsed = jsonIn(answer.text)
  const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : answer.text.trim()
  const bullets = Array.isArray(parsed?.bullets)
    ? parsed.bullets
        .filter((b): b is string => typeof b === "string" && b.trim() !== "")
        .map((b) => b.trim())
        .slice(0, 6)
    : []
  const now = Date.now()
  const row = {
    mailboxId: input.mailboxId,
    threadId: input.thread.id,
    version,
    summary: clip(summary, 1_000),
    bullets,
    model: answer.model,
    createdAt: now,
  }
  yield* database.query("assistant.summaryStore", (db) =>
    db
      .insert(assistantSummaries)
      .values(row)
      .onConflictDoUpdate({ target: [assistantSummaries.mailboxId, assistantSummaries.threadId], set: row })
      .run(),
  )
  return { summary: row.summary, bullets, version, cached: false, model: answer.model, generatedAt: now }
})

const DRAFT_SYSTEM = `You draft a reply to the last message of an email conversation, for the person whose mailbox it is to edit and send. Write only the reply's body as plain text: no subject line, no quoted original, no placeholders like [Name] unless a fact is truly missing. Be brief, specific and polite, in the conversation's language. Never promise what the conversation doesn't support.`

/** The body of a reply to the conversation's last inbound message, written by the model. */
export const draftReplyText = Effect.fn("assistant.draftText")(function* (input: {
  readonly mailboxId: string
  readonly mailboxAddress: string
  readonly messages: ReadonlyArray<StoredMessage>
  readonly instructions?: string | undefined
}) {
  const answer = yield* ask({
    feature: "draft",
    mailboxId: input.mailboxId,
    system: DRAFT_SYSTEM,
    user: `${yield* transcript(input.messages)}\n\n---\n\nYou are writing as ${input.mailboxAddress}.${
      input.instructions ? `\nWhat the reply should say: ${clip(input.instructions, 1_000)}` : ""
    }`,
    maxTokens: 600,
  })
  return { bodyText: answer.text.replace(/^```\w*\n?|```$/g, "").trim(), model: answer.model }
})

export const CATEGORIES = ["primary", "updates", "promotions", "social"] as const
export type Category = (typeof CATEGORIES)[number]
/** The label each category files under. */
export const CATEGORY_LABELS: Record<Category, string> = {
  primary: "Primary",
  updates: "Updates",
  promotions: "Promotions",
  social: "Social",
}

const CATEGORY_SYSTEM = `You sort one incoming email into a category. primary: written by a person to the reader, or needing their action. updates: receipts, notifications, statements, account and shipping messages. promotions: marketing, offers, newsletters. social: messages from social networks and communities. Answer only with JSON: {"category": "primary" | "updates" | "promotions" | "social"}.`

/** A category for one inbound message, or null when the helper is off or the model can't say. */
export const categorize = Effect.fn("assistant.categorize")(function* (input: {
  readonly mailboxId: string
  readonly from: string
  readonly subject: string
  readonly text: string
  readonly listUnsubscribe: boolean
}) {
  const answer = yield* ask({
    feature: "category",
    mailboxId: input.mailboxId,
    system: CATEGORY_SYSTEM,
    user: `From: ${input.from}\nSubject: ${input.subject}\nList-Unsubscribe: ${input.listUnsubscribe ? "yes" : "no"}\n\n${clip(input.text, 1_500)}`,
    maxTokens: 20,
    json: true,
  }).pipe(Effect.catchTag("AssistantUnavailable", () => Effect.succeed(null)))
  if (!answer) return null
  const value = jsonIn(answer.text)?.category ?? answer.text
  const category = String(value).toLowerCase().trim()
  return (CATEGORIES as ReadonlyArray<string>).includes(category) ? (category as Category) : null
})

const SEGMENT_SYSTEM = (context: string) =>
  `You turn a description of an audience into a Mailyard segment rule tree. Answer only with JSON: {"rule": <rule>, "explanation": "<one sentence saying who it matches>"}.
A rule is a group {"type": "all"|"any", "rules": [...]} (at most 4 deep, 50 rules) or a leaf:
- {"type":"field","field":"<email|name|custom field>","op":"eq|neq|contains|notContains|startsWith|endsWith|gt|gte|lt|lte|exists|missing|in","value":<string|number|boolean|array for in>}
- {"type":"status","in":["subscribed"|"unconfirmed"|"unsubscribed"|"bounced"|"complained"|"suppressed"]}
- {"type":"topic","topicId":"<id>","state":"subscribed|unconfirmed|unsubscribed","is":true|false}
- {"type":"event","name":"<event name>","did":true|false,"withinDays":<1-3650>,"atLeast":<n>}
- {"type":"engagement","in":["active"|"cooling"|"dormant"]}
- {"type":"campaign","activity":"received|opened|clicked","did":true|false,"withinDays":<n>}
- {"type":"created","withinDays":<n>,"olderThanDays":<n>}
Use only the fields and topics listed. If the description can't be expressed, answer {"rule": null, "explanation": "<why>"}.
${context}`

/**
 * A segment rule tree from a sentence. The model's tree is checked by the segment code itself (the
 * same decode and validation a saved segment gets); a tree that fails is sent back once with the
 * reason, and refused if it fails again. The answer includes the live count, so nothing is saved yet.
 */
export const segmentFromText = Effect.fn("assistant.segmentFromText")(function* (text: string) {
  const database = yield* Database
  const fields = yield* database.query("assistant.fields", (db) =>
    db
      .select({ key: contactFields.key, type: contactFields.type })
      .from(contactFields)
      .orderBy(asc(contactFields.key))
      .limit(100)
      .all(),
  )
  const topicRows = yield* database.query("assistant.topics", (db) =>
    db
      .select({ id: topics.id, name: topics.name })
      .from(topics)
      .where(eq(topics.archived, false))
      .limit(100)
      .all(),
  )
  const context = `Custom fields: ${fields.map((f) => `${f.key} (${f.type})`).join(", ") || "none"}.\nTopics: ${
    topicRows.map((t) => `${t.id} = ${t.name}`).join("; ") || "none"
  }.`
  let user = clip(text, 1_000)
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = yield* ask({
      feature: "segment",
      mailboxId: "",
      system: SEGMENT_SYSTEM(context),
      user,
      maxTokens: 600,
      json: true,
    })
    const parsed = jsonIn(answer.text)
    const explanation = typeof parsed?.explanation === "string" ? parsed.explanation : null
    if (!parsed || parsed.rule === null || parsed.rule === undefined)
      return yield* new AssistantUnavailable({
        reason: "invalid",
        message: explanation ?? "That description couldn't be turned into a segment.",
      })
    const checked = yield* Effect.result(prepare(parsed.rule))
    if (checked._tag === "Success") {
      const preview = yield* previewSegment(parsed.rule).pipe(Effect.orDie)
      return { rule: checked.success.rule, explanation, count: preview.count, model: answer.model }
    }
    const problem = checked.failure as { field?: string; message?: string }
    user = `${clip(text, 1_000)}\n\nYour last rule was refused at ${problem.field ?? "filter"}: ${problem.message ?? "invalid"}. Answer again with a valid rule.`
  }
  return yield* new AssistantUnavailable({
    reason: "invalid",
    message: "The model's rule didn't pass the segment checks. Try describing it differently.",
  })
})

import {
  type Attachment,
  BlobStore,
  Ids,
  InvalidMessage,
  type Outgoing,
  type SendError,
  Sender,
  validate,
} from "@flareyard/kit"
import { eq, inArray, sql } from "drizzle-orm"
import { Effect, Option, Schedule, Schema } from "effect"
import { Bindings } from "../Bindings.ts"
import { contacts, messagesOut, suppressions, templates } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { SendQueue } from "../services/SendQueue.ts"
import { upsertContact } from "./contacts.ts"
import { bumpDailyStat } from "./deliveryEvents.ts"
import { htmlToText, render } from "./render.ts"

export interface Party {
  readonly email: string
  readonly name?: string | undefined
}

export interface TransactionalRequest {
  readonly recipients: ReadonlyArray<Party>
  readonly subject?: string | undefined
  readonly body?: string | undefined
  readonly from?: Party | undefined
  readonly reply?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
  readonly template?: string | undefined
  readonly subscribed?: boolean | undefined
  readonly attachments?: ReadonlyArray<{ filename: string; content: string; contentType: string }> | undefined
  readonly apiKeyId: string
  readonly idempotencyKey?: string | undefined
}

export class SendRequestInvalid extends Schema.TaggedError<SendRequestInvalid>()("SendRequestInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

export class TemplateNotFound extends Schema.TaggedError<TemplateNotFound>()("TemplateNotFound", {
  template: Schema.String,
}) {}

/** Giving up on a deferred message after this many attempts marks it failed. */
export const MAX_ATTEMPTS = 8

/** "Name <email>" or a bare address. */
export const parseParty = (raw: string): Party => {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw)
  if (!match) return { email: raw.trim() }
  const name = (match[1] ?? "").trim()
  return name ? { name, email: (match[2] ?? "").trim() } : { email: (match[2] ?? "").trim() }
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const toBase64 = (bytes: Uint8Array) => {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** The rendered message as stored in R2: attachments base64-encoded so it round-trips through JSON. */
const encodeRendered = (m: Outgoing) =>
  JSON.stringify({ ...m, attachments: m.attachments?.map((a) => ({ ...a, content: toBase64(a.content) })) })

type StoredAttachment = Omit<Attachment, "content"> & { readonly content: string }

export const decodeRendered = (json: string): Outgoing => {
  const { attachments, ...rest } = JSON.parse(json) as Omit<Outgoing, "attachments"> & {
    readonly attachments?: ReadonlyArray<StoredAttachment>
  }
  return attachments
    ? { ...rest, attachments: attachments.map((a) => ({ ...a, content: fromBase64(a.content) })) }
    : rest
}

const renderedKey = (id: string) => `out/${id}.json`

const party = (p: Party) => (p.name ? { email: p.email, name: p.name } : { email: p.email })

/**
 * Sends a transactional email to each recipient, Plunk-style: the contact is created or updated, the
 * message rendered against their data, recorded in `messages_out` and stored in R2, then sent. A
 * temporary failure leaves it `deferred` on the send queue instead of failing the request.
 */
export const sendTransactional = Effect.fn("outbox.sendTransactional")(function* (
  request: TransactionalRequest,
) {
  const database = yield* Database
  const env = yield* Bindings

  let subject = request.subject
  let body = request.body
  let templateId: string | undefined
  if (request.template) {
    const id = request.template
    const template = yield* database.query("templates.find", (db) =>
      db.select().from(templates).where(eq(templates.id, id)).get(),
    )
    if (!template) return yield* new TemplateNotFound({ template: id })
    subject = subject ?? template.subject
    body = body ?? template.source
    templateId = template.id
  }
  if (!subject) return yield* new SendRequestInvalid({ field: "subject", message: "A subject is required." })
  if (!body) return yield* new SendRequestInvalid({ field: "body", message: "A body is required." })
  const from = request.from ?? (env.DEFAULT_FROM ? parseParty(env.DEFAULT_FROM) : undefined)
  if (!from) {
    return yield* new SendRequestInvalid({
      field: "from",
      message: "Sender email is required either in the request or as DEFAULT_FROM.",
    })
  }
  const attachments = request.attachments?.map((a) => ({
    filename: a.filename,
    type: a.contentType,
    content: fromBase64(a.content),
    disposition: "attachment" as const,
  }))

  // Render and validate every recipient's message before sending any, so one bad message fails the
  // request without half of it already sent.
  const prepared: Array<{ contact: { id: string; email: string }; message: Outgoing }> = []
  const suppressed = new Set(
    (yield* database.query("suppressions.forRecipients", (db) =>
      db
        .select({ email: suppressions.email })
        .from(suppressions)
        .where(
          inArray(
            suppressions.email,
            request.recipients.map((r) => r.email.trim().toLowerCase()),
          ),
        )
        .all(),
    )).map((r) => r.email),
  )
  for (const recipient of request.recipients) {
    const { contact, merged } = yield* upsertContact({
      email: recipient.email,
      name: recipient.name,
      data: recipient.name ? { ...request.data, name: recipient.name } : request.data,
      subscribed: request.subscribed,
      whenNew: "unsubscribed",
    })
    const vars = { ...merged, email: contact.email, name: contact.name ?? recipient.name, data: merged }
    const html = render(body, vars, { escape: true })
    const message: Outgoing = {
      from: party(from),
      to: [party(recipient)],
      ...(request.reply ? { replyTo: party(parseParty(request.reply)) } : {}),
      subject: render(subject, vars, { escape: false }),
      html,
      text: htmlToText(html),
      ...(request.headers ? { headers: request.headers } : {}),
      ...(attachments ? { attachments } : {}),
    }
    prepared.push({ contact: { id: contact.id, email: contact.email }, message: yield* validate(message) })
  }

  const store = yield* BlobStore
  const ids = yield* Ids
  const results: Array<{ contact: { id: string; email: string }; email: string; status: string }> = []
  for (const [index, { contact, message }] of prepared.entries()) {
    const id = yield* ids.next
    yield* store.put(renderedKey(id), new TextEncoder().encode(encodeRendered(message)), "application/json")
    yield* database.query("messagesOut.insert", (db) =>
      db
        .insert(messagesOut)
        .values({
          id,
          stream: "transactional",
          apiKeyId: request.apiKeyId,
          contactId: contact.id,
          templateId: templateId ?? null,
          // One idempotency key covers the whole request; suffix it per recipient to keep rows unique.
          idempotencyKey: request.idempotencyKey
            ? `${request.apiKeyId}:${request.idempotencyKey}:${index}`
            : null,
          recipient: contact.email,
          sender: message.from.email,
          subject: message.subject,
          renderedKey: renderedKey(id),
        })
        .run(),
    )
    if (suppressed.has(contact.email)) {
      // Don't spend a send (or reputation) on an address that bounced or complained.
      yield* database.query("messagesOut.suppressed", (db) =>
        db
          .update(messagesOut)
          .set({
            status: "rejected",
            error: "SendSuppressed: recipient is on the suppression list",
            updatedAt: Date.now(),
          })
          .where(eq(messagesOut.id, id))
          .run(),
      )
      results.push({ contact, email: id, status: "rejected" })
      continue
    }
    const status = yield* attempt(id, message, 0)
    results.push({ contact, email: id, status })
  }
  return results
})

/** One delivery attempt; records the outcome on the row and returns the new status. */
const attempt = Effect.fn("outbox.attempt")(function* (
  id: string,
  message: Outgoing,
  previousAttempts: number,
) {
  const database = yield* Database
  const sender = yield* Sender
  const queue = yield* SendQueue
  const attempts = previousAttempts + 1
  const now = Date.now()
  const outcome = yield* sender.send(message).pipe(
    // Two quick retries inside the request; anything slower goes to the queue.
    Effect.retry({
      schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
      times: 2,
      while: (e: SendError) => e._tag === "SendDeferred",
    }),
    Effect.result,
  )

  if (outcome._tag === "Success") {
    yield* database.query("messagesOut.sent", (db) =>
      db
        .update(messagesOut)
        .set({
          status: "sent",
          cfMessageId: outcome.success.messageId,
          attempts,
          error: null,
          updatedAt: now,
        })
        .where(eq(messagesOut.id, id))
        .run(),
    )
    const stream = yield* database.query("messagesOut.stream", (db) =>
      db.select({ stream: messagesOut.stream }).from(messagesOut).where(eq(messagesOut.id, id)).get(),
    )
    yield* bumpDailyStat({
      day: new Date(now).toISOString().slice(0, 10),
      stream: stream?.stream ?? "transactional",
      provider: "",
      column: "sent",
    })
    return "sent"
  }

  const error = outcome.failure
  const describe = (e: SendError) =>
    e._tag === "SendSuppressed"
      ? "SendSuppressed: recipient is on the suppression list"
      : `${e._tag}: ${messageOf(e)}`
  const retryable = error._tag === "SendDeferred" || error._tag === "QuotaExceeded"
  if (retryable && attempts < MAX_ATTEMPTS) {
    yield* database.query("messagesOut.deferred", (db) =>
      db
        .update(messagesOut)
        .set({ status: "deferred", attempts, error: describe(error), updatedAt: now })
        .where(eq(messagesOut.id, id))
        .run(),
    )
    // Quota resets daily; anything else backs off exponentially from a minute.
    const delay = error._tag === "QuotaExceeded" ? 3600 : 60 * 2 ** (attempts - 1)
    yield* queue.enqueue({ messageId: id }, delay)
    return "deferred"
  }

  const status = error._tag === "SendSuppressed" ? "rejected" : "failed"
  yield* database.query("messagesOut.failed", (db) =>
    db
      .update(messagesOut)
      .set({ status, attempts, error: describe(error), updatedAt: now })
      .where(eq(messagesOut.id, id))
      .run(),
  )
  if (error._tag === "SendSuppressed") {
    for (const email of error.recipients) {
      yield* database.query("suppressions.upsert", (db) =>
        db
          .insert(suppressions)
          .values({ email, reason: "manual", source: "cloudflare", syncedToCloudflare: true, at: now })
          .onConflictDoNothing()
          .run(),
      )
      yield* database.query("contacts.suppress", (db) =>
        db.update(contacts).set({ status: "suppressed" }).where(eq(contacts.email, email)).run(),
      )
    }
  }
  return status
})

const messageOf = (e: SendError) =>
  e._tag === "InvalidMessage" ? e.reason : e._tag === "SendSuppressed" ? e.recipients.join(", ") : e.message

/** The send queue's consumer: try a deferred message again. Returns what happened. */
export const retryDeferred = Effect.fn("outbox.retryDeferred")(function* (id: string) {
  const database = yield* Database
  const store = yield* BlobStore
  const row = yield* database.query("messagesOut.find", (db) =>
    db.select().from(messagesOut).where(eq(messagesOut.id, id)).get(),
  )
  // Already sent, failed, or gone: the job is stale, nothing to do.
  // A row with a Cloudflare message id was accepted; Cloudflare retries its own deferrals, and a
  // resend from here would deliver twice.
  if (row?.status !== "deferred" || !row.renderedKey || row.cfMessageId !== null) return "skipped"
  const blob = yield* store.get(row.renderedKey)
  if (Option.isNone(blob)) {
    return yield* new InvalidMessage({ reason: `Rendered copy ${row.renderedKey} is missing from storage.` })
  }
  const message = decodeRendered(new TextDecoder().decode(blob.value.body))
  return yield* attempt(id, message, row.attempts)
})

/** Counts for the message log's filters. */
export const countByStatus = Effect.fn("outbox.countByStatus")(function* () {
  const database = yield* Database
  return yield* database.query("messagesOut.counts", (db) =>
    db
      .select({ status: messagesOut.status, count: sql<number>`count(*)` })
      .from(messagesOut)
      .groupBy(messagesOut.status)
      .all(),
  )
})

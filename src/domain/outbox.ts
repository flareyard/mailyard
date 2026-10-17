import { eq, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { getCompliance, trackingOrigin } from "../campaigns/compliance.ts"
import { contacts, messagesOut, suppressions } from "../db/schema.ts"
import {
  type Attachment,
  BlobStore,
  Ids,
  InvalidMessage,
  type Outgoing,
  type SendError,
  Sender,
  validate,
} from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { Governor } from "../services/Governor.ts"
import { Mailboxes } from "../services/Mailboxes.ts"
import { SendQueue } from "../services/SendQueue.ts"
import { renderTemplate, type TemplateSource } from "../templates/render.ts"
import { instrument } from "../tracking/track.ts"
import { getBrand } from "./brand.ts"
import { upsertContact } from "./contacts.ts"
import { bumpDailyStat } from "./deliveryEvents.ts"
import { resolveForSend } from "./templates.ts"
import { emitSafely } from "./webhooks.ts"

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
  /** Opens and clicks to track, and the API origin (a configured tracking origin wins over it). */
  readonly track?: { readonly opens: boolean; readonly clicks: boolean; readonly origin: string } | undefined
  readonly apiKeyId: string
  readonly idempotencyKey?: string | undefined
}

export class SendRequestInvalid extends Schema.TaggedError<SendRequestInvalid>()("SendRequestInvalid", {
  field: Schema.String,
  message: Schema.String,
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
export const encodeRendered = (m: Outgoing) =>
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

export const renderedKey = (id: string) => `out/${id}.json`

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

  let source: TemplateSource
  let templateId: string | undefined
  let templateVersion: number | undefined
  if (request.template) {
    const resolved = yield* resolveForSend(request.template)
    templateId = resolved.template.id
    templateVersion = resolved.version.version
    // Plunk lets a request override the template's subject or body.
    source = request.body
      ? { kind: "html", subject: request.subject ?? resolved.source.subject, source: request.body }
      : { ...resolved.source, subject: request.subject ?? resolved.source.subject }
  } else {
    if (!request.subject)
      return yield* new SendRequestInvalid({ field: "subject", message: "A subject is required." })
    if (!request.body) return yield* new SendRequestInvalid({ field: "body", message: "A body is required." })
    source = { kind: "html", subject: request.subject, source: request.body }
  }
  const brand = yield* getBrand()
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
    const rendered = yield* Effect.try({
      try: () => renderTemplate(source, vars, brand),
      catch: (e) =>
        new SendRequestInvalid({ field: "template", message: e instanceof Error ? e.message : String(e) }),
    })
    const message: Outgoing = {
      from: party(from),
      to: [party(recipient)],
      ...(request.reply ? { replyTo: party(parseParty(request.reply)) } : {}),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(attachments ? { attachments } : {}),
    }
    prepared.push({ contact: { id: contact.id, email: contact.email }, message: yield* validate(message) })
  }

  const store = yield* BlobStore
  const ids = yield* Ids
  const results: Array<{ contact: { id: string; email: string }; email: string; status: string }> = []
  const tracking = request.track && (request.track.opens || request.track.clicks) ? request.track : undefined
  const trackOrigin = tracking ? trackingOrigin(yield* getCompliance(), tracking.origin) : ""
  for (const [index, prep] of prepared.entries()) {
    const { contact } = prep
    const id = yield* ids.next
    const message = tracking
      ? yield* instrument(prep.message, {
          messageId: id,
          origin: trackOrigin,
          opens: tracking.opens,
          clicks: tracking.clicks,
        })
      : prep.message
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
          templateVersion: templateVersion ?? null,
          tracked: Boolean(tracking),
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
      yield* emitSafely("message.rejected", {
        messageId: id,
        recipient: contact.email,
        reason: "SendSuppressed: recipient is on the suppression list",
        attempts: 0,
      })
      results.push({ contact, email: id, status: "rejected" })
      continue
    }
    const status = yield* attempt(id, message, 0)
    yield* counted("transactional")(status)
    results.push({ contact, email: id, status })
  }
  return results
})

/**
 * Tells the governor about a send it didn't grant, once Email Service has taken it, so bulk mail
 * knows how much of the day's quota is left. Bulk streams were counted when granted.
 */
const counted = (stream: string) => (status: string) =>
  status === "sent" && (stream === "transactional" || stream === "mailbox" || stream === "reply")
    ? Governor.use((g) => g.consume(stream === "transactional" ? "transactional" : "mailbox", 1))
    : Effect.void

/**
 * Sends one already-rendered bulk message (a campaign, a test, an automation step): checked, recorded
 * in `messages_out` and stored in R2, then tried. The idempotency key makes a retried step a no-op,
 * returning the first attempt's row.
 */
export const sendBulkMessage = Effect.fn("outbox.sendBulk")(function* (input: {
  readonly stream: "campaign" | "automation" | "test"
  readonly message: Outgoing
  readonly contactId: string | null
  readonly campaignId: string | null
  readonly automationRunId?: string | null
  readonly templateId?: string | null
  readonly templateVersion?: number | null
  readonly variant?: "a" | "b" | null
  /** Opens and clicks to track, and the origin the tracking links point at. */
  readonly track?: { readonly opens: boolean; readonly clicks: boolean; readonly origin: string } | undefined
  readonly idempotencyKey: string
}) {
  const database = yield* Database
  const existing = yield* database.query("messagesOut.byKey", (db) =>
    db
      .select({ id: messagesOut.id, status: messagesOut.status })
      .from(messagesOut)
      .where(eq(messagesOut.idempotencyKey, input.idempotencyKey))
      .get(),
  )
  if (existing) return { id: existing.id, status: existing.status, duplicate: true }
  const id = yield* (yield* Ids).next
  const tracked = Boolean(input.track && (input.track.opens || input.track.clicks))
  const message = yield* validate(
    input.track && tracked
      ? yield* instrument(input.message, {
          messageId: id,
          origin: input.track.origin,
          opens: input.track.opens,
          clicks: input.track.clicks,
        })
      : input.message,
  )
  const recipient = (message.to[0]?.email ?? "").toLowerCase()
  yield* (yield* BlobStore).put(
    renderedKey(id),
    new TextEncoder().encode(encodeRendered(message)),
    "application/json",
  )
  const inserted = yield* database.query("messagesOut.insertBulk", (db) =>
    db
      .insert(messagesOut)
      .values({
        id,
        stream: input.stream,
        contactId: input.contactId,
        campaignId: input.campaignId,
        automationRunId: input.automationRunId ?? null,
        templateId: input.templateId ?? null,
        templateVersion: input.templateVersion ?? null,
        variant: input.variant ?? null,
        tracked,
        idempotencyKey: input.idempotencyKey,
        recipient,
        sender: message.from.email,
        subject: message.subject,
        renderedKey: renderedKey(id),
      })
      .onConflictDoNothing()
      .returning({ id: messagesOut.id })
      .get(),
  )
  // Lost a race with another attempt using the same key: that one sends.
  if (!inserted) {
    const winner = yield* database.query("messagesOut.byKey2", (db) =>
      db
        .select({ id: messagesOut.id, status: messagesOut.status })
        .from(messagesOut)
        .where(eq(messagesOut.idempotencyKey, input.idempotencyKey))
        .get(),
    )
    return { id: winner?.id ?? id, status: winner?.status ?? "queued", duplicate: true }
  }
  const suppressed = yield* database.query("suppressions.one", (db) =>
    db
      .select({ email: suppressions.email })
      .from(suppressions)
      .where(eq(suppressions.email, recipient))
      .get(),
  )
  if (suppressed) {
    yield* database.query("messagesOut.suppressedBulk", (db) =>
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
    return { id, status: "rejected" as const, duplicate: false }
  }
  const status = yield* attempt(id, message, 0)
  return { id, status, duplicate: false }
})

/** One delivery attempt; records the outcome on the row and returns the new status. */
export const attempt = Effect.fn("outbox.attempt")(function* (
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
      db
        .select({
          stream: messagesOut.stream,
          mailboxId: messagesOut.mailboxId,
          mailboxMessageId: messagesOut.mailboxMessageId,
        })
        .from(messagesOut)
        .where(eq(messagesOut.id, id))
        .get(),
    )
    // A mailbox's sent copy learns its Message-ID now (a deferred first attempt filed it without one),
    // so replies naming that id thread. Best effort: the send itself already succeeded.
    if (stream?.mailboxId && stream.mailboxMessageId && previousAttempts > 0) {
      yield* (yield* Mailboxes)
        .setMessageId(stream.mailboxId, stream.mailboxMessageId, outcome.success.messageId)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("outbox: could not update the sent copy's Message-ID", cause),
          ),
        )
    }
    yield* bumpDailyStat({
      day: new Date(now).toISOString().slice(0, 10),
      stream: stream?.stream ?? "transactional",
      provider: "",
      column: "sent",
    })
    yield* emitSafely("message.sent", {
      messageId: id,
      cfMessageId: outcome.success.messageId,
      recipient: message.to[0]?.email ?? null,
      subject: message.subject,
      stream: stream?.stream ?? "transactional",
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
    yield* emitSafely("message.deferred", {
      messageId: id,
      recipient: message.to[0]?.email ?? null,
      reason: describe(error),
      attempts,
      retryInSeconds: delay,
    })
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
  yield* emitSafely(status === "rejected" ? "message.rejected" : "message.failed", {
    messageId: id,
    recipient: message.to[0]?.email ?? null,
    reason: describe(error),
    attempts,
  })
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
  const status = yield* attempt(id, message, row.attempts)
  yield* counted(row.stream)(status)
  return status
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

/**
 * Sends one message from a mailbox: To, Cc and Bcc together, recorded in `messages_out` under the
 * `mailbox` stream with the sent copy's id, so delivery events and retries work as for any send.
 * Suppressed recipients are dropped from the message rather than failing it; if none are left it is
 * rejected. Returns the ledger id, the status, and the Message-ID Email Service assigned when sent.
 */
export const sendFromMailbox = Effect.fn("outbox.sendFromMailbox")(function* (input: {
  readonly mailboxId: string
  /** The sent copy filed in the mailbox, or null for mail the mailbox sends on its own (forwards, auto-replies). */
  readonly sentCopyId: string | null
  readonly apiKeyId: string | null
  readonly message: Outgoing
}) {
  const database = yield* Database
  const all = [...input.message.to, ...(input.message.cc ?? []), ...(input.message.bcc ?? [])]
  const suppressed = new Set(
    (yield* database.query("suppressions.forMailboxSend", (db) =>
      db
        .select({ email: suppressions.email })
        .from(suppressions)
        .where(
          inArray(
            suppressions.email,
            all.map((a) => a.email.trim().toLowerCase()),
          ),
        )
        .all(),
    )).map((r) => r.email),
  )
  const keep = (list: ReadonlyArray<Outgoing["to"][number]> | undefined) =>
    (list ?? []).filter((a) => !suppressed.has(a.email.trim().toLowerCase()))
  const to = keep(input.message.to)
  const cc = keep(input.message.cc)
  const bcc = keep(input.message.bcc)
  // Whoever is left keeps their field. If To emptied out, the first remaining Cc (or Bcc) moves up.
  const envelope =
    to.length > 0
      ? { to, cc, bcc }
      : cc.length > 0
        ? { to: cc.slice(0, 1), cc: cc.slice(1), bcc }
        : { to: bcc.slice(0, 1), cc: [], bcc: bcc.slice(1) }
  const id = yield* (yield* Ids).next
  const recipient = (input.message.to[0] ?? all[0])?.email ?? ""
  const insert = (status: "queued" | "rejected", error: string | null) =>
    database.query("messagesOut.insertMailbox", (db) =>
      db
        .insert(messagesOut)
        .values({
          id,
          stream: "mailbox",
          apiKeyId: input.apiKeyId,
          recipient,
          sender: input.message.from.email,
          subject: input.message.subject,
          renderedKey: renderedKey(id),
          mailboxId: input.mailboxId,
          mailboxMessageId: input.sentCopyId,
          status,
          error,
        })
        .run(),
    )
  const [first, ...restTo] = envelope.to
  if (!first) {
    const error = "SendSuppressed: every recipient is on the suppression list"
    yield* insert("rejected", error)
    return {
      id,
      status: "rejected" as const,
      cfMessageId: null,
      error,
      suppressed: [...suppressed],
      message: input.message,
    }
  }
  const { cc: _cc, bcc: _bcc, ...base } = input.message
  const message: Outgoing = yield* validate({
    ...base,
    to: [first, ...restTo],
    ...(envelope.cc.length > 0 ? { cc: envelope.cc } : {}),
    ...(envelope.bcc.length > 0 ? { bcc: envelope.bcc } : {}),
  })
  yield* (yield* BlobStore).put(
    renderedKey(id),
    new TextEncoder().encode(encodeRendered(message)),
    "application/json",
  )
  yield* insert("queued", null)
  const status = yield* attempt(id, message, 0)
  yield* counted("mailbox")(status)
  const row = yield* database.query("messagesOut.cfId", (db) =>
    db
      .select({ cfMessageId: messagesOut.cfMessageId, error: messagesOut.error })
      .from(messagesOut)
      .where(eq(messagesOut.id, id))
      .get(),
  )
  return {
    id,
    status,
    cfMessageId: row?.cfMessageId ?? null,
    error: row?.error ?? null,
    suppressed: [...suppressed],
    message,
  }
})

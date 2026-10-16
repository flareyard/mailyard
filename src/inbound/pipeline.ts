import { and, desc, eq, lt, or, sql } from "drizzle-orm"
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { Bindings } from "../Bindings.ts"
import { inboundMessages } from "../db/schema.ts"
import { emitSafely } from "../domain/webhooks.ts"
import { BlobStore, Ids } from "../kit/index.ts"
import { BODY_TEXT_LIMIT, type InboundDelivery } from "../objects/MailboxDO.ts"
import { Database } from "../services/Database.ts"
import { Mailboxes } from "../services/Mailboxes.ts"
import { type ParsedMessage, parseMessage, sha256Hex } from "./parse.ts"
import { type Resolution, resolveRecipient, Unroutable } from "./resolve.ts"

/** Email Routing refuses anything larger at the MX; the handler checks again rather than trust it. */
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024

export const rawKeyOf = (sha256: string) => `raw/${sha256}.eml`
export const bodyKeyOf = (sha256: string) => `body/${sha256}.json`
export const attachmentKeyOf = (sha256: string) => `att/${sha256}`

/**
 * A stored message to file. It carries the envelope as well as the ledger id, so a job enqueued
 * when even the ledger write failed can still be filed: the raw bytes are already in R2.
 */
export const InboundJob = Schema.Struct({
  sha256: Schema.String,
  size: Schema.Number,
  envelopeFrom: Schema.String,
  envelopeTo: Schema.String,
  receivedAt: Schema.Number,
})
export type InboundJob = typeof InboundJob.Type

export class InboundQueueError extends Schema.TaggedError<InboundQueueError>()("InboundQueueError", {
  cause: Schema.Defect(),
}) {}

export class InboundQueue extends Context.Service<
  InboundQueue,
  { enqueue(job: InboundJob, delaySeconds: number): Effect.Effect<void, InboundQueueError> }
>()("mailyard/InboundQueue") {
  static readonly layer = Layer.effect(
    InboundQueue,
    Effect.gen(function* () {
      const { INBOUND_QUEUE } = yield* Bindings
      return InboundQueue.of({
        enqueue: (job, delaySeconds) =>
          Effect.tryPromise({
            try: () => INBOUND_QUEUE.send(job, { delaySeconds: Math.min(Math.max(delaySeconds, 0), 43200) }),
            catch: (cause) => new InboundQueueError({ cause }),
          }),
      })
    }),
  )
}

export class RawMissing extends Schema.TaggedError<RawMissing>()("RawMissing", { key: Schema.String }) {}
export class InboundNotFound extends Schema.TaggedError<InboundNotFound>()("InboundNotFound", {
  id: Schema.String,
}) {}

export type InboundRow = typeof inboundMessages.$inferSelect

export type Outcome =
  | { readonly outcome: "filed"; readonly id: string; readonly mailboxIds: ReadonlyArray<string> }
  | { readonly outcome: "duplicate"; readonly id: string }
  | { readonly outcome: "rejected"; readonly id: string; readonly reason: string }
  | { readonly outcome: "held"; readonly id: string; readonly reason: string }
  | { readonly outcome: "queued"; readonly id: string | null; readonly error: string }

/** A short, log-safe description of why an attempt failed: the tag and message, never the payload. */
export const describeFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  if (error && typeof error === "object" && "_tag" in error) {
    const tagged = error as { _tag: string; reason?: unknown; message?: unknown; key?: unknown }
    const detail = tagged.reason ?? tagged.message ?? tagged.key
    return typeof detail === "string" && detail ? `${tagged._tag}: ${detail}` : tagged._tag
  }
  return error instanceof Error ? error.message : String(error)
}

const ledger = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("inbound.get", (db) =>
      db.select().from(inboundMessages).where(eq(inboundMessages.id, id)).get(),
    )
    if (!row) return yield* new InboundNotFound({ id })
    return row
  })

const update = (id: string, set: SQLiteUpdateSetSource<typeof inboundMessages>) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.query("inbound.update", (db) =>
      db.update(inboundMessages).set(set).where(eq(inboundMessages.id, id)).run(),
    )
  })

/** Creates the ledger row for one envelope recipient, or finds the one a previous attempt made. */
const record = Effect.fn("inbound.record")(function* (job: InboundJob) {
  const database = yield* Database
  const ids = yield* Ids
  const id = `inb_${yield* ids.next}`
  yield* database.query("inbound.insert", (db) =>
    db
      .insert(inboundMessages)
      .values({
        id,
        sha256: job.sha256,
        rawKey: rawKeyOf(job.sha256),
        size: job.size,
        envelopeFrom: job.envelopeFrom,
        envelopeTo: job.envelopeTo.trim().toLowerCase(),
        status: "received",
        receivedAt: job.receivedAt,
      })
      .onConflictDoNothing()
      .run(),
  )
  const row = yield* database.query("inbound.find", (db) =>
    db
      .select()
      .from(inboundMessages)
      .where(
        and(
          eq(inboundMessages.sha256, job.sha256),
          eq(inboundMessages.envelopeTo, job.envelopeTo.trim().toLowerCase()),
        ),
      )
      .get(),
  )
  if (!row) return yield* Effect.die(new Error("inbound ledger row vanished after insert"))
  return row
})

const toDelivery = (row: InboundRow, resolution: Resolution, parsed: ParsedMessage): InboundDelivery => ({
  id: row.id,
  receivedAt: row.receivedAt,
  envelopeFrom: row.envelopeFrom,
  envelopeTo: row.envelopeTo,
  via: resolution.via,
  tag: resolution.tag,
  rawKey: row.rawKey,
  bodyKey: bodyKeyOf(row.sha256),
  size: row.size,
  messageId: parsed.messageId,
  inReplyTo: parsed.inReplyTo,
  references: parsed.references,
  subject: parsed.subject,
  date: parsed.date,
  from: parsed.from,
  sender: parsed.sender,
  replyTo: parsed.replyTo,
  to: parsed.to,
  cc: parsed.cc,
  snippet: parsed.snippet,
  bodyText: parsed.text.slice(0, BODY_TEXT_LIMIT),
  hasHtml: parsed.html !== null,
  auth: parsed.auth,
  automated: parsed.automated,
  listId: parsed.listId,
  listUnsubscribe: parsed.listUnsubscribe,
  attachments: parsed.attachments.map((a, i) => ({
    id: `${row.id}_${i}`,
    filename: a.filename,
    mimeType: a.mimeType,
    disposition: a.disposition,
    contentId: a.contentId,
    related: a.related,
    size: a.size,
    sha256: a.sha256,
    r2Key: attachmentKeyOf(a.sha256),
  })),
})

/**
 * Files one ledger row: resolve (once), parse, store bodies and attachments, deliver to every target
 * mailbox not yet holding it, then mark it filed. Every step is idempotent, so any attempt can be
 * repeated after a failure. `atDoor` is true inside `email()`, the only moment a bounce is possible.
 */
const file = Effect.fn("inbound.file")(function* (row: InboundRow, atDoor: boolean) {
  yield* update(row.id, { attempts: sql`${inboundMessages.attempts} + 1` })

  let resolution = row.resolution
  if (!resolution) {
    const resolved = yield* Effect.result(resolveRecipient(row.envelopeTo))
    if (resolved._tag === "Failure") {
      const failure = resolved.failure
      if (failure._tag !== "Unroutable") return yield* failure
      const status = atDoor ? "rejected" : "held"
      yield* update(row.id, { status, error: failure.reason })
      return atDoor
        ? ({ outcome: "rejected", id: row.id, reason: failure.reason } as const)
        : ({ outcome: "held", id: row.id, reason: failure.reason } as const)
    }
    resolution = resolved.success
    yield* update(row.id, { resolution })
  }

  const blobs = yield* BlobStore
  const raw = yield* blobs.get(row.rawKey)
  if (Option.isNone(raw)) return yield* new RawMissing({ key: row.rawKey })
  const parsed = yield* parseMessage(raw.value.body)

  for (const attachment of parsed.attachments) {
    yield* blobs.put(attachmentKeyOf(attachment.sha256), attachment.content, attachment.mimeType)
  }
  yield* blobs.put(
    bodyKeyOf(row.sha256),
    new TextEncoder().encode(
      JSON.stringify({ text: parsed.text, html: parsed.html, headers: parsed.headers }),
    ),
    "application/json",
  )
  yield* update(row.id, {
    messageId: parsed.messageId,
    subject: parsed.subject.slice(0, 998),
    fromAddress: parsed.from?.address ?? null,
  })

  const mailboxes = yield* Mailboxes
  const delivery = toDelivery(row, resolution, parsed)
  const delivered = [...row.deliveredTo]
  for (const mailboxId of resolution.mailboxIds) {
    if (delivered.includes(mailboxId)) continue
    const result = yield* mailboxes.deliver(mailboxId, delivery)
    delivered.push(mailboxId)
    yield* update(row.id, { deliveredTo: [...delivered] })
    if (result.stored) {
      yield* emitSafely("mail.received", {
        id: row.id,
        mailboxId,
        to: row.envelopeTo,
        via: resolution.via,
        tag: resolution.tag,
        from: parsed.from,
        subject: parsed.subject,
        messageId: parsed.messageId,
        size: row.size,
        attachments: parsed.attachments.filter((a) => !a.related).length,
        auth: { spf: parsed.auth.spf, dkim: parsed.auth.dkim.map((d) => d.result), dmarc: parsed.auth.dmarc },
        receivedAt: new Date(row.receivedAt).toISOString(),
      })
    }
  }
  yield* update(row.id, { status: "filed", error: null, filedAt: Date.now() })
  return { outcome: "filed", id: row.id, mailboxIds: resolution.mailboxIds } as const
})

/** Runs `file` and, when it breaks, records why on the row before passing the failure on. */
const fileRecording = (row: InboundRow, atDoor: boolean) =>
  file(row, atDoor).pipe(
    Effect.tapCause((cause) =>
      update(row.id, { status: "failed", error: describeFailure(cause).slice(0, 1000) }).pipe(Effect.ignore),
    ),
  )

/** Files a stored message, as the queue consumer and a manual reprocess run it. Failures propagate. */
export const ingest = Effect.fn("inbound.ingest")(function* (job: InboundJob) {
  const row = yield* record(job)
  if (row.status === "filed") return { outcome: "duplicate", id: row.id } as const
  return yield* fileRecording(row, false)
})

/**
 * The `email()` path. The raw bytes go to R2 first; if that fails the error propagates, the handler
 * throws, and the sending MTA retries later. Once the raw copy is safe nothing is lost: any failure
 * after it records the row as failed and queues a retry, and the message is accepted.
 */
export const receive = Effect.fn("inbound.receive")(function* (email: {
  readonly envelopeFrom: string
  readonly envelopeTo: string
  readonly raw: Uint8Array
  readonly receivedAt: number
}) {
  const sha256 = yield* Effect.promise(() => sha256Hex(email.raw))
  const blobs = yield* BlobStore
  yield* blobs.put(rawKeyOf(sha256), email.raw, "message/rfc822")
  const job: InboundJob = {
    sha256,
    size: email.raw.byteLength,
    envelopeFrom: email.envelopeFrom,
    envelopeTo: email.envelopeTo,
    receivedAt: email.receivedAt,
  }
  const attempt = Effect.gen(function* () {
    const row = yield* record(job)
    if (row.status === "filed") return { outcome: "duplicate", id: row.id } as Outcome
    // A repeat delivery of a message we already bounced gets the same answer.
    if (row.status === "rejected") {
      return { outcome: "rejected", id: row.id, reason: row.error ?? "Rejected" } as Outcome
    }
    return (yield* fileRecording(row, true)) as Outcome
  })
  const result = yield* Effect.exit(attempt)
  if (result._tag === "Success") return result.value
  const error = describeFailure(result.cause)
  yield* Effect.logWarning(`inbound: filing failed, queued for retry: ${error}`)
  const queue = yield* InboundQueue
  yield* queue.enqueue(job, 30)
  const database = yield* Database
  const row = yield* database
    .query("inbound.find", (db) =>
      db
        .select({ id: inboundMessages.id })
        .from(inboundMessages)
        .where(
          and(
            eq(inboundMessages.sha256, sha256),
            eq(inboundMessages.envelopeTo, email.envelopeTo.trim().toLowerCase()),
          ),
        )
        .get(),
    )
    .pipe(Effect.orElseSucceed(() => undefined))
  return { outcome: "queued", id: row?.id ?? null, error } as Outcome
})

export interface InboundSummary {
  readonly id: string
  readonly status: InboundRow["status"]
  readonly envelopeFrom: string
  readonly envelopeTo: string
  readonly messageId: string | null
  readonly subject: string | null
  readonly fromAddress: string | null
  readonly size: number
  readonly sha256: string
  readonly via: Resolution["via"] | null
  readonly tag: string | null
  readonly mailboxIds: ReadonlyArray<string>
  readonly deliveredTo: ReadonlyArray<string>
  readonly attempts: number
  readonly error: string | null
  readonly receivedAt: number
  readonly filedAt: number | null
}

export const summarize = (row: InboundRow): InboundSummary => ({
  id: row.id,
  status: row.status,
  envelopeFrom: row.envelopeFrom,
  envelopeTo: row.envelopeTo,
  messageId: row.messageId,
  subject: row.subject,
  fromAddress: row.fromAddress,
  size: row.size,
  sha256: row.sha256,
  via: row.resolution?.via ?? null,
  tag: row.resolution?.tag ?? null,
  mailboxIds: row.resolution?.mailboxIds ?? [],
  deliveredTo: row.deliveredTo,
  attempts: row.attempts,
  error: row.error,
  receivedAt: row.receivedAt,
  filedAt: row.filedAt,
})

export const getInbound = (id: string) => ledger(id).pipe(Effect.map(summarize))

export const listInbound = Effect.fn("inbound.list")(function* (filter: {
  readonly status?: InboundRow["status"] | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}) {
  const database = yield* Database
  const [cursorAt, cursorId] = filter.cursor ? filter.cursor.split(":") : []
  const rows = yield* database.query("inbound.list", (db) =>
    db
      .select()
      .from(inboundMessages)
      .where(
        and(
          filter.status ? eq(inboundMessages.status, filter.status) : undefined,
          cursorAt && cursorId
            ? or(
                lt(inboundMessages.receivedAt, Number(cursorAt)),
                and(eq(inboundMessages.receivedAt, Number(cursorAt)), lt(inboundMessages.id, cursorId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(inboundMessages.receivedAt), desc(inboundMessages.id))
      .limit(filter.limit + 1)
      .all(),
  )
  const page = rows.slice(0, filter.limit)
  const last = page.at(-1)
  return {
    messages: page.map(summarize),
    nextCursor: rows.length > filter.limit && last ? `${last.receivedAt}:${last.id}` : null,
  }
})

/**
 * Files a row again now, from its raw copy. A filed row is left alone. A rejected or held row is
 * re-resolved, so a message that bounced or had no mailbox can be filed once the address exists.
 * Never fails on a filing error: the row comes back with the status and error the attempt left.
 */
export const reprocess = Effect.fn("inbound.reprocess")(function* (id: string) {
  const row = yield* ledger(id)
  if (row.status === "filed") return summarize(row)
  const fresh = row.status === "rejected" || row.status === "held" ? { ...row, resolution: null } : row
  if (fresh.resolution === null && row.resolution !== null) yield* update(id, { resolution: null })
  yield* Effect.ignore(fileRecording(fresh, false))
  return summarize(yield* ledger(id))
})

export { Unroutable }

import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Ids } from "./Ids.ts"

/** Cloudflare Email Service accepts at most 50 recipients across to, cc and bcc (limits page, 2026-09-25). */
export const MAX_RECIPIENTS = 50
/** Total outbound message size limit for arbitrary recipients, including attachments. */
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024

export const Address = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  name: Schema.optionalKey(Schema.String),
})
export type Address = typeof Address.Type

export const Outgoing = Schema.Struct({
  from: Address,
  to: Schema.NonEmptyArray(Address),
  cc: Schema.optionalKey(Schema.Array(Address)),
  bcc: Schema.optionalKey(Schema.Array(Address)),
  replyTo: Schema.optionalKey(Address),
  subject: Schema.String.check(Schema.isMaxLength(998)),
  html: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
export type Outgoing = typeof Outgoing.Type

/** The provider rejected the message for good: fix the message, don't retry it. */
export class SendRejected extends Schema.TaggedError<SendRejected>()("SendRejected", {
  code: Schema.String,
  message: Schema.String,
}) {}

/** A temporary failure: safe to retry with backoff. */
export class SendDeferred extends Schema.TaggedError<SendDeferred>()("SendDeferred", {
  code: Schema.String,
  message: Schema.String,
}) {}

/** Every recipient is on a suppression list. */
export class SendSuppressed extends Schema.TaggedError<SendSuppressed>()("SendSuppressed", {
  recipients: Schema.Array(Schema.String),
}) {}

/** The account's daily sending quota is used up until the reset. */
export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()("QuotaExceeded", {
  message: Schema.String,
}) {}

/** The message breaks a limit we can check before calling the provider. */
export class InvalidMessage extends Schema.TaggedError<InvalidMessage>()("InvalidMessage", {
  reason: Schema.String,
}) {}

export type SendError = SendRejected | SendDeferred | SendSuppressed | QuotaExceeded | InvalidMessage

export interface SendResult {
  readonly messageId: string
}

const recipientCount = (m: Outgoing) => m.to.length + (m.cc?.length ?? 0) + (m.bcc?.length ?? 0)

const encoder = new TextEncoder()
const approximateSize = (m: Outgoing) =>
  encoder.encode(m.html ?? "").length + encoder.encode(m.text ?? "").length + encoder.encode(m.subject).length

/** Checks the limits Email Service enforces, so callers get a typed error instead of a provider rejection. */
export const validate = (m: Outgoing): Effect.Effect<Outgoing, InvalidMessage> => {
  if (!m.html && !m.text)
    return Effect.fail(new InvalidMessage({ reason: "A message needs an html or text body." }))
  const count = recipientCount(m)
  if (count > MAX_RECIPIENTS) {
    return Effect.fail(new InvalidMessage({ reason: `${count} recipients; the limit is ${MAX_RECIPIENTS}.` }))
  }
  const size = approximateSize(m)
  if (size > MAX_MESSAGE_BYTES) {
    return Effect.fail(
      new InvalidMessage({ reason: `Message is ${size} bytes; the limit is ${MAX_MESSAGE_BYTES}.` }),
    )
  }
  return Effect.succeed(m)
}

export class Sender extends Context.Service<
  Sender,
  {
    send(message: Outgoing): Effect.Effect<SendResult, SendError>
  }
>()("@flareyard/kit/Sender") {
  /**
   * An in-memory sender for tests and local development. It validates like the real one and records
   * every accepted message in `MemoryOutbox`.
   */
  static readonly layerMemory = Layer.effect(
    Sender,
    Effect.gen(function* () {
      const ids = yield* Ids
      const outbox = yield* MemoryOutbox
      const send = Effect.fn("Sender.memory.send")(function* (message: Outgoing) {
        const valid = yield* validate(message)
        const messageId = yield* ids.next
        yield* outbox.record({ ...valid, messageId })
        return { messageId }
      })
      return Sender.of({ send })
    }),
  ).pipe(Layer.provideMerge(Layer.suspend(() => MemoryOutbox.layer)))
}

export type SentMessage = Outgoing & SendResult

/** What the in-memory sender accepted, in order. */
export class MemoryOutbox extends Context.Service<
  MemoryOutbox,
  {
    readonly all: Effect.Effect<ReadonlyArray<SentMessage>>
    record(message: SentMessage): Effect.Effect<void>
  }
>()("@flareyard/kit/Sender/MemoryOutbox") {
  static readonly layer = Layer.effect(
    MemoryOutbox,
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<SentMessage>>([])
      return MemoryOutbox.of({
        all: Ref.get(sent),
        record: (message) => Ref.update(sent, (all) => [...all, message]),
      })
    }),
  )
}

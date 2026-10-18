import * as Schema from "effect/Schema"

/**
 * The mail-events lane (HAL-3306): what Mailyard puts on the `mailyard-mail-events` Queue for Hermes
 * (or any other consumer in the same account) to read. Only mailbox mail rides it: what arrives in a
 * mailbox, what a mailbox sends, who a conversation is handed to, and how those sends were delivered.
 * Campaign and automation mail stays on webhooks.
 *
 * This module is the contract. It imports nothing from the rest of Mailyard, so a consumer can copy
 * it, or import it from `mailyard/contracts/mail-events`, and decode with `decodeMailEvent`. Fields
 * are only ever added within a version; anything else raises `version`. `docs/mail-events.md` explains
 * the lane, and `docs/mail-events.schema.json` is the same contract as JSON Schema.
 */

export const MAIL_EVENTS_VERSION = 1 as const
export const MAIL_EVENTS_QUEUE = "mailyard-mail-events"
/** The dead-letter queue a consumer should configure for the lane. */
export const MAIL_EVENTS_DLQ = "mailyard-mail-events-dlq"

const Party = Schema.Struct({
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
})

/** Every event: what it is, when, which mailbox, and an id to deduplicate redeliveries by. */
const envelope = <T extends string>(type: T) => ({
  version: Schema.Literal(MAIL_EVENTS_VERSION),
  /** Unique per event; the same event redelivered keeps its id. */
  id: Schema.String,
  type: Schema.Literal(type),
  /** Milliseconds since the epoch. */
  at: Schema.Int,
  mailboxId: Schema.String,
})

export const MessageReceived = Schema.Struct({
  ...envelope("message.received"),
  threadId: Schema.String,
  /** Mailyard's id for the filed message (`GET /v1/mailboxes/{mailboxId}/messages/{messageId}`). */
  messageId: Schema.String,
  /** The Message-ID header, if the message had one. */
  internetMessageId: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Party),
  /** The envelope recipient: the mailbox address, with any +tag. */
  to: Schema.String,
  subject: Schema.String,
  /** The first couple of hundred characters of the text. */
  snippet: Schema.String,
  folder: Schema.String,
  spam: Schema.Boolean,
  /** Auto-replies, bulk and list mail. A consumer that answers mail should leave these alone. */
  automated: Schema.Boolean,
  attachments: Schema.Int,
})

export const MessageSent = Schema.Struct({
  ...envelope("message.sent"),
  /** The send's id (`GET /v1/messages/{outId}`), which delivery events carry too. */
  outId: Schema.String,
  /** The sent copy filed in the mailbox, when there is one. */
  messageId: Schema.NullOr(Schema.String),
  recipient: Schema.NullOr(Schema.String),
  subject: Schema.String,
})

export const ThreadAssigned = Schema.Struct({
  ...envelope("thread.assigned"),
  threadId: Schema.String,
  /** The key or person it's assigned to; null when it was unassigned. */
  assignee: Schema.NullOr(Schema.String),
  /** Who assigned it: a key or member id, or `rule` when a mailbox rule did. */
  by: Schema.String,
})

export const DELIVERY_KINDS = [
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
] as const

export const Delivery = Schema.Struct({
  ...envelope("delivery"),
  kind: Schema.Literals(DELIVERY_KINDS),
  outId: Schema.String,
  recipient: Schema.String,
  subject: Schema.NullOr(Schema.String),
  /** `hard` or `soft` for a bounce. */
  bounce: Schema.NullOr(Schema.String),
  smtpResponse: Schema.NullOr(Schema.String),
})

export const MailEvent = Schema.Union([MessageReceived, MessageSent, ThreadAssigned, Delivery])
export type MailEvent = typeof MailEvent.Type
export type MailEventType = MailEvent["type"]
export const MAIL_EVENT_TYPES = [
  "message.received",
  "message.sent",
  "thread.assigned",
  "delivery",
] as const satisfies ReadonlyArray<MailEventType>

/** What a consumer calls on each message body; fails on anything that isn't this version's contract. */
export const decodeMailEvent = Schema.decodeUnknownSync(MailEvent)

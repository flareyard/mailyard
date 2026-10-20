import { and, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { stopRunsForEmail } from "../automations/runs.ts"
import {
  campaigns,
  contacts,
  dailyStats,
  events,
  messageRecipients,
  messagesOut,
  processedEvents,
  suppressions,
} from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { callMailbox } from "../mail/rpc.ts"
import { Database } from "../services/Database.ts"
import { Governor } from "../services/Governor.ts"
import { raiseAlert } from "./alerts.ts"
import { isBlocked } from "./contacts.ts"
import { publishMailEvent } from "./mailEvents.ts"
import { emitSafely } from "./webhooks.ts"

/**
 * Email Sending lifecycle events, as published to a Queue by an event subscription
 * (developers.cloudflare.com/email-service/reference/event-subscriptions, read 2026-10-16).
 * Unknown fields are ignored, so a schema version bump that only adds fields doesn't break us.
 */
const Delivery = Schema.Struct({
  status: Schema.String,
  provider: Schema.optionalKey(Schema.String),
  deliveryTimeMs: Schema.optionalKey(Schema.Number),
  smtpStatusCode: Schema.optionalKey(Schema.String),
  smtpEnhancedStatusCode: Schema.optionalKey(Schema.String),
  smtpResponse: Schema.optionalKey(Schema.String),
})

export const EmailSendingEvent = Schema.Struct({
  type: Schema.Literals([
    "cf.email.sending.message.delivered",
    "cf.email.sending.message.deferred",
    "cf.email.sending.message.bounced",
    "cf.email.sending.message.failed",
    "cf.email.sending.message.rejected",
    "cf.email.sending.message.complained",
  ]),
  source: Schema.Struct({
    type: Schema.String,
    zoneId: Schema.optionalKey(Schema.String),
    domain: Schema.String,
  }),
  payload: Schema.Struct({
    eventId: Schema.String,
    messageId: Schema.String,
    sender: Schema.optionalKey(Schema.String),
    recipient: Schema.String,
    subject: Schema.optionalKey(Schema.String),
    terminal: Schema.optionalKey(Schema.Boolean),
    delivery: Delivery,
    bounce: Schema.optionalKey(
      Schema.Struct({
        type: Schema.Literals(["hard", "soft"]),
        classification: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
      }),
    ),
    failure: Schema.optionalKey(Schema.Struct({ reason: Schema.String })),
    complaint: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
  }),
  metadata: Schema.Struct({
    eventTimestamp: Schema.String,
    eventSchemaVersion: Schema.optionalKey(Schema.Number),
  }),
})
export type EmailSendingEvent = typeof EmailSendingEvent.Type

type Status = (typeof messagesOut.$inferSelect)["status"]

const KIND = {
  "cf.email.sending.message.delivered": "delivered",
  "cf.email.sending.message.deferred": "deferred",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "rejected",
  "cf.email.sending.message.complained": "complained",
} as const satisfies Record<EmailSendingEvent["type"], Status>

/**
 * Events can arrive out of order. A message only moves forward: a late `deferred` never overwrites
 * `delivered`, and a complaint (which follows delivery) overrides everything.
 */
const RANK: Record<Status, number> = {
  queued: 0,
  sent: 1,
  deferred: 2,
  delivered: 3,
  failed: 4,
  rejected: 4,
  bounced: 4,
  complained: 5,
}

const STAT_COLUMN = {
  delivered: dailyStats.delivered,
  deferred: dailyStats.deferred,
  failed: dailyStats.failed,
  rejected: dailyStats.rejected,
  complained: dailyStats.complained,
} as const

/** Adds one to a daily counter, creating the day's row for this stream and provider if needed. */
export const bumpDailyStat = Effect.fn("stats.bump")(function* (input: {
  readonly day: string
  readonly stream: string
  readonly provider: string
  readonly column:
    | "sent"
    | "delivered"
    | "deferred"
    | "bouncedHard"
    | "bouncedSoft"
    | "complained"
    | "rejected"
    | "failed"
}) {
  const database = yield* Database
  const column = {
    sent: dailyStats.sent,
    bouncedHard: dailyStats.bouncedHard,
    bouncedSoft: dailyStats.bouncedSoft,
    ...STAT_COLUMN,
  }[input.column]
  yield* database.query("stats.bump", (db) =>
    db
      .insert(dailyStats)
      .values({ day: input.day, stream: input.stream, provider: input.provider, [input.column]: 1 })
      .onConflictDoUpdate({
        target: [dailyStats.day, dailyStats.stream, dailyStats.provider],
        set: { [input.column]: sql`${column} + 1` },
      })
      .run(),
  )
})

export type Outcome = "duplicate" | "applied" | "applied-unmatched"

/**
 * Applies one Email Sending event: the delivery ledger, the daily stats, the contact's timeline, and
 * — for a hard bounce or a complaint — the suppression list and the contact's status. Each event id
 * is applied once, however often the queue redelivers it.
 */
/** The outcomes that move a campaign's rates; a deferral or a send says nothing about the list yet. */
const GOVERNED: Partial<Record<string, "delivered" | "bounced" | "complained">> = {
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
}

/**
 * Tells the governor how a bulk message landed. A campaign it pauses is marked paused and raised as
 * an alert. A governor that can't be reached is logged: the event itself is already recorded.
 */
const feedGovernor = (
  row: typeof messagesOut.$inferSelect,
  outcome: "delivered" | "bounced" | "complained",
  at: number,
) =>
  Effect.gen(function* () {
    const governor = yield* Governor
    const sendingDomain = row.sender.slice(row.sender.lastIndexOf("@") + 1)
    const result = yield* governor.record({ campaignId: row.campaignId, sendingDomain, outcome, now: at })
    if (!result.paused || !row.campaignId) return
    const database = yield* Database
    const campaign = yield* database.query("campaigns.get", (db) =>
      db
        .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
        .from(campaigns)
        .where(eq(campaigns.id, row.campaignId as string))
        .get(),
    )
    if (
      !campaign ||
      campaign.status === "paused" ||
      campaign.status === "cancelled" ||
      campaign.status === "sent"
    )
      return
    yield* database.query("campaigns.autoPause", (db) =>
      db
        .update(campaigns)
        .set({
          status: "paused",
          pausedReason: result.reason,
          // The governor says why in words; the screens act on the code (HAL-3428).
          pausedBy: result.reason?.startsWith("Complaint") ? "complaint_rate" : "bounce_rate",
          updatedAt: at,
        })
        .where(eq(campaigns.id, campaign.id))
        .run(),
    )
    yield* raiseAlert({
      key: `campaign.paused:${campaign.id}`,
      kind: "campaign_paused",
      severity: "critical",
      title: `Campaign "${campaign.name}" paused itself`,
      detail: `${result.reason ?? "Its delivery rates crossed the line."} Fix the list, then resume it.`,
      subject: { type: "campaign", id: campaign.id },
    })
    yield* emitSafely("campaign.paused", { campaignId: campaign.id, reason: result.reason })
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("governor: could not record a delivery outcome", cause)),
  )

const recordRecipient = (
  row: typeof messagesOut.$inferSelect,
  recipient: string,
  kind: Status,
  payload: EmailSendingEvent["payload"],
  at: number,
) =>
  Effect.gen(function* () {
    const database = yield* Database
    const current = yield* database.query("messageRecipients.get", (db) =>
      db
        .select()
        .from(messageRecipients)
        .where(and(eq(messageRecipients.messageId, row.id), eq(messageRecipients.recipient, recipient)))
        .get(),
    )
    const smtp = payload.delivery.smtpResponse ?? payload.failure?.reason ?? payload.bounce?.reason ?? null
    const rank = (s: string) => RANK[s as Status] ?? 0
    if (!current) {
      // Sent before recipients were recorded, or an address the event names differently: keep it.
      yield* database.query("messageRecipients.fromEvent", (db) =>
        db
          .insert(messageRecipients)
          .values({
            messageId: row.id,
            recipient,
            kind: "to",
            status: kind,
            attempts: kind === "deferred" ? 1 : 0,
            smtpResponse: smtp,
            at,
          })
          .onConflictDoNothing()
          .run(),
      )
    } else if (kind === "deferred" && current.status === "deferred") {
      yield* database.query("messageRecipients.deferredAgain", (db) =>
        db
          .update(messageRecipients)
          .set({ attempts: current.attempts + 1, smtpResponse: smtp ?? current.smtpResponse, at })
          .where(and(eq(messageRecipients.messageId, row.id), eq(messageRecipients.recipient, recipient)))
          .run(),
      )
    } else if (rank(kind) >= rank(current.status)) {
      yield* database.query("messageRecipients.event", (db) =>
        db
          .update(messageRecipients)
          .set({
            status: kind,
            attempts: current.attempts + (kind === "deferred" ? 1 : 0),
            smtpResponse: smtp ?? current.smtpResponse,
            at,
          })
          .where(and(eq(messageRecipients.messageId, row.id), eq(messageRecipients.recipient, recipient)))
          .run(),
      )
    } else return
    if (!row.mailboxId || !row.mailboxMessageId) return
    const recipients = yield* recipientsOf(row.id)
    yield* callMailbox(row.mailboxId, (s) =>
      s.notify({
        type: "delivery.changed",
        messageId: row.mailboxMessageId as string,
        logId: row.id,
        recipients,
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("delivery: mailbox not told of a recipient update", cause),
      ),
    )
  })

/** A mailbox send's recipients and how each one's delivery went, in the order they were added. */
export const recipientsOf = (messageId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const rows = yield* database.query("messageRecipients.list", (db) =>
      db.select().from(messageRecipients).where(eq(messageRecipients.messageId, messageId)).all(),
    )
    return rows.map((r) => ({
      recipient: r.recipient,
      kind: r.kind,
      status: r.status,
      at: r.at,
      attempts: r.attempts,
      smtpResponse: r.smtpResponse,
    }))
  })

export const applyEvent = Effect.fn("deliveryEvents.apply")(function* (event: EmailSendingEvent) {
  const database = yield* Database
  const { payload } = event
  const at = Date.parse(event.metadata.eventTimestamp) || Date.now()
  const first = yield* database.query("processedEvents.insert", (db) =>
    db
      .insert(processedEvents)
      .values({ eventId: payload.eventId, at })
      .onConflictDoNothing()
      .returning()
      .get(),
  )
  if (!first) return "duplicate" satisfies Outcome as Outcome

  const kind = KIND[event.type]
  const recipient = payload.recipient.toLowerCase()
  const row = yield* database.query("messagesOut.byCf", (db) =>
    db.select().from(messagesOut).where(eq(messagesOut.cfMessageId, payload.messageId)).get(),
  )

  if (row && RANK[kind] >= RANK[row.status] && !(kind === "deferred" && row.status === "deferred")) {
    yield* database.query("messagesOut.event", (db) =>
      db
        .update(messagesOut)
        .set({
          status: kind,
          bounceType: payload.bounce?.type ?? row.bounceType,
          provider: payload.delivery.provider ?? row.provider,
          smtpResponse: payload.delivery.smtpResponse ?? payload.failure?.reason ?? row.smtpResponse,
          updatedAt: at,
        })
        .where(eq(messagesOut.id, row.id))
        .run(),
    )
  }

  // A mailbox send: this recipient's own row moves forward too, and the mailbox is told (HAL-3408).
  if (row?.stream === "mailbox") yield* recordRecipient(row, recipient, kind, payload, at)

  if (row && (row.stream === "campaign" || row.stream === "automation") && GOVERNED[kind]) {
    yield* feedGovernor(row, GOVERNED[kind], at)
  }

  yield* bumpDailyStat({
    day: new Date(at).toISOString().slice(0, 10),
    // Mail sent by something else on this domain (another app using the same Email Sending domain)
    // still counts towards the domain's numbers.
    stream: row?.stream ?? "external",
    provider: payload.delivery.provider ?? "",
    column: kind === "bounced" ? (payload.bounce?.type === "soft" ? "bouncedSoft" : "bouncedHard") : kind,
  })

  const contact = row?.contactId
    ? yield* database.query("contacts.byId", (db) =>
        db
          .select()
          .from(contacts)
          .where(eq(contacts.id, row.contactId as string))
          .get(),
      )
    : yield* database.query("contacts.byEmail", (db) =>
        db.select().from(contacts).where(eq(contacts.email, recipient)).get(),
      )

  if (contact) {
    const ids = yield* Ids
    const id = yield* ids.next
    yield* database.query("events.timeline", (db) =>
      db
        .insert(events)
        .values({
          id,
          contactId: contact.id,
          name: `email.${kind}`,
          data: {
            messageId: row?.id ?? null,
            cfMessageId: payload.messageId,
            subject: payload.subject ?? row?.subject ?? null,
            provider: payload.delivery.provider ?? null,
            smtp: payload.delivery.smtpResponse ?? null,
            ...(payload.bounce ? { bounce: payload.bounce.type } : {}),
          },
          at,
        })
        .run(),
    )
  }

  const hardBounce = kind === "bounced" && payload.bounce?.type !== "soft"
  if (hardBounce || kind === "complained") {
    const reason = kind === "complained" ? ("complaint" as const) : ("hard_bounce" as const)
    yield* database.query("suppressions.fromEvent", (db) =>
      db
        .insert(suppressions)
        // Cloudflare suppresses these itself, so its list already agrees with ours.
        .values({
          email: recipient,
          reason,
          source: "events",
          syncedToCloudflare: true,
          messageId: row?.id ?? null,
          contactStatusBefore: contact && !isBlocked(contact.status) ? contact.status : null,
          at,
        })
        .onConflictDoUpdate({
          target: suppressions.email,
          // A complaint after a manual bulk-only narrowing blocks every stream again.
          set: { reason, source: "events", messageId: row?.id ?? null, bulkOnly: false, at, updatedAt: at },
        })
        .run(),
    )
    if (contact) {
      yield* database.query("contacts.status", (db) =>
        db
          .update(contacts)
          .set({ status: kind === "complained" ? "complained" : "bounced" })
          .where(eq(contacts.id, contact.id))
          .run(),
      )
    }
  }

  yield* emitSafely(`message.${kind}`, {
    messageId: row?.id ?? null,
    cfMessageId: payload.messageId,
    recipient,
    subject: payload.subject ?? row?.subject ?? null,
    provider: payload.delivery.provider ?? null,
    smtpResponse: payload.delivery.smtpResponse ?? null,
    ...(payload.bounce ? { bounce: payload.bounce.type } : {}),
    at: new Date(at).toISOString(),
    stream: row?.stream ?? null,
    campaignId: row?.campaignId ?? null,
    mailboxId: row?.mailboxId ?? null,
  })
  if (row?.mailboxId)
    yield* publishMailEvent({
      type: "delivery",
      kind,
      mailboxId: row.mailboxId,
      outId: row.id,
      recipient,
      subject: payload.subject ?? row.subject ?? null,
      bounce: payload.bounce?.type ?? null,
      smtpResponse: payload.delivery.smtpResponse ?? null,
      at,
    })
  if (hardBounce || kind === "complained") {
    yield* emitSafely("contact.suppressed", {
      email: recipient,
      reason: kind === "complained" ? "complaint" : "hard_bounce",
    })
    yield* stopRunsForEmail(
      recipient,
      kind === "complained" ? "The contact complained." : "The address bounced.",
    )
  }
  return (row ? "applied" : "applied-unmatched") as Outcome
})

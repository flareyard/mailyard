import { eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import type { ConsentEvidence } from "../db/schema.ts"
import { contacts } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { recordAudit } from "./audit.ts"
import { ConsentTokenInvalid, signConsent, verifyConsent } from "./consent.ts"
import {
  BULK_LIMIT,
  ContactInvalid,
  type ContactRow,
  chunksOf,
  D1_MAX_PARAMS,
  deleteContacts,
  findContact,
  getContact,
  isBlocked,
  writeSubscription,
} from "./contacts.ts"
import { parseParty, sendTransactional } from "./outbox.ts"
import { findTopic, TopicInvalid, type TopicRow } from "./topics.ts"

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/** The confirmation link's page lives on the Worker itself: `GET /c/{token}` (src/workers/public.ts). */
export const confirmUrl = (origin: string, token: string) => `${origin}/c/${encodeURIComponent(token)}`

/** Sends the double opt-in mail for one topic, as a transactional message from the topic's sender or DEFAULT_FROM. */
const sendConfirmation = (contact: ContactRow, topic: TopicRow, origin: string, formId: string | null) =>
  Effect.gen(function* () {
    const token = yield* signConsent({
      kind: "confirm",
      contactId: contact.id,
      topicId: topic.id,
      ...(formId ? { formId } : {}),
      issuedAt: Date.now(),
    })
    const url = confirmUrl(origin, token)
    const body = `<p>Please confirm you want to receive <strong>${esc(topic.name)}</strong>.</p>
<p><a href="${esc(url)}">Yes, subscribe me</a></p>
<p>If you didn't ask for this, ignore this message and you won't hear from us.</p>`
    yield* sendTransactional({
      recipients: [{ email: contact.email, ...(contact.name ? { name: contact.name } : {}) }],
      ...(topic.sender ? { from: parseParty(topic.sender) } : {}),
      subject: `Confirm your subscription to ${topic.name}`,
      body,
      apiKeyId: "system",
      idempotencyKey: `confirm:${contact.id}:${topic.id}:${token.slice(-12)}`,
    })
    return url
  })

/**
 * Subscribes a contact to a topic. On a double opt-in topic the subscription waits as `unconfirmed`
 * and a confirmation mail goes out, unless the caller vouches for consent with `confirmed`.
 */
export const subscribe = Effect.fn("subscriptions.subscribe")(function* (
  contactId: string,
  topicId: string,
  options: {
    readonly confirmed?: boolean | undefined
    readonly source: string
    readonly origin: string | null
    /** Where the person acted from, when they did it themselves (HAL-3426). */
    readonly evidence?: ConsentEvidence | undefined
  },
) {
  const contact = yield* findContact(contactId)
  const topic = yield* findTopic(topicId)
  if (topic.archived) {
    return yield* new TopicInvalid({ field: "topicId", message: `Topic ${topic.name} is archived.` })
  }
  if (isBlocked(contact.status)) {
    return yield* new ContactInvalid({
      field: "status",
      message: `This contact is ${contact.status}; mail to them would not arrive.`,
    })
  }
  const needsConfirmation = topic.doubleOptIn && !options.confirmed
  if (!needsConfirmation) {
    yield* writeSubscription(contact, topicId, "subscribed", options.source, options.evidence)
    return { state: "subscribed" as const, confirmationSent: false }
  }
  const env = yield* Bindings
  if (!topic.sender && !env.DEFAULT_FROM) {
    return yield* new ContactInvalid({
      field: "from",
      message: `Topic ${topic.name} needs double opt-in but has no sender, and DEFAULT_FROM isn't set.`,
    })
  }
  if (!options.origin) {
    return yield* new ContactInvalid({
      field: "confirmed",
      message:
        "This topic needs double opt-in, and no public origin is known to build the confirmation link.",
    })
  }
  const { changed, from } = yield* writeSubscription(
    contact,
    topicId,
    "unconfirmed",
    options.source,
    options.evidence,
  )
  // Already confirmed earlier: nothing to send. Already pending: send again, it may have been lost.
  if (!changed && from === "subscribed") return { state: "subscribed" as const, confirmationSent: false }
  // A signup form's source is `form:<id>`; the confirm page then follows that form's redirect.
  const formId = options.source.startsWith("form:") ? options.source.slice("form:".length) : null
  yield* sendConfirmation(contact, topic, options.origin, formId)
  return { state: "unconfirmed" as const, confirmationSent: true }
})

export const unsubscribe = Effect.fn("subscriptions.unsubscribe")(function* (
  contactId: string,
  topicId: string,
  source: string,
) {
  const contact = yield* findContact(contactId)
  yield* findTopic(topicId)
  yield* writeSubscription(contact, topicId, "unsubscribed", source)
  return { state: "unsubscribed" as const }
})

/** Follows a confirmation link: the pending subscription becomes real. Safe to follow twice. */
export const confirmSubscription = Effect.fn("subscriptions.confirm")(function* (
  token: string,
  /** The request that followed the link (HAL-3426). */
  evidence?: ConsentEvidence | undefined,
) {
  const payload = yield* verifyConsent(token)
  if (payload.kind !== "confirm") return yield* new ConsentTokenInvalid({ reason: "kind" })
  const contact = yield* findContact(payload.contactId)
  const topic = yield* findTopic(payload.topicId)
  if (!isBlocked(contact.status))
    yield* writeSubscription(contact, topic.id, "subscribed", "confirmation link", {
      ...evidence,
      ...(payload.formId ? { formId: payload.formId } : {}),
    })
  return {
    contact: contact.email,
    topic: topic.name,
    blocked: isBlocked(contact.status),
    formId: payload.formId ?? null,
  }
})

export type BulkAction =
  | { readonly action: "addTopic"; readonly topicId: string; readonly confirmed?: boolean | undefined }
  | { readonly action: "removeTopic"; readonly topicId: string }
  | { readonly action: "setStatus"; readonly status: "subscribed" | "unsubscribed" }
  | { readonly action: "delete" }

/**
 * One action over up to 1,000 contacts. Each contact succeeds or is skipped with its reason;
 * one bad row never fails the rest.
 */
export const bulkContacts = Effect.fn("contacts.bulk")(function* (
  ids: ReadonlyArray<string>,
  action: BulkAction,
  actor: string,
  origin: string | null,
) {
  if (ids.length > BULK_LIMIT) {
    return yield* new ContactInvalid({ field: "ids", message: `At most ${BULK_LIMIT} contacts per request.` })
  }
  const unique = [...new Set(ids)]
  if (action.action === "delete") {
    const deleted = yield* deleteContacts(unique, actor)
    return {
      updated: deleted,
      skipped: unique.length - deleted,
      errors: [] as Array<{ id: string; message: string }>,
    }
  }
  const database = yield* Database
  if (action.action !== "setStatus") {
    const topic = yield* findTopic(action.topicId)
    if (action.action === "addTopic" && topic.archived) {
      return yield* new TopicInvalid({ field: "topicId", message: `Topic ${topic.name} is archived.` })
    }
  }
  const found = new Set<string>()
  for (const chunk of chunksOf(unique, D1_MAX_PARAMS))
    for (const r of yield* database.query("bulk.exists", (db) =>
      db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, chunk)).all(),
    ))
      found.add(r.id)
  const errors: Array<{ id: string; message: string }> = []
  let updated = 0
  for (const id of unique) {
    if (!found.has(id)) {
      errors.push({ id, message: "No such contact." })
      continue
    }
    const step: Effect.Effect<
      unknown,
      unknown,
      Effect.Services<ReturnType<typeof subscribe>>
    > = action.action === "addTopic"
      ? subscribe(id, action.topicId, { confirmed: action.confirmed, source: "admin", origin })
      : action.action === "removeTopic"
        ? unsubscribe(id, action.topicId, "admin")
        : setStatus(id, action.status)
    const outcome = yield* Effect.result(step)
    if (outcome._tag === "Success") updated++
    else {
      const e = outcome.failure as { readonly message?: string; readonly _tag?: string }
      if (e._tag === "DatabaseError") return yield* Effect.die(e)
      errors.push({ id, message: e.message ?? String(e._tag) })
    }
  }
  yield* recordAudit({
    actor,
    action: `contacts.bulk.${action.action}`,
    target: `${updated} contacts`,
    after: action,
  })
  return { updated, skipped: unique.length - updated, errors }
})

const setStatus = (id: string, status: "subscribed" | "unsubscribed") =>
  Effect.gen(function* () {
    const database = yield* Database
    const contact = yield* findContact(id)
    if (isBlocked(contact.status)) {
      return yield* new ContactInvalid({ field: "status", message: `This contact is ${contact.status}.` })
    }
    yield* database.query("contacts.setStatus", (db) =>
      db.update(contacts).set({ status }).where(eq(contacts.id, id)).run(),
    )
    return yield* getContact(id)
  })

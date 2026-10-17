import { and, asc, eq, ne } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { contacts, events, subscriptions, topics } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { getBrandSettings } from "./brand.ts"
import { ConsentTokenInvalid, signConsent, verifyConsent } from "./consent.ts"
import { type ContactRow, findContact, isBlocked, writeSubscription } from "./contacts.ts"
import { emitSafely } from "./webhooks.ts"

/**
 * Unsubscribing, the way Gmail's and Yahoo's bulk-sender rules ask: a List-Unsubscribe header with
 * an https link that takes a one-click POST (RFC 8058) and a mailto, both honoured at once, plus a
 * preference page that needs no login. One signed token carries the contact, the topic and the
 * campaign the mail came from.
 */

export const UNSUBSCRIBE_PATH = /^\/u\/([^/]+)$/
export const unsubscribeUrl = (origin: string, token: string) => `${origin}/u/${encodeURIComponent(token)}`
/** The local part a mailto unsubscribe goes to, on whichever domain sent the mail. */
export const UNSUBSCRIBE_LOCAL = "unsubscribe"
const SUBJECT_PREFIX = "unsubscribe:"

export const unsubscribeToken = (input: {
  readonly contactId: string
  readonly topicId: string | null
  readonly campaignId: string | null
}) => signConsent({ kind: "unsubscribe", ...input, issuedAt: Date.now() })

/**
 * The headers every bulk message carries, and the links its footer shows. `mailDomain` is the
 * sending domain, whose catch-all brings the mailto back to Mailyard.
 */
export const unsubscribeHeaders = Effect.fn("unsubscribe.headers")(function* (input: {
  readonly contactId: string
  readonly topicId: string | null
  readonly campaignId: string | null
  readonly origin: string
  readonly mailDomain: string
  /** A list name for List-Id, such as the topic's. */
  readonly listName?: string | undefined
}) {
  const token = yield* unsubscribeToken(input)
  const url = unsubscribeUrl(input.origin, token)
  const mailto = `mailto:${UNSUBSCRIBE_LOCAL}@${input.mailDomain}?subject=${encodeURIComponent(`${SUBJECT_PREFIX}${token}`)}`
  const listId = input.topicId ?? "all"
  return {
    url,
    mailto,
    headers: {
      "List-Unsubscribe": `<${url}>, <${mailto}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "List-Id": `${(input.listName ?? listId).replace(/[<>"\r\n]/g, "").slice(0, 60)} <${listId.replace(/[^A-Za-z0-9_-]/g, "")}.${input.mailDomain}>`,
    },
  }
})

/** Takes a contact off every topic and marks them unsubscribed: what "unsubscribe from all" means. */
const unsubscribeAll = (contact: ContactRow, source: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const current = yield* database.query("unsubscribe.current", (db) =>
      db
        .select({ topicId: subscriptions.topicId })
        .from(subscriptions)
        .where(and(eq(subscriptions.contactId, contact.id), ne(subscriptions.state, "unsubscribed")))
        .all(),
    )
    for (const s of current) yield* writeSubscription(contact, s.topicId, "unsubscribed", source)
    if (!isBlocked(contact.status) && contact.status !== "unsubscribed") {
      yield* database.query("unsubscribe.contact", (db) =>
        db.update(contacts).set({ status: "unsubscribed" }).where(eq(contacts.id, contact.id)).run(),
      )
      yield* emitSafely("contact.unsubscribed", {
        contactId: contact.id,
        email: contact.email,
        topicId: null,
        source,
      })
    }
  })

/** A system event on the contact's timeline, which campaign reports count unsubscribes from. */
const noteUnsubscribe = (
  contact: ContactRow,
  payload: { readonly topicId: string | null; readonly campaignId: string | null },
  how: string,
) =>
  Effect.gen(function* () {
    const database = yield* Database
    const id = yield* (yield* Ids).next
    yield* database.query("unsubscribe.event", (db) =>
      db
        .insert(events)
        .values({
          id,
          contactId: contact.id,
          name: "email.unsubscribed",
          data: { topicId: payload.topicId, campaignId: payload.campaignId, how },
          at: Date.now(),
        })
        .run(),
    )
  })

const decode = (token: string) =>
  Effect.gen(function* () {
    const payload = yield* verifyConsent(token)
    if (payload.kind !== "unsubscribe") return yield* new ConsentTokenInvalid({ reason: "kind" })
    return payload
  })

/** One click, from the List-Unsubscribe-Post header or the mailto: done at once, no questions asked. */
export const oneClickUnsubscribe = Effect.fn("unsubscribe.oneClick")(function* (
  token: string,
  how: "one-click" | "mailto",
) {
  const payload = yield* decode(token)
  const contact = yield* findContact(payload.contactId)
  if (payload.topicId) {
    const topic = yield* Database.use((d) =>
      d.query("unsubscribe.topic", (db) =>
        db
          .select({ id: topics.id })
          .from(topics)
          .where(eq(topics.id, payload.topicId as string))
          .get(),
      ),
    )
    if (topic) yield* writeSubscription(contact, payload.topicId, "unsubscribed", how)
    else yield* unsubscribeAll(contact, how)
  } else {
    yield* unsubscribeAll(contact, how)
  }
  yield* noteUnsubscribe(contact, payload, how)
  return { contactId: contact.id, topicId: payload.topicId }
})

/** Finds `unsubscribe:<token>` in a mailto unsubscribe's subject. */
export const tokenFromSubject = (subject: string) => {
  const at = subject.toLowerCase().indexOf(SUBJECT_PREFIX)
  if (at < 0) return null
  const token =
    subject
      .slice(at + SUBJECT_PREFIX.length)
      .trim()
      .split(/\s/)[0] ?? ""
  return token.length > 0 ? decodeURIComponent(token) : null
}

export interface PreferenceTopic {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly subscribed: boolean
}

/** What the preference page shows: who it's for (partly masked), every live topic and their choice. */
export const preferences = Effect.fn("unsubscribe.preferences")(function* (token: string) {
  const payload = yield* decode(token)
  const contact = yield* findContact(payload.contactId)
  const database = yield* Database
  const rows = yield* database.query("preferences.topics", (db) =>
    db
      .select({
        id: topics.id,
        name: topics.name,
        description: topics.description,
        state: subscriptions.state,
      })
      .from(topics)
      .leftJoin(
        subscriptions,
        and(eq(subscriptions.topicId, topics.id), eq(subscriptions.contactId, contact.id)),
      )
      .where(eq(topics.archived, false))
      .orderBy(asc(topics.name))
      .all(),
  )
  const [user, domain] = contact.email.split("@")
  const brand = yield* getBrandSettings()
  return {
    email: `${(user ?? "").slice(0, 2)}${"•".repeat(Math.max(1, (user ?? "").length - 2))}@${domain ?? ""}`,
    unsubscribedFromAll: contact.status === "unsubscribed",
    blocked: isBlocked(contact.status),
    focusTopicId: payload.topicId,
    topics: rows.map(
      (r): PreferenceTopic => ({
        id: r.id,
        name: r.name,
        description: r.description,
        subscribed: r.state === "subscribed",
      }),
    ),
    brand,
  }
})

/**
 * Saves the preference page. Topics ticked stay or become subscribed, with the person's own
 * click as consent; topics unticked are left; "all" unsubscribes from everything.
 */
export const savePreferences = Effect.fn("unsubscribe.save")(function* (
  token: string,
  choice: { readonly subscribed: ReadonlyArray<string>; readonly all: boolean },
) {
  const payload = yield* decode(token)
  const contact = yield* findContact(payload.contactId)
  if (choice.all) {
    yield* unsubscribeAll(contact, "preference page")
    yield* noteUnsubscribe(contact, { topicId: null, campaignId: payload.campaignId }, "preference page")
    return
  }
  const database = yield* Database
  const live = yield* database.query("preferences.live", (db) =>
    db
      .select({ id: topics.id, state: subscriptions.state })
      .from(topics)
      .leftJoin(
        subscriptions,
        and(eq(subscriptions.topicId, topics.id), eq(subscriptions.contactId, contact.id)),
      )
      .where(eq(topics.archived, false))
      .all(),
  )
  const wanted = new Set(choice.subscribed)
  let dropped = false
  for (const t of live) {
    const want = wanted.has(t.id)
    if (want && t.state !== "subscribed" && !isBlocked(contact.status)) {
      yield* writeSubscription(contact, t.id, "subscribed", "preference page")
    } else if (!want && t.state === "subscribed") {
      yield* writeSubscription(contact, t.id, "unsubscribed", "preference page")
      dropped = true
    }
  }
  if (dropped)
    yield* noteUnsubscribe(contact, { topicId: null, campaignId: payload.campaignId }, "preference page")
})

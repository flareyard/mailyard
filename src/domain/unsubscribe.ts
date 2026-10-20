import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { stopRunsFor } from "../automations/runs.ts"
import { Bindings } from "../Bindings.ts"
import type { ConsentEvidence } from "../db/schema.ts"
import { contacts, events, subscriptions, topics } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { customBrandSettings } from "./brand.ts"
import { ConsentTokenInvalid, signConsent, verifyConsent } from "./consent.ts"
import { type ContactRow, findContact, isBlocked, writeSubscription } from "./contacts.ts"
import { parseParty, sendTransactional } from "./outbox.ts"
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

/**
 * Takes a contact off every topic and marks them unsubscribed: what "unsubscribe from all" means.
 * Answers with what it changed, so the preference page can offer to undo it.
 */
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
      yield* stopRunsFor(contact.id, "The contact unsubscribed from everything.")
    }
    return { topicIds: current.map((c) => c.topicId), status: contact.status }
  })

/** A system event on the contact's timeline, which campaign reports count unsubscribes from. */
const noteUnsubscribe = (
  contact: ContactRow,
  payload: { readonly topicId: string | null; readonly campaignId: string | null },
  how: string,
  /** What "unsubscribe from all" removed, kept so a resubscribe can put it back (HAL-3377). */
  restore?: { readonly topicIds: ReadonlyArray<string>; readonly status: string },
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
          data: {
            topicId: payload.topicId,
            campaignId: payload.campaignId,
            how,
            ...(restore ? { restore } : {}),
          },
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
  const brand = yield* customBrandSettings()
  const undo = contact.status === "unsubscribed" ? yield* lastUndoable(contact.id) : null
  return {
    email: `${(user ?? "").slice(0, 2)}${"•".repeat(Math.max(1, (user ?? "").length - 2))}@${domain ?? ""}`,
    unsubscribedFromAll: contact.status === "unsubscribed",
    /** Until when "unsubscribe from everything" can still be undone from this page; null when it can't. */
    resubscribeUntil: undo ? undo.until : null,
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
  /** The request that saved the page (HAL-3426), kept with each opt-in. */
  evidence?: ConsentEvidence | undefined,
) {
  const payload = yield* decode(token)
  const contact = yield* findContact(payload.contactId)
  if (choice.all) {
    const removed = yield* unsubscribeAll(contact, "preference page")
    yield* noteUnsubscribe(
      contact,
      { topicId: null, campaignId: payload.campaignId },
      "preference page",
      removed,
    )
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
      yield* writeSubscription(contact, t.id, "subscribed", "preference page", evidence)
    } else if (!want && t.state === "subscribed") {
      yield* writeSubscription(contact, t.id, "unsubscribed", "preference page")
      dropped = true
    }
  }
  if (dropped)
    yield* noteUnsubscribe(contact, { topicId: null, campaignId: payload.campaignId }, "preference page")
})

/** How long after "unsubscribe from everything" the preference page offers to undo it. */
export const RESUBSCRIBE_WINDOW_MS = 24 * 60 * 60_000

type Restore = { readonly topicIds: ReadonlyArray<string>; readonly status: string }

/** The contact's latest unsubscribe, when it was "from everything" on this page, recently enough to undo. */
const lastUndoable = (contactId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const last = yield* database.query("unsubscribe.lastEvent", (db) =>
      db
        .select({ name: events.name, data: events.data, at: events.at })
        .from(events)
        .where(
          and(
            eq(events.contactId, contactId),
            inArray(events.name, ["email.unsubscribed", "email.resubscribed"]),
          ),
        )
        .orderBy(desc(events.at))
        .limit(1)
        .get(),
    )
    const restore = (last?.data as { restore?: Restore } | null | undefined)?.restore
    if (!last || last.name !== "email.unsubscribed" || !restore) return null
    const until = last.at + RESUBSCRIBE_WINDOW_MS
    return until > Date.now() ? { restore, until } : null
  })

/**
 * Undoes "unsubscribe from everything" within the window: the topics it removed are subscribed
 * again, by the person's own click, and the contact is mailable again. Past the window, or with
 * nothing to undo, it fails and the page says to choose topics instead.
 */
export const resubscribe = Effect.fn("unsubscribe.resubscribe")(function* (token: string) {
  const payload = yield* decode(token)
  const contact = yield* findContact(payload.contactId)
  if (isBlocked(contact.status)) return yield* new ResubscribeUnavailable({ reason: "blocked" })
  const undo = contact.status === "unsubscribed" ? yield* lastUndoable(contact.id) : null
  if (!undo) return yield* new ResubscribeUnavailable({ reason: "expired" })
  const database = yield* Database
  const live = undo.restore.topicIds.length
    ? yield* database.query("unsubscribe.restoreTopics", (db) =>
        db
          .select({ id: topics.id })
          .from(topics)
          // d1: bounded: the topics one contact was on, which people create by hand.
          .where(and(inArray(topics.id, [...undo.restore.topicIds]), eq(topics.archived, false)))
          .all(),
      )
    : []
  for (const t of live) yield* writeSubscription(contact, t.id, "subscribed", "preference page (undo)")
  if (live.length === 0 && undo.restore.status === "subscribed")
    yield* database.query("unsubscribe.restoreStatus", (db) =>
      db.update(contacts).set({ status: "subscribed" }).where(eq(contacts.id, contact.id)).run(),
    )
  const id = yield* (yield* Ids).next
  yield* database.query("unsubscribe.resubscribedEvent", (db) =>
    db
      .insert(events)
      .values({
        id,
        contactId: contact.id,
        name: "email.resubscribed",
        data: { topicIds: live.map((t) => t.id), how: "preference page" },
        at: Date.now(),
      })
      .run(),
  )
  return { restored: live.length }
})

export class ResubscribeUnavailable extends Schema.TaggedError<ResubscribeUnavailable>()(
  "ResubscribeUnavailable",
  { reason: Schema.Literals(["expired", "blocked"]) },
) {}

/**
 * `POST /p/request`: mails a fresh preference link to an address on the list, for someone whose
 * link no longer works. At most one a contact an hour (the idempotency key), and the caller is told
 * the same thing whether or not the address is known, so it can't be used to probe the list.
 */
export const requestPreferencesLink = Effect.fn("unsubscribe.requestLink")(function* (
  email: string,
  origin: string,
) {
  const address = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) return { sent: false }
  const database = yield* Database
  const contact = yield* database.query("unsubscribe.byEmail", (db) =>
    db.select().from(contacts).where(eq(contacts.email, address)).get(),
  )
  if (!contact || isBlocked(contact.status)) return { sent: false }
  const token = yield* unsubscribeToken({ contactId: contact.id, topicId: null, campaignId: null })
  const url = unsubscribeUrl(origin, token)
  const hour = Math.floor(Date.now() / 3_600_000)
  // From whoever they hear from: DEFAULT_FROM, else the sender of a list they're on, else any list's.
  const env = yield* Bindings
  const theirs = env.DEFAULT_FROM
    ? undefined
    : yield* database.query("unsubscribe.linkSender", (db) =>
        db
          .select({ sender: topics.sender })
          .from(topics)
          .leftJoin(
            subscriptions,
            and(eq(subscriptions.topicId, topics.id), eq(subscriptions.contactId, contact.id)),
          )
          .where(isNotNull(topics.sender))
          .orderBy(desc(subscriptions.contactId))
          .limit(1)
          .get(),
      )
  const sent = yield* sendTransactional({
    ...(theirs?.sender ? { from: parseParty(theirs.sender) } : {}),
    recipients: [{ email: contact.email, ...(contact.name ? { name: contact.name } : {}) }],
    subject: "Your email preferences link",
    body: `<p>Someone asked for a new link to manage the emails sent to this address. If it was you, use it here:</p><p><a href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Manage your email preferences</a></p><p>If you didn't ask, ignore this message; nothing has changed.</p>`,
    apiKeyId: "system",
    idempotencyKey: `prefs-link:${contact.id}:${hour}`,
  }).pipe(
    Effect.as(true),
    // No sender configured, or the send refused: the answer to the caller doesn't change.
    Effect.catchCause((cause) =>
      Effect.logWarning("preferences link not sent", cause).pipe(Effect.as(false)),
    ),
  )
  return { sent }
})

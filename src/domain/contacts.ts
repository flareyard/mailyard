import { and, asc, count, desc, eq, inArray, like, or, type SQL, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { fireTrigger, stopRunsFor } from "../automations/runs.ts"
import {
  automationRuns,
  automations,
  contactFields,
  contacts,
  events,
  inboundMessages,
  messagesOut,
  segments,
  subscriptionChanges,
  subscriptions,
  suppressions,
  topics,
} from "../db/schema.ts"
import { BlobStore, Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { recordAudit } from "./audit.ts"
import { sha256 } from "./crypto.ts"
import { emitSafely } from "./webhooks.ts"

export type ContactRow = typeof contacts.$inferSelect
export type ContactStatus = ContactRow["status"]
export type SubscriptionState = (typeof subscriptions.$inferSelect)["state"]

export class ContactNotFound extends Schema.TaggedError<ContactNotFound>()("ContactNotFound", {
  id: Schema.String,
}) {}
export class ContactInvalid extends Schema.TaggedError<ContactInvalid>()("ContactInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
export class ContactConflict extends Schema.TaggedError<ContactConflict>()("ContactConflict", {
  message: Schema.String,
}) {}

/** Statuses that come from delivery (a bounce, a complaint, the suppression list): only lifting the suppression clears them. */
const BLOCKED: ReadonlyArray<ContactStatus> = ["bounced", "complained", "suppressed"]
export const isBlocked = (status: ContactStatus) => BLOCKED.includes(status)

/** An address with a local part, an @ and a domain with a dot; deliverability is the sender's job. */
export const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/
export const normalizeEmail = (email: string) => email.trim().toLowerCase()

const DAY = 86_400_000
/** Engagement windows: a contact engaged within 30 days is active, within 90 cooling, else dormant. */
export const ENGAGEMENT_DAYS = { active: 30, cooling: 90 } as const
export type Engagement = "active" | "cooling" | "dormant"

/** The latest open, click or tracked event. Sends don't count: being mailed isn't engaging. */
export const lastEngagedAt = (c: Pick<ContactRow, "lastEventAt" | "lastOpenedAt" | "lastClickedAt">) => {
  const times = [c.lastEventAt, c.lastOpenedAt, c.lastClickedAt].filter((t): t is number => t !== null)
  return times.length ? Math.max(...times) : null
}

export const engagementOf = (c: Parameters<typeof lastEngagedAt>[0], now = Date.now()): Engagement => {
  const last = lastEngagedAt(c)
  if (last === null) return "dormant"
  const age = now - last
  if (age <= ENGAGEMENT_DAYS.active * DAY) return "active"
  if (age <= ENGAGEMENT_DAYS.cooling * DAY) return "cooling"
  return "dormant"
}

/** The same rule in SQL, so lists filter on it in D1 rather than in the Worker. */
const engagedAtSql = sql`max(coalesce(${contacts.lastEventAt}, 0), coalesce(${contacts.lastOpenedAt}, 0), coalesce(${contacts.lastClickedAt}, 0))`
const engagementSql = (engagement: Engagement, now: number): SQL => {
  const active = now - ENGAGEMENT_DAYS.active * DAY
  const cooling = now - ENGAGEMENT_DAYS.cooling * DAY
  if (engagement === "active") return sql`${engagedAtSql} >= ${active}`
  if (engagement === "cooling") return sql`(${engagedAtSql} < ${active} and ${engagedAtSql} >= ${cooling})`
  return sql`${engagedAtSql} < ${cooling}`
}

/**
 * Splits request `data` the way Plunk does: plain values are saved on the contact; values written as
 * `{ value, persistent: false }` are used for this request only (a reset code, an order id).
 */
export const splitData = (data: Readonly<Record<string, unknown>> | undefined) => {
  const persistent: Record<string, unknown> = {}
  const transient: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data ?? {})) {
    if (
      value !== null &&
      typeof value === "object" &&
      "persistent" in value &&
      (value as { persistent: unknown }).persistent === false &&
      "value" in value
    ) {
      transient[key] = (value as { value: unknown }).value
    } else {
      persistent[key] = value
    }
  }
  return { persistent, transient }
}

/**
 * Creates or updates a contact by email. `subscribed` changes the status only when given; a new
 * contact otherwise starts as `whenNew` (unsubscribed for transactional sends, subscribed for
 * tracked events, matching Plunk; unconfirmed for a form awaiting double opt-in).
 */
export const upsertContact = Effect.fn("contacts.upsert")(function* (input: {
  readonly email: string
  readonly name?: string | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
  readonly subscribed?: boolean | undefined
  readonly whenNew: "subscribed" | "unsubscribed" | "unconfirmed"
  /** A tracked event counts as engagement; a send or a form does not. */
  readonly engaged?: boolean | undefined
}) {
  const database = yield* Database
  const ids = yield* Ids
  const email = normalizeEmail(input.email)
  const { persistent, transient } = splitData(input.data)
  const now = Date.now()
  const existing = yield* database.query("contacts.find", (db) =>
    db.select().from(contacts).where(eq(contacts.email, email)).get(),
  )
  const explicit =
    input.subscribed === undefined
      ? undefined
      : input.subscribed
        ? ("subscribed" as const)
        : ("unsubscribed" as const)
  if (existing) {
    const fields = { ...existing.fields, ...persistent }
    // A bounced, complained or suppressed contact stays that way: a send must not quietly resubscribe them.
    const status = explicit && !isBlocked(existing.status) ? explicit : existing.status
    const name = input.name ?? existing.name
    const updated = yield* database.query("contacts.update", (db) =>
      db
        .update(contacts)
        .set({
          fields,
          status,
          name,
          lastActivityAt: now,
          ...(input.engaged ? { lastEventAt: now } : {}),
        })
        .where(eq(contacts.id, existing.id))
        .returning()
        .get(),
    )
    return { contact: updated, merged: { ...fields, ...transient }, created: false }
  }
  const id = yield* ids.next
  const created = yield* database.query("contacts.insert", (db) =>
    db
      .insert(contacts)
      .values({
        id,
        email,
        name: input.name ?? null,
        fields: persistent,
        status: explicit ?? input.whenNew,
        lastActivityAt: now,
        lastEventAt: input.engaged ? now : null,
      })
      .returning()
      .get(),
  )
  yield* emitSafely("contact.created", {
    contactId: created.id,
    email: created.email,
    status: created.status,
  })
  yield* fireTrigger({ kind: "created", contactId: created.id })
  return { contact: created, merged: { ...persistent, ...transient }, created: true }
})

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

type Membership = {
  readonly topicId: string
  readonly name: string
  readonly state: SubscriptionState
  /** When the state last changed, how (form, import, api, unsubscribe link…), and the consent on record. */
  readonly changedAt?: number
  readonly source?: string
  readonly confirmedAt?: number | null
}

export const membershipsOf = (contactIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (contactIds.length === 0) return new Map<string, Array<Membership>>()
    const database = yield* Database
    const rows = yield* database.query("contacts.memberships", (db) =>
      db
        .select({
          contactId: subscriptions.contactId,
          topicId: subscriptions.topicId,
          name: topics.name,
          state: subscriptions.state,
          changedAt: subscriptions.changedAt,
          source: subscriptions.source,
          confirmedAt: subscriptions.confirmedAt,
        })
        .from(subscriptions)
        .innerJoin(topics, eq(topics.id, subscriptions.topicId))
        .where(inArray(subscriptions.contactId, [...contactIds]))
        .all(),
    )
    const byContact = new Map<string, Array<Membership>>()
    for (const r of rows) {
      const list = byContact.get(r.contactId) ?? []
      list.push({
        topicId: r.topicId,
        name: r.name,
        state: r.state,
        changedAt: r.changedAt,
        source: r.source,
        confirmedAt: r.confirmedAt,
      })
      byContact.set(r.contactId, list)
    }
    return byContact
  })

export const describeContact = (c: ContactRow, memberships: ReadonlyArray<Membership>, now = Date.now()) => ({
  id: c.id,
  email: c.email,
  name: c.name,
  status: c.status,
  fields: c.fields,
  topics: [...memberships].sort((a, b) => a.name.localeCompare(b.name)),
  engagement: engagementOf(c, now),
  lastActivityAt: c.lastActivityAt,
  lastEventAt: c.lastEventAt,
  lastOpenedAt: c.lastOpenedAt,
  lastClickedAt: c.lastClickedAt,
  createdAt: c.createdAt,
})
export type ContactView = ReturnType<typeof describeContact>

export const findContact = Effect.fn("contacts.findById")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("contacts.get", (db) =>
    db.select().from(contacts).where(eq(contacts.id, id)).get(),
  )
  if (!row) return yield* new ContactNotFound({ id })
  return row
})

export const getContact = Effect.fn("contacts.get")(function* (id: string) {
  const row = yield* findContact(id)
  const memberships = yield* membershipsOf([id])
  const database = yield* Database
  // Why mail to this contact is held back, if it is (HAL-3422).
  const s = yield* database.query("contacts.suppression", (db) =>
    db.select().from(suppressions).where(eq(suppressions.email, row.email)).get(),
  )
  return {
    ...describeContact(row, memberships.get(id) ?? []),
    suppression: s
      ? {
          reason: s.reason,
          source: s.source,
          detail: s.note,
          messageId: s.messageId,
          bulkOnly: s.bulkOnly,
          createdAt: s.at,
          cloudflare: { synced: s.syncedToCloudflare, id: s.cloudflareId, checkedAt: s.cloudflareCheckedAt },
        }
      : null,
  }
})

export const CONTACT_SORTS = [
  "createdAt",
  "-createdAt",
  "email",
  "-email",
  "lastActivityAt",
  "-lastActivityAt",
] as const
export type ContactSort = (typeof CONTACT_SORTS)[number]

export interface ContactQuery {
  readonly q?: string | undefined
  /** One status, several, or a comma list of them: any matches. */
  readonly status?: ContactStatus | ReadonlyArray<ContactStatus> | string | undefined
  readonly topicId?: string | undefined
  readonly engagement?: Engagement | ReadonlyArray<Engagement> | string | undefined
  readonly sort?: ContactSort | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

const sortColumn = (sort: ContactSort) => {
  const field = sort.replace(/^-/, "") as "createdAt" | "email" | "lastActivityAt"
  if (field === "email")
    return { expr: sql`${contacts.email}`, of: (c: ContactRow) => c.email as string | number }
  if (field === "lastActivityAt") {
    return {
      expr: sql`coalesce(${contacts.lastActivityAt}, 0)`,
      of: (c: ContactRow) => c.lastActivityAt ?? 0,
    }
  }
  return { expr: sql`${contacts.createdAt}`, of: (c: ContactRow) => c.createdAt }
}

/** Cursors are opaque to callers: the last row's sort value and id, as base64url JSON. */
const encodeCursor = (value: string | number, id: string) =>
  btoa(JSON.stringify([value, id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
const decodeCursor = (cursor: string) =>
  Effect.try({
    try: () => {
      const parsed = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as unknown
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        !["string", "number"].includes(typeof parsed[0]) ||
        typeof parsed[1] !== "string"
      )
        throw new Error("bad cursor")
      return { value: parsed[0] as string | number, id: parsed[1] as string }
    },
    catch: () => new ContactInvalid({ field: "cursor", message: "The cursor isn't one this API returned." }),
  })

const listOf = <T extends string>(value: T | ReadonlyArray<T> | string | undefined): ReadonlyArray<T> =>
  value === undefined
    ? []
    : typeof value === "string"
      ? (value.split(",").filter(Boolean) as Array<T>)
      : value
const statusesOf = (v: ContactQuery["status"]) => [...new Set(listOf<ContactStatus>(v))]
const engagementsOf = (v: ContactQuery["engagement"]) => [...new Set(listOf<Engagement>(v))]

/** The filters a list applies, shared by the page query and the filtered count. */
export const filterOf = (query: ContactQuery, now: number): SQL | undefined => {
  const q = query.q?.trim().toLowerCase()
  return and(
    q ? or(like(contacts.email, `%${q}%`), like(sql`lower(${contacts.name})`, `%${q}%`)) : undefined,
    statusesOf(query.status).length ? inArray(contacts.status, statusesOf(query.status)) : undefined,
    query.topicId
      ? sql`exists (select 1 from ${subscriptions} where ${subscriptions.contactId} = ${contacts.id} and ${subscriptions.topicId} = ${query.topicId} and ${subscriptions.state} = 'subscribed')`
      : undefined,
    engagementsOf(query.engagement).length
      ? or(...engagementsOf(query.engagement).map((e) => engagementSql(e, now)))
      : undefined,
  )
}

/** A page of contacts plus the total and the count matching the filters, for the list's header. */
export const listContacts = Effect.fn("contacts.list")(function* (query: ContactQuery, extra?: SQL) {
  const database = yield* Database
  const now = Date.now()
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const sort = query.sort ?? "-createdAt"
  const descending = sort.startsWith("-")
  const column = sortColumn(sort)
  const filter = and(filterOf(query, now), extra)
  const cursor = query.cursor ? yield* decodeCursor(query.cursor) : undefined
  const after = cursor
    ? descending
      ? sql`(${column.expr} < ${cursor.value} or (${column.expr} = ${cursor.value} and ${contacts.id} < ${cursor.id}))`
      : sql`(${column.expr} > ${cursor.value} or (${column.expr} = ${cursor.value} and ${contacts.id} > ${cursor.id}))`
    : undefined
  const rows = yield* database.query("contacts.page", (db) =>
    db
      .select()
      .from(contacts)
      .where(and(filter, after))
      .orderBy(
        descending ? desc(column.expr) : asc(column.expr),
        descending ? desc(contacts.id) : asc(contacts.id),
      )
      .limit(limit + 1)
      .all(),
  )
  const [totals] = yield* database.query("contacts.counts", (db) =>
    db
      .select({
        total: sql<number>`(select count(*) from ${contacts})`,
        matching: count(),
      })
      .from(contacts)
      .where(filter)
      .all(),
  )
  const page = rows.slice(0, limit)
  const memberships = yield* membershipsOf(page.map((c) => c.id))
  const last = page.at(-1)
  return {
    contacts: page.map((c) => describeContact(c, memberships.get(c.id) ?? [], now)),
    total: totals?.total ?? 0,
    count: totals?.matching ?? 0,
    nextCursor: rows.length > limit && last ? encodeCursor(column.of(last), last.id) : null,
  }
})

export const TIMELINE_KINDS = [
  "event",
  "message",
  "delivery",
  "subscription",
  "consent",
  "reply",
  "automation",
] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]

export type TimelineItem =
  | {
      readonly kind: "event"
      readonly id: string
      readonly at: number
      readonly name: string
      readonly data: Record<string, unknown> | null
    }
  | {
      readonly kind: "message"
      readonly id: string
      readonly at: number
      readonly stream: string
      readonly subject: string
      readonly status: string
      readonly bounceType: string | null
      readonly campaignId: string | null
    }
  | {
      /** What happened to a message after it was sent: delivered, opened, clicked, bounced, complained… */
      readonly kind: "delivery"
      readonly id: string
      readonly at: number
      readonly event: string
      readonly messageId: string | null
      readonly subject: string | null
      readonly data: Record<string, unknown> | null
    }
  | {
      readonly kind: "subscription"
      readonly id: string
      readonly at: number
      readonly topicId: string
      readonly topic: string
      readonly from: SubscriptionState | null
      readonly to: SubscriptionState
      readonly source: string
    }
  | {
      /** The contact confirmed a double opt-in: the consent on record. */
      readonly kind: "consent"
      readonly id: string
      readonly at: number
      readonly topicId: string
      readonly topic: string
      readonly source: string
    }
  | {
      /** Mail they sent in. */
      readonly kind: "reply"
      readonly id: string
      readonly at: number
      readonly subject: string | null
      readonly to: string
      readonly inReplyTo: string | null
    }
  | {
      readonly kind: "automation"
      readonly id: string
      readonly at: number
      readonly automationId: string
      readonly automation: string | null
      readonly state: string
      readonly finishedAt: number | null
    }

/**
 * Everything that happened to a contact, newest first (HAL-3422): tracked events, mail sent to them
 * and what happened to it, subscription changes and the consent on record, mail they sent in, and the
 * automations they went through. Paged by time across all of them; `kinds` narrows it.
 */
export const contactTimeline = Effect.fn("contacts.timeline")(function* (
  id: string,
  options: {
    readonly cursor?: string | undefined
    readonly limit?: number | undefined
    readonly kind?: string | undefined
  },
) {
  const database = yield* Database
  const contact = yield* findContact(id)
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ? yield* decodeCursor(options.cursor) : undefined
  const before = cursor ? Number(cursor.value) : Number.MAX_SAFE_INTEGER
  const tie = cursor?.id ?? "\uffff"
  const wanted = new Set<TimelineKind>(
    options.kind
      ? (options.kind
          .split(",")
          .filter((k) => (TIMELINE_KINDS as ReadonlyArray<string>).includes(k)) as Array<TimelineKind>)
      : TIMELINE_KINDS,
  )
  const want = (...kinds: Array<TimelineKind>) => kinds.some((k) => wanted.has(k))
  const olderThan = <T extends { at: unknown; id: unknown }>(at: T["at"], rowId: T["id"]) =>
    sql`(${at} < ${before} or (${at} = ${before} and ${rowId} < ${tie}))`
  const none = Effect.succeed([] as Array<never>)
  // Delivery and open events are recorded as `email.*` events; the rest are the contact's own.
  const emailEvents = want("event") && want("delivery") ? undefined : want("delivery")
  const [eventRows, messageRows, changeRows, replyRows, runRows] = yield* Effect.all(
    [
      want("event", "delivery")
        ? database.query("contacts.timeline.events", (db) =>
            db
              .select()
              .from(events)
              .where(
                and(
                  eq(events.contactId, id),
                  olderThan(events.at, events.id),
                  emailEvents === undefined
                    ? undefined
                    : emailEvents
                      ? like(events.name, "email.%")
                      : sql`${events.name} not like 'email.%'`,
                ),
              )
              .orderBy(desc(events.at), desc(events.id))
              .limit(limit)
              .all(),
          )
        : none,
      want("message")
        ? database.query("contacts.timeline.messages", (db) =>
            db
              .select()
              .from(messagesOut)
              .where(
                and(
                  or(eq(messagesOut.contactId, id), eq(messagesOut.recipient, contact.email)),
                  olderThan(messagesOut.createdAt, messagesOut.id),
                ),
              )
              .orderBy(desc(messagesOut.createdAt), desc(messagesOut.id))
              .limit(limit)
              .all(),
          )
        : none,
      want("subscription", "consent")
        ? database.query("contacts.timeline.subscriptions", (db) =>
            db
              .select({ change: subscriptionChanges, topic: topics.name })
              .from(subscriptionChanges)
              .innerJoin(topics, eq(topics.id, subscriptionChanges.topicId))
              .where(
                and(
                  eq(subscriptionChanges.contactId, id),
                  olderThan(subscriptionChanges.at, subscriptionChanges.id),
                ),
              )
              .orderBy(desc(subscriptionChanges.at), desc(subscriptionChanges.id))
              .limit(limit)
              .all(),
          )
        : none,
      want("reply")
        ? database.query("contacts.timeline.replies", (db) =>
            db
              .select({
                id: inboundMessages.id,
                at: inboundMessages.receivedAt,
                subject: inboundMessages.subject,
                to: inboundMessages.envelopeTo,
                inReplyTo: inboundMessages.inReplyTo,
              })
              .from(inboundMessages)
              .where(
                and(
                  eq(inboundMessages.fromAddress, contact.email),
                  olderThan(inboundMessages.receivedAt, inboundMessages.id),
                ),
              )
              .orderBy(desc(inboundMessages.receivedAt), desc(inboundMessages.id))
              .limit(limit)
              .all(),
          )
        : none,
      want("automation")
        ? database.query("contacts.timeline.automations", (db) =>
            db
              .select({ run: automationRuns, name: automations.name })
              .from(automationRuns)
              .leftJoin(automations, eq(automations.id, automationRuns.automationId))
              .where(
                and(eq(automationRuns.contactId, id), olderThan(automationRuns.startedAt, automationRuns.id)),
              )
              .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
              .limit(limit)
              .all(),
          )
        : none,
    ],
    { concurrency: "unbounded" },
  )
  const items: Array<TimelineItem> = [
    ...eventRows.flatMap((e): Array<TimelineItem> => {
      const isEmail = e.name.startsWith("email.")
      if (isEmail && wanted.has("delivery")) {
        const data = (e.data ?? null) as Record<string, unknown> | null
        return [
          {
            kind: "delivery",
            id: e.id,
            at: e.at,
            event: e.name.slice("email.".length),
            messageId: typeof data?.messageId === "string" ? data.messageId : null,
            subject: typeof data?.subject === "string" ? data.subject : null,
            data,
          },
        ]
      }
      if (!isEmail && wanted.has("event"))
        return [{ kind: "event", id: e.id, at: e.at, name: e.name, data: e.data ?? null }]
      return []
    }),
    ...messageRows.map((m) => ({
      kind: "message" as const,
      id: m.id,
      at: m.createdAt,
      stream: m.stream,
      subject: m.subject,
      status: m.status,
      bounceType: m.bounceType,
      campaignId: m.campaignId,
    })),
    ...changeRows.flatMap(({ change, topic }): Array<TimelineItem> => {
      const out: Array<TimelineItem> = []
      if (wanted.has("subscription"))
        out.push({
          kind: "subscription",
          id: change.id,
          at: change.at,
          topicId: change.topicId,
          topic,
          from: change.from,
          to: change.to,
          source: change.source,
        })
      // A double opt-in confirmed: unconfirmed to subscribed.
      if (wanted.has("consent") && change.from === "unconfirmed" && change.to === "subscribed")
        out.push({
          kind: "consent",
          id: `${change.id}:consent`,
          at: change.at,
          topicId: change.topicId,
          topic,
          source: change.source,
        })
      return out
    }),
    ...replyRows.map((r) => ({
      kind: "reply" as const,
      id: r.id,
      at: r.at,
      subject: r.subject,
      to: r.to,
      inReplyTo: r.inReplyTo,
    })),
    ...runRows.map(({ run, name }) => ({
      kind: "automation" as const,
      id: run.id,
      at: run.startedAt,
      automationId: run.automationId,
      automation: name ?? null,
      state: run.state,
      finishedAt: run.finishedAt,
    })),
  ].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const page = items.slice(0, limit)
  const last = page.at(-1)
  return { items: page, nextCursor: items.length > limit && last ? encodeCursor(last.at, last.id) : null }
})

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/** Fields are a flat map of JSON values, at most 50 keys of up to 64 characters. */
const checkFields = (fields: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const keys = Object.keys(fields)
    if (keys.length > 50)
      return yield* new ContactInvalid({ field: "fields", message: "At most 50 custom fields." })
    for (const key of keys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
        return yield* new ContactInvalid({
          field: `fields.${key}`,
          message: "Field names are letters, digits and underscores, starting with a letter or underscore.",
        })
      }
    }
  })

export const createContact = Effect.fn("contacts.create")(function* (
  input: {
    readonly email: string
    readonly name?: string | null | undefined
    readonly fields?: Readonly<Record<string, unknown>> | undefined
    readonly status?: "subscribed" | "unsubscribed" | undefined
  },
  actor: string,
) {
  const database = yield* Database
  const email = normalizeEmail(input.email)
  if (!EMAIL.test(email))
    return yield* new ContactInvalid({ field: "email", message: "Not an email address." })
  yield* checkFields(input.fields ?? {})
  const exists = yield* database.query("contacts.exists", (db) =>
    db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, email)).get(),
  )
  if (exists)
    return yield* new ContactConflict({ message: `A contact with ${email} already exists (${exists.id}).` })
  const suppressed = yield* database.query("contacts.suppressedCheck", (db) =>
    db.select({ email: suppressions.email }).from(suppressions).where(eq(suppressions.email, email)).get(),
  )
  const id = yield* (yield* Ids).next
  const row = yield* database.query("contacts.create", (db) =>
    db
      .insert(contacts)
      .values({
        id,
        email,
        name: input.name ?? null,
        fields: { ...input.fields },
        // A suppressed address joins as suppressed, whatever was asked: mail to it would bounce again.
        status: suppressed ? "suppressed" : (input.status ?? "unsubscribed"),
      })
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "contact.create", target: id, after: { email, status: row.status } })
  yield* emitSafely("contact.created", { contactId: id, email, status: row.status })
  yield* fireTrigger({ kind: "created", contactId: id })
  return describeContact(row, [])
})

/** Changes name, fields (merged; a null value removes the key) or status. */
export const updateContact = Effect.fn("contacts.update")(function* (
  id: string,
  input: {
    readonly name?: string | null | undefined
    readonly fields?: Readonly<Record<string, unknown>> | undefined
    readonly status?: "subscribed" | "unsubscribed" | undefined
  },
  actor: string,
) {
  const database = yield* Database
  const before = yield* findContact(id)
  if (input.status && isBlocked(before.status)) {
    return yield* new ContactInvalid({
      field: "status",
      message: `This contact is ${before.status}; remove the address from the suppression list before changing it.`,
    })
  }
  const fields = { ...before.fields }
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (value === null) delete fields[key]
    else fields[key] = value
  }
  yield* checkFields(fields)
  const row = yield* database.query("contacts.patch", (db) =>
    db
      .update(contacts)
      .set({
        fields,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status ? { status: input.status } : {}),
      })
      .where(eq(contacts.id, id))
      .returning()
      .get(),
  )
  const after = row ?? before
  yield* recordAudit({ actor, action: "contact.update", target: id, before, after })
  yield* emitSafely("contact.updated", { contactId: id, email: after.email, status: after.status })
  if (input.status === "unsubscribed" && before.status !== "unsubscribed") {
    yield* emitSafely("contact.unsubscribed", { contactId: id, email: after.email, source: "api" })
    yield* stopRunsFor(id, "The contact unsubscribed.")
  }
  // A changed contact may have come into a segment an automation starts from.
  yield* fireTrigger({ kind: "segment", contactId: id })
  return yield* getContact(id)
})

/**
 * Records a contact's new state for a topic, and its change log. Subscribing also makes the
 * contact subscribed overall, unless delivery has blocked them.
 */
export const writeSubscription = Effect.fn("contacts.writeSubscription")(function* (
  contact: ContactRow,
  topicId: string,
  to: SubscriptionState,
  source: string,
) {
  const database = yield* Database
  const now = Date.now()
  const current = yield* database.query("subscriptions.get", (db) =>
    db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.contactId, contact.id), eq(subscriptions.topicId, topicId)))
      .get(),
  )
  if (current?.state === to) return { changed: false, from: to }
  yield* database.query("subscriptions.upsert", (db) =>
    db
      .insert(subscriptions)
      .values({ contactId: contact.id, topicId, state: to, source, changedAt: now })
      .onConflictDoUpdate({
        target: [subscriptions.contactId, subscriptions.topicId],
        set: { state: to, source, changedAt: now },
      })
      .run(),
  )
  const changeId = yield* (yield* Ids).next
  yield* database.query("subscriptionChanges.insert", (db) =>
    db
      .insert(subscriptionChanges)
      .values({
        id: changeId,
        contactId: contact.id,
        topicId,
        from: current?.state ?? null,
        to,
        source,
        at: now,
      })
      .run(),
  )
  if (to === "subscribed" && !isBlocked(contact.status) && contact.status !== "subscribed") {
    yield* database.query("contacts.markSubscribed", (db) =>
      db.update(contacts).set({ status: "subscribed" }).where(eq(contacts.id, contact.id)).run(),
    )
  }
  if (to === "subscribed") {
    yield* emitSafely("contact.subscribed", { contactId: contact.id, email: contact.email, topicId, source })
    yield* fireTrigger({ kind: "topic", contactId: contact.id, key: topicId })
  } else if (to === "unsubscribed") {
    yield* emitSafely("contact.unsubscribed", {
      contactId: contact.id,
      email: contact.email,
      topicId,
      source,
    })
  }
  return { changed: true, from: current?.state ?? null }
})

/** Removes contacts and everything that hangs off them; the delivery log keeps its rows. */
export const deleteContacts = Effect.fn("contacts.delete")(function* (
  ids: ReadonlyArray<string>,
  actor: string,
) {
  if (ids.length === 0) return 0
  const database = yield* Database
  // D1 binds at most 100 parameters a statement, so long lists go in chunks.
  const rows: Array<{ id: string; email: string }> = []
  for (const chunk of chunksOf([...ids], D1_MAX_PARAMS)) {
    rows.push(
      ...(yield* database.query("contacts.forDelete", (db) =>
        db
          .select({ id: contacts.id, email: contacts.email })
          .from(contacts)
          .where(inArray(contacts.id, chunk))
          .all(),
      )),
    )
  }
  if (rows.length === 0) return 0
  for (const chunk of chunksOf(
    rows.map((r) => r.id),
    D1_MAX_PARAMS,
  ))
    yield* database.query("contacts.deleteMany", (db) =>
      db.delete(contacts).where(inArray(contacts.id, chunk)).run(),
    )
  for (const r of rows) {
    yield* recordAudit({ actor, action: "contact.delete", target: r.id })
    yield* emitSafely("contact.deleted", { contactId: r.id, email: r.email })
  }
  return rows.length
})

/** Everything Mailyard holds about one contact, for a data subject access request. */
export const exportContact = Effect.fn("contacts.export")(function* (id: string) {
  const database = yield* Database
  const contact = yield* findContact(id)
  const [subs, changes, eventRows, messages, suppression] = yield* Effect.all(
    [
      database.query("export.subscriptions", (db) =>
        db
          .select({
            topicId: subscriptions.topicId,
            topic: topics.name,
            state: subscriptions.state,
            source: subscriptions.source,
            changedAt: subscriptions.changedAt,
          })
          .from(subscriptions)
          .innerJoin(topics, eq(topics.id, subscriptions.topicId))
          .where(eq(subscriptions.contactId, id))
          .all(),
      ),
      database.query("export.changes", (db) =>
        db
          .select()
          .from(subscriptionChanges)
          .where(eq(subscriptionChanges.contactId, id))
          .orderBy(asc(subscriptionChanges.at))
          .all(),
      ),
      database.query("export.events", (db) =>
        db.select().from(events).where(eq(events.contactId, id)).orderBy(asc(events.at)).all(),
      ),
      database.query("export.messages", (db) =>
        db
          .select({
            id: messagesOut.id,
            stream: messagesOut.stream,
            sender: messagesOut.sender,
            subject: messagesOut.subject,
            status: messagesOut.status,
            campaignId: messagesOut.campaignId,
            createdAt: messagesOut.createdAt,
          })
          .from(messagesOut)
          .where(or(eq(messagesOut.contactId, id), eq(messagesOut.recipient, contact.email)))
          .orderBy(asc(messagesOut.createdAt))
          .all(),
      ),
      database.query("export.suppression", (db) =>
        db.select().from(suppressions).where(eq(suppressions.email, contact.email)).get(),
      ),
    ],
    { concurrency: "unbounded" },
  )
  return {
    exportedAt: new Date().toISOString(),
    contact: {
      id: contact.id,
      email: contact.email,
      name: contact.name,
      status: contact.status,
      fields: contact.fields,
      createdAt: contact.createdAt,
      lastActivityAt: contact.lastActivityAt,
      lastOpenedAt: contact.lastOpenedAt,
      lastClickedAt: contact.lastClickedAt,
    },
    subscriptions: subs,
    subscriptionChanges: changes.map((c) => ({
      topicId: c.topicId,
      from: c.from,
      to: c.to,
      source: c.source,
      at: c.at,
    })),
    events: eventRows.map((e) => ({ name: e.name, data: e.data, at: e.at })),
    messages,
    suppression: suppression
      ? { reason: suppression.reason, source: suppression.source, at: suppression.at }
      : null,
  }
})

/**
 * Erasure (GDPR article 17). The contact, its events and subscriptions go; delivery-log rows keep
 * their counts but lose the address, the subject and the stored copy. A suppression stays, keyed
 * by the address, because forgetting it would let the next import mail them again.
 */
export const eraseContact = Effect.fn("contacts.erase")(function* (id: string, actor: string) {
  const database = yield* Database
  const store = yield* BlobStore
  const contact = yield* findContact(id)
  const digest = (yield* Effect.promise(() => sha256(contact.email))).slice(0, 16)
  const logRows = yield* database.query("erase.messages", (db) =>
    db
      .select({ id: messagesOut.id, renderedKey: messagesOut.renderedKey })
      .from(messagesOut)
      .where(or(eq(messagesOut.contactId, id), eq(messagesOut.recipient, contact.email)))
      .all(),
  )
  for (const row of logRows) if (row.renderedKey) yield* store.delete(row.renderedKey)
  if (logRows.length > 0) {
    yield* database.query("erase.scrub", (db) =>
      db
        .update(messagesOut)
        .set({ recipient: `erased:${digest}`, subject: "(erased)", renderedKey: null, contactId: null })
        .where(
          inArray(
            messagesOut.id,
            logRows.map((r) => r.id),
          ),
        )
        .run(),
    )
  }
  yield* database.query("erase.contact", (db) => db.delete(contacts).where(eq(contacts.id, id)).run())
  // The audit row names the erasure without keeping the address it erased.
  yield* recordAudit({
    actor,
    action: "contact.erase",
    target: id,
    after: { email: `erased:${digest}`, messages: logRows.length },
  })
  yield* emitSafely("contact.deleted", { contactId: id, erased: true })
  return { id, erased: true, messagesScrubbed: logRows.length }
})

export const BULK_LIMIT = 1000

/** D1 binds at most 100 parameters a statement; leave room for the others in it. */
export const D1_MAX_PARAMS = 90

export const chunksOf = <T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> => {
  const out: Array<Array<T>> = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------------------------------------
// The field registry (HAL-3422)
// ---------------------------------------------------------------------------------------------

/** Where a field is used: segments whose rules read it, and automations that set or test it. */
const fieldUsage = Effect.gen(function* () {
  const database = yield* Database
  const segs = yield* database.query("fields.segments", (db) =>
    db.select({ id: segments.id, name: segments.name, filter: segments.filter }).from(segments).all(),
  )
  const autos = yield* database.query("fields.automations", (db) =>
    db
      .select({ id: automations.id, name: automations.name, graph: automations.graph })
      .from(automations)
      .all(),
  )
  const keysIn = (value: unknown): Set<string> => {
    const found = new Set<string>()
    const walk = (v: unknown) => {
      if (Array.isArray(v)) for (const x of v) walk(x)
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>
        if (o.type === "field" && typeof o.field === "string") found.add(o.field)
        if (o.type === "update" && o.config && typeof o.config === "object") {
          const fields = (o.config as { fields?: unknown }).fields
          if (fields && typeof fields === "object") for (const k of Object.keys(fields)) found.add(k)
        }
        for (const x of Object.values(o)) walk(x)
      }
    }
    walk(value)
    return found
  }
  return [
    ...segs.map((s) => ({ type: "segment" as const, id: s.id, name: s.name, keys: keysIn(s.filter) })),
    ...autos.map((a) => ({ type: "automation" as const, id: a.id, name: a.name, keys: keysIn(a.graph) })),
  ]
})

/**
 * `GET /v1/contact-fields`: every custom field, its label and type, and where it's used. Segments and
 * automations are read whole (people write them, a few dozen at most) and searched here.
 */
export const listContactFields = Effect.fn("contacts.fields")(function* () {
  const database = yield* Database
  const rows = yield* database.query("fields.list", (db) =>
    db.select().from(contactFields).orderBy(asc(contactFields.key)).all(),
  )
  const usage = yield* fieldUsage
  return {
    fields: rows.map((f) => ({
      key: f.key,
      label: f.label ?? f.key,
      type: f.type,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      usedBy: usage.filter((u) => u.keys.has(f.key)).map(({ type, id, name }) => ({ type, id, name })),
    })),
  }
})

/** `PATCH /v1/contact-fields/{key}`: a label people read, or a corrected type. Values aren't touched. */
export const updateContactField = Effect.fn("contacts.fieldUpdate")(function* (
  key: string,
  patch: {
    readonly label?: string | null | undefined
    readonly type?: "string" | "number" | "boolean" | "date" | undefined
  },
  actor: string,
) {
  const database = yield* Database
  const row = yield* database.query("fields.find", (db) =>
    db.select().from(contactFields).where(eq(contactFields.key, key)).get(),
  )
  if (!row) return yield* new ContactNotFound({ id: `field ${key}` })
  const set = {
    ...(patch.label !== undefined ? { label: patch.label?.trim() || null } : {}),
    ...(patch.type !== undefined ? { type: patch.type } : {}),
    updatedAt: Date.now(),
  }
  yield* database.query("fields.update", (db) =>
    db.update(contactFields).set(set).where(eq(contactFields.key, key)).run(),
  )
  yield* recordAudit({ actor, action: "contact_field.updated", target: key, before: row, after: set })
  const { fields } = yield* listContactFields()
  return fields.find((f) => f.key === key) as (typeof fields)[number]
})

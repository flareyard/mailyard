import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import {
  apiKeys,
  mailboxMembers,
  mailboxPeople,
  members,
  pushPreferences,
  pushSubscriptions,
  settings,
} from "../db/schema.ts"
import { SEES_ALL_MAILBOXES } from "../domain/permissions.ts"
import { SecretBox } from "../domain/webhooks.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { generateVapidKeys, sendWebPush } from "./webPush.ts"

/**
 * Web Push for people (HAL-3369): new mail in the mailboxes they read, conversations handed to them,
 * and alerts. Each browser subscribes with its push service's endpoint and keys; each person (or key)
 * chooses per mailbox all, assigned or off, whether alerts come too, and whether a notification
 * shows who wrote and what about or only that something arrived.
 *
 * The VAPID key pair is made on first use and kept in `settings`, its private half sealed with the
 * webhook secrets' key, so nothing needs configuring and the public key never changes.
 */

export class PushInvalid extends Schema.TaggedError<PushInvalid>()("PushInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
export class PushNotFound extends Schema.TaggedError<PushNotFound>()("PushNotFound", { id: Schema.String }) {}

const VAPID_KEY = "vapid"
/** A subscription that fails this many times running is dropped; one the push service says is gone, at once. */
const MAX_FAILURES = 10

type Vapid = { readonly publicKey: string; readonly sealedPrivate: string }
let cachedVapid: { publicKey: string; privateJwk: JsonWebKey } | null = null

/** The VAPID keys, made and stored the first time they're needed. */
export const vapidKeys = Effect.fn("push.vapidKeys")(function* () {
  if (cachedVapid) return cachedVapid
  const database = yield* Database
  const box = yield* SecretBox
  const read = () =>
    database.query("push.vapid", (db) => db.select().from(settings).where(eq(settings.key, VAPID_KEY)).get())
  let row = yield* read()
  if (!row) {
    const keys = yield* Effect.promise(() => generateVapidKeys())
    const value: Vapid = {
      publicKey: keys.publicKey,
      sealedPrivate: yield* box.seal(JSON.stringify(keys.privateJwk)),
    }
    // Two isolates making keys at once: the first stored wins, and both read it back.
    yield* database.query("push.vapidStore", (db) =>
      db
        .insert(settings)
        .values({ key: VAPID_KEY, value, updatedAt: Date.now() })
        .onConflictDoNothing()
        .run(),
    )
    row = yield* read()
  }
  const value = row?.value as Vapid
  cachedVapid = {
    publicKey: value.publicKey,
    privateJwk: JSON.parse(yield* box.open(value.sealedPrivate)) as JsonWebKey,
  }
  return cachedVapid
})

const ENDPOINT = /^https:\/\/[^\s/]+\/\S+$/
const B64URL = /^[A-Za-z0-9_-]+$/

export const subscribe = Effect.fn("push.subscribe")(function* (
  owner: string,
  input: {
    readonly endpoint: string
    readonly keys: { readonly p256dh: string; readonly auth: string }
    readonly device?: string | null | undefined
  },
) {
  if (!ENDPOINT.test(input.endpoint) || input.endpoint.length > 2_000)
    return yield* new PushInvalid({
      field: "endpoint",
      message: "A push subscription's endpoint is an https URL.",
    })
  if (!B64URL.test(input.keys.p256dh) || input.keys.p256dh.length < 80 || input.keys.p256dh.length > 100)
    return yield* new PushInvalid({
      field: "keys.p256dh",
      message: "p256dh is a base64url P-256 public key.",
    })
  if (!B64URL.test(input.keys.auth) || input.keys.auth.length < 16 || input.keys.auth.length > 30)
    return yield* new PushInvalid({ field: "keys.auth", message: "auth is a base64url 16-byte secret." })
  const database = yield* Database
  const now = Date.now()
  const id = `psh_${yield* (yield* Ids).next}`
  const row = yield* database.query("push.subscribe", (db) =>
    db
      .insert(pushSubscriptions)
      .values({
        id,
        owner,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        device: input.device?.slice(0, 200) ?? null,
        createdAt: now,
      })
      // The same browser subscribing again (or for someone else, after a sign-out): one row.
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          owner,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          device: input.device?.slice(0, 200) ?? null,
          failures: 0,
        },
      })
      .returning()
      .get(),
  )
  return describeSubscription(row)
})

const describeSubscription = (row: typeof pushSubscriptions.$inferSelect) => ({
  id: row.id,
  device: row.device,
  /** The push service's host, to tell browsers apart; the full endpoint is a capability, so it isn't shown. */
  service: new URL(row.endpoint).host,
  createdAt: row.createdAt,
  lastSentAt: row.lastSentAt,
})

export const listSubscriptions = Effect.fn("push.list")(function* (owner: string) {
  const database = yield* Database
  const rows = yield* database.query("push.listMine", (db) =>
    db.select().from(pushSubscriptions).where(eq(pushSubscriptions.owner, owner)).limit(100).all(),
  )
  return rows.map(describeSubscription)
})

export const unsubscribe = Effect.fn("push.unsubscribe")(function* (owner: string, id: string) {
  const database = yield* Database
  const gone = yield* database.query("push.unsubscribe", (db) =>
    db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.owner, owner)))
      .returning({ id: pushSubscriptions.id })
      .all(),
  )
  if (gone.length === 0) return yield* new PushNotFound({ id })
  return { deleted: id }
})

export const Preferences = Schema.Struct({
  mailboxes: Schema.Array(
    Schema.Struct({ mailboxId: Schema.String, notify: Schema.Literals(["all", "assigned", "off"]) }),
  ).check(Schema.isMaxLength(500)),
  alerts: Schema.Boolean,
  hideContent: Schema.Boolean,
})
export type Preferences = typeof Preferences.Type

/** No preferences yet: everything in the mailboxes they read, alerts too, content shown. */
const DEFAULTS: Preferences = { mailboxes: [], alerts: true, hideContent: false }

export const getPreferences = Effect.fn("push.preferences")(function* (owner: string) {
  const database = yield* Database
  const row = yield* database.query("push.preferences", (db) =>
    db.select().from(pushPreferences).where(eq(pushPreferences.owner, owner)).get(),
  )
  return row ? { mailboxes: [...row.mailboxes], alerts: row.alerts, hideContent: row.hideContent } : DEFAULTS
})

export const putPreferences = Effect.fn("push.putPreferences")(function* (owner: string, value: Preferences) {
  const database = yield* Database
  const now = Date.now()
  const row = {
    owner,
    mailboxes: [...value.mailboxes],
    alerts: value.alerts,
    hideContent: value.hideContent,
    updatedAt: now,
  }
  yield* database.query("push.preferences.put", (db) =>
    db
      .insert(pushPreferences)
      .values(row)
      .onConflictDoUpdate({ target: pushPreferences.owner, set: row })
      .run(),
  )
  return value
})

/** Whether an owner (a member id, a key id, or `root`) may read a mailbox, as the API decides it. */
const ownerReads = Effect.fn("push.ownerReads")(function* (owner: string, mailboxId: string) {
  if (owner === "root") return true
  const database = yield* Database
  if (owner.startsWith("mem_")) {
    const member = yield* database.query("push.member", (db) =>
      db
        .select({ role: members.role })
        .from(members)
        .where(and(eq(members.id, owner), isNull(members.removedAt)))
        .get(),
    )
    if (!member) return false
    if (SEES_ALL_MAILBOXES.has(member.role)) return true
    const grant = yield* database.query("push.memberGrant", (db) =>
      db
        .select({ role: mailboxPeople.role })
        .from(mailboxPeople)
        .where(and(eq(mailboxPeople.memberId, owner), eq(mailboxPeople.mailboxId, mailboxId)))
        .get(),
    )
    return grant !== undefined
  }
  const key = yield* database.query("push.key", (db) =>
    db
      .select({ scopes: apiKeys.scopes, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, owner))
      .get(),
  )
  if (!key || (key.revokedAt !== null && key.revokedAt <= Date.now())) return false
  if (key.scopes.includes("admin")) return true
  const grant = yield* database.query("push.keyGrant", (db) =>
    db
      .select({ role: mailboxMembers.role })
      .from(mailboxMembers)
      .where(and(eq(mailboxMembers.apiKeyId, owner), eq(mailboxMembers.mailboxId, mailboxId)))
      .get(),
  )
  return grant !== undefined
})

/** Whether an owner manages the workspace, for alerts. */
const ownerManages = Effect.fn("push.ownerManages")(function* (owner: string) {
  if (owner === "root") return true
  const database = yield* Database
  if (owner.startsWith("mem_")) {
    const member = yield* database.query("push.memberRole", (db) =>
      db
        .select({ role: members.role })
        .from(members)
        .where(and(eq(members.id, owner), isNull(members.removedAt)))
        .get(),
    )
    return member?.role === "owner" || member?.role === "admin"
  }
  const key = yield* database.query("push.keyScopes", (db) =>
    db.select({ scopes: apiKeys.scopes }).from(apiKeys).where(eq(apiKeys.id, owner)).get(),
  )
  return key?.scopes.includes("admin") ?? false
})

export interface PushPayload {
  readonly type: "mail" | "assigned" | "alert" | "test"
  readonly title: string
  readonly body: string
  /** Groups notifications: a new one for the same conversation replaces the last. */
  readonly tag: string
  readonly mailboxId?: string
  readonly threadId?: string
  readonly messageId?: string
  /** Where clicking it goes, relative to the app. */
  readonly url: string
}

/** Sends to each subscription, drops the dead ones, and counts what happened. */
const deliver = (
  subscriptions: ReadonlyArray<typeof pushSubscriptions.$inferSelect>,
  payloadFor: (owner: string) => Effect.Effect<PushPayload | null, never, Database>,
) =>
  Effect.gen(function* () {
    if (subscriptions.length === 0) return { sent: 0, failed: 0, gone: 0 }
    const env = yield* Bindings
    const keys = yield* vapidKeys()
    const origin = env.MAILYARD_PUBLIC_ORIGIN?.replace(/\/$/, "")
    const subject =
      origin ??
      `mailto:${(env.MAILYARD_SYSTEM_FROM ?? env.DEFAULT_FROM ?? "hello@localhost").replace(/^.*<|>.*$/g, "")}`
    const database = yield* Database
    const counts = { sent: 0, failed: 0, gone: 0 }
    yield* Effect.forEach(
      subscriptions,
      (s) =>
        Effect.gen(function* () {
          const payload = yield* payloadFor(s.owner)
          if (!payload) return
          const result = yield* Effect.promise(() =>
            sendWebPush({
              subscription: { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
              payload,
              vapid: { subject, publicKey: keys.publicKey, privateJwk: keys.privateJwk },
              topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
              urgency: payload.type === "alert" ? "high" : "normal",
            }),
          )
          counts[result.outcome === "sent" ? "sent" : result.outcome === "gone" ? "gone" : "failed"] += 1
          if (result.outcome === "sent")
            yield* database.query("push.sent", (db) =>
              db
                .update(pushSubscriptions)
                .set({ lastSentAt: Date.now(), failures: 0 })
                .where(eq(pushSubscriptions.id, s.id))
                .run(),
            )
          else if (result.outcome === "gone" || s.failures + 1 >= MAX_FAILURES)
            yield* database.query("push.drop", (db) =>
              db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id)).run(),
            )
          else
            yield* database.query("push.failed", (db) =>
              db
                .update(pushSubscriptions)
                .set({ failures: sql`${pushSubscriptions.failures} + 1` })
                .where(eq(pushSubscriptions.id, s.id))
                .run(),
            )
        }),
      { concurrency: 5 },
    )
    return counts
  })

const allSubscriptions = Effect.gen(function* () {
  const database = yield* Database
  return yield* database.query("push.all", (db) => db.select().from(pushSubscriptions).limit(1_000).all())
})

const preferencesFor = (owners: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const database = yield* Database
    const map = new Map<string, Preferences>()
    for (let i = 0; i < owners.length; i += 90) {
      const rows = yield* database.query("push.preferencesMany", (db) =>
        db
          .select()
          .from(pushPreferences)
          .where(inArray(pushPreferences.owner, owners.slice(i, i + 90)))
          .all(),
      )
      for (const r of rows)
        map.set(r.owner, { mailboxes: r.mailboxes, alerts: r.alerts, hideContent: r.hideContent })
    }
    return map
  })

const threadUrl = (mailboxId: string, threadId: string) =>
  `/mail/${encodeURIComponent(mailboxId)}/${encodeURIComponent(threadId)}`

/**
 * New mail filed in a mailbox: everyone subscribed who reads it and wants it (all; or assigned, when
 * the conversation is theirs) gets one notification per conversation. Never fails the filing.
 */
export const notifyNewMail = (input: {
  readonly mailboxId: string
  readonly threadId: string
  readonly messageId: string
  readonly from: string
  readonly subject: string
  readonly assignee: string | null
}) =>
  Effect.gen(function* () {
    const subscriptions = yield* allSubscriptions
    if (subscriptions.length === 0) return
    const owners = [...new Set(subscriptions.map((s) => s.owner))]
    const prefs = yield* preferencesFor(owners)
    const wanted = new Map<string, boolean>()
    for (const owner of owners) {
      const p = prefs.get(owner) ?? DEFAULTS
      const notify = p.mailboxes.find((m) => m.mailboxId === input.mailboxId)?.notify ?? "all"
      const yes =
        notify !== "off" &&
        (notify === "all" || input.assignee === owner) &&
        (yield* ownerReads(owner, input.mailboxId).pipe(Effect.orElseSucceed(() => false)))
      wanted.set(owner, yes)
    }
    yield* deliver(
      subscriptions.filter((s) => wanted.get(s.owner)),
      (owner) =>
        Effect.succeed(
          (prefs.get(owner) ?? DEFAULTS).hideContent
            ? {
                type: "mail" as const,
                title: "New mail",
                body: "Open Mailyard to read it.",
                tag: input.threadId,
                mailboxId: input.mailboxId,
                threadId: input.threadId,
                url: threadUrl(input.mailboxId, input.threadId),
              }
            : {
                type: "mail" as const,
                title: input.from,
                body: input.subject || "(no subject)",
                tag: input.threadId,
                mailboxId: input.mailboxId,
                threadId: input.threadId,
                messageId: input.messageId,
                url: threadUrl(input.mailboxId, input.threadId),
              },
        ),
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("push: could not notify new mail", cause)))

/** A conversation handed to someone: they hear about it, unless that mailbox is off for them. */
export const notifyAssigned = (input: {
  readonly mailboxId: string
  readonly threadId: string
  readonly assignee: string
  readonly by: string
  readonly subject: string
}) =>
  Effect.gen(function* () {
    if (input.assignee === input.by) return
    const database = yield* Database
    const subscriptions = yield* database.query("push.ownerSubs", (db) =>
      db.select().from(pushSubscriptions).where(eq(pushSubscriptions.owner, input.assignee)).all(),
    )
    if (subscriptions.length === 0) return
    const p = yield* getPreferences(input.assignee)
    if (p.mailboxes.find((m) => m.mailboxId === input.mailboxId)?.notify === "off") return
    yield* deliver(subscriptions, () =>
      Effect.succeed({
        type: "assigned" as const,
        title: "Assigned to you",
        body: p.hideContent ? "A conversation is yours now." : input.subject || "(no subject)",
        tag: `assigned-${input.threadId}`,
        mailboxId: input.mailboxId,
        threadId: input.threadId,
        url: threadUrl(input.mailboxId, input.threadId),
      }),
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("push: could not notify an assignment", cause)))

/** A new or worse alert: the people who manage the workspace and want alerts. */
export const notifyAlertPush = (input: {
  readonly key: string
  readonly severity: string
  readonly title: string
}) =>
  Effect.gen(function* () {
    const subscriptions = yield* allSubscriptions
    if (subscriptions.length === 0) return
    const owners = [...new Set(subscriptions.map((s) => s.owner))]
    const prefs = yield* preferencesFor(owners)
    const wanted = new Set<string>()
    for (const owner of owners)
      if (
        (prefs.get(owner) ?? DEFAULTS).alerts &&
        (yield* ownerManages(owner).pipe(Effect.orElseSucceed(() => false)))
      )
        wanted.add(owner)
    yield* deliver(
      subscriptions.filter((s) => wanted.has(s.owner)),
      () =>
        Effect.succeed({
          type: "alert" as const,
          title: input.severity === "critical" ? "Critical alert" : "Alert",
          body: input.title,
          tag: `alert-${input.key}`,
          url: "/alerts",
        }),
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("push: could not notify an alert", cause)))

/** `POST /v1/push/test`: one notification to each of the caller's own subscriptions. */
export const sendTest = Effect.fn("push.test")(function* (owner: string) {
  const database = yield* Database
  const subscriptions = yield* database.query("push.testSubs", (db) =>
    db.select().from(pushSubscriptions).where(eq(pushSubscriptions.owner, owner)).all(),
  )
  return yield* deliver(subscriptions, () =>
    Effect.succeed({
      type: "test" as const,
      title: "Mailyard",
      body: "Notifications work.",
      tag: "test",
      url: "/",
    }),
  )
})

/** For tests: forget the cached keys. */
export const resetVapidCache = () => {
  cachedVapid = null
}

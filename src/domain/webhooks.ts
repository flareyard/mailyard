import { and, desc, eq, lt, or } from "drizzle-orm"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { webhookDeliveries, webhookEndpoints } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"

/**
 * Outbound webhooks, signed per the Standard Webhooks spec (standardwebhooks.com): headers
 * `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256 of
 * "id.timestamp.body">`, keyed by the endpoint's `whsec_` secret. Receivers can verify with any
 * Standard Webhooks library.
 */

export const WEBHOOK_EVENTS = [
  "message.sent",
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.failed",
  "message.rejected",
  "message.complained",
  "contact.created",
  "contact.updated",
  "contact.subscribed",
  "contact.unsubscribed",
  "contact.deleted",
  "contact.suppressed",
  "event.tracked",
  "mail.received",
  "mail.rule_matched",
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/** Deliveries stop after this many attempts and are marked dead (replayable). */
export const MAX_WEBHOOK_ATTEMPTS = 8
/** Exponential from 30 s, capped at 6 h: 30 s, 1 m, 2 m, 4 m, 8 m, 16 m, 32 m. */
export const webhookRetryDelay = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 6 * 60 * 60)
const TIMEOUT_MS = 10_000

export class WebhookNotFound extends Schema.TaggedError<WebhookNotFound>()("WebhookNotFound", {
  id: Schema.String,
}) {}
export class WebhookInvalid extends Schema.TaggedError<WebhookInvalid>()("WebhookInvalid", {
  message: Schema.String,
}) {}

const enc = new TextEncoder()
const b64 = (bytes: ArrayBuffer | Uint8Array) => {
  let s = ""
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** A new endpoint secret: `whsec_` + 32 random bytes, base64. */
export const newSecret = () => `whsec_${b64(crypto.getRandomValues(new Uint8Array(32)))}`

export const sign = async (secret: string, id: string, timestamp: number, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    unb64(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return `v1,${b64(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`)))}`
}

/** Encrypts endpoint secrets at rest, keyed by the deploy-time WEBHOOK_SIGNING_KEY. */
export class SecretBox extends Context.Service<
  SecretBox,
  { seal(plain: string): Effect.Effect<string>; open(sealed: string): Effect.Effect<string> }
>()("mailyard/SecretBox") {
  static readonly layer = Layer.effect(
    SecretBox,
    Effect.gen(function* () {
      const { WEBHOOK_SIGNING_KEY } = yield* Bindings
      const keyPromise = (async () => {
        if (!WEBHOOK_SIGNING_KEY) throw new Error("WEBHOOK_SIGNING_KEY is not set")
        const material = await crypto.subtle.digest(
          "SHA-256",
          enc.encode(`mailyard-webhook-secrets:${WEBHOOK_SIGNING_KEY}`),
        )
        return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"])
      })()
      return SecretBox.of({
        seal: (plain) =>
          Effect.promise(async () => {
            const iv = crypto.getRandomValues(new Uint8Array(12))
            const cipher = await crypto.subtle.encrypt(
              { name: "AES-GCM", iv },
              await keyPromise,
              enc.encode(plain),
            )
            return `${b64(iv)}.${b64(cipher)}`
          }),
        open: (sealed) =>
          Effect.promise(async () => {
            const [iv, cipher] = sealed.split(".")
            const plain = await crypto.subtle.decrypt(
              { name: "AES-GCM", iv: unb64(iv ?? "") },
              await keyPromise,
              unb64(cipher ?? ""),
            )
            return new TextDecoder().decode(plain)
          }),
      })
    }),
  )
}

const checkUrl = (url: string) => {
  try {
    const u = new URL(url)
    if (u.protocol !== "https:") return "Webhook URLs must use https."
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(u.hostname))
      return "Webhook URLs can't be private addresses."
    return undefined
  } catch {
    return "Not a valid URL."
  }
}

const checkEvents = (events: ReadonlyArray<string>) => {
  const unknown = events.filter((e) => e !== "*" && !(WEBHOOK_EVENTS as ReadonlyArray<string>).includes(e))
  return unknown.length ? `Unknown event types: ${unknown.join(", ")}.` : undefined
}

export const describeEndpoint = (row: typeof webhookEndpoints.$inferSelect) => ({
  id: row.id,
  url: row.url,
  description: row.description,
  events: [...row.events],
  enabled: row.enabled,
  lastSuccessAt: row.lastSuccessAt,
  lastFailureAt: row.lastFailureAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const findEndpoint = Effect.fn("webhooks.find")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("webhooks.find", (db) =>
    db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get(),
  )
  if (!row) return yield* new WebhookNotFound({ id })
  return row
})

export const createEndpoint = Effect.fn("webhooks.create")(function* (input: {
  readonly url: string
  readonly description?: string | undefined
  readonly events: ReadonlyArray<string>
}) {
  const problem = checkUrl(input.url) ?? checkEvents(input.events)
  if (problem) return yield* new WebhookInvalid({ message: problem })
  const database = yield* Database
  const box = yield* SecretBox
  const id = yield* (yield* Ids).next
  const secret = newSecret()
  const secretCiphertext = yield* box.seal(secret)
  const row = yield* database.query("webhooks.insert", (db) =>
    db
      .insert(webhookEndpoints)
      .values({
        id,
        url: input.url,
        description: input.description ?? null,
        events: [...input.events],
        secretCiphertext,
        updatedAt: Date.now(),
      })
      .returning()
      .get(),
  )
  return { endpoint: describeEndpoint(row), secret }
})

export const listEndpoints = Effect.fn("webhooks.list")(function* () {
  const database = yield* Database
  const rows = yield* database.query("webhooks.list", (db) =>
    db.select().from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt)).all(),
  )
  return rows.map(describeEndpoint)
})

export const getEndpoint = Effect.fn("webhooks.get")(function* (id: string) {
  return describeEndpoint(yield* findEndpoint(id))
})

export const updateEndpoint = Effect.fn("webhooks.update")(function* (
  id: string,
  patch: {
    readonly url?: string | undefined
    readonly description?: string | null | undefined
    readonly events?: ReadonlyArray<string> | undefined
    readonly enabled?: boolean | undefined
  },
) {
  const current = yield* findEndpoint(id)
  const problem =
    (patch.url ? checkUrl(patch.url) : undefined) ?? (patch.events ? checkEvents(patch.events) : undefined)
  if (problem) return yield* new WebhookInvalid({ message: problem })
  const database = yield* Database
  const row = yield* database.query("webhooks.update", (db) =>
    db
      .update(webhookEndpoints)
      .set({
        url: patch.url ?? current.url,
        description: patch.description === undefined ? current.description : patch.description,
        events: patch.events ? [...patch.events] : current.events,
        enabled: patch.enabled ?? current.enabled,
        updatedAt: Date.now(),
      })
      .where(eq(webhookEndpoints.id, id))
      .returning()
      .get(),
  )
  return describeEndpoint(row)
})

export const deleteEndpoint = Effect.fn("webhooks.delete")(function* (id: string) {
  const current = yield* findEndpoint(id)
  const database = yield* Database
  yield* database.query("webhooks.delete", (db) =>
    db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).run(),
  )
  return describeEndpoint(current)
})

/** A new secret; the old one stops working at once. Returned this one time. */
export const rotateSecret = Effect.fn("webhooks.rotate")(function* (id: string) {
  yield* findEndpoint(id)
  const database = yield* Database
  const secret = newSecret()
  const secretCiphertext = yield* (yield* SecretBox).seal(secret)
  const row = yield* database.query("webhooks.rotate", (db) =>
    db
      .update(webhookEndpoints)
      .set({ secretCiphertext, updatedAt: Date.now() })
      .where(eq(webhookEndpoints.id, id))
      .returning()
      .get(),
  )
  return { endpoint: describeEndpoint(row), secret }
})

export const listDeliveries = Effect.fn("webhooks.deliveries")(function* (
  endpointId: string,
  filter: {
    readonly status?: "pending" | "succeeded" | "retrying" | "dead" | undefined
    readonly cursor?: string | undefined
    readonly limit: number
  },
) {
  yield* findEndpoint(endpointId)
  const database = yield* Database
  const [cursorAt, cursorId] = filter.cursor ? filter.cursor.split(":") : []
  const rows = yield* database.query("webhooks.deliveries", (db) =>
    db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.endpointId, endpointId),
          filter.status ? eq(webhookDeliveries.status, filter.status) : undefined,
          cursorAt && cursorId
            ? or(
                lt(webhookDeliveries.createdAt, Number(cursorAt)),
                and(eq(webhookDeliveries.createdAt, Number(cursorAt)), lt(webhookDeliveries.id, cursorId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(filter.limit + 1)
      .all(),
  )
  const page = rows.slice(0, filter.limit)
  const last = page.at(-1)
  return {
    deliveries: page.map((d) => ({
      id: d.id,
      eventId: d.eventId,
      eventType: d.eventType,
      status: d.status,
      attempts: d.attempts,
      lastStatusCode: d.lastStatusCode,
      lastError: d.lastError,
      lastDurationMs: d.lastDurationMs,
      lastAttemptAt: d.lastAttemptAt,
      nextAttemptAt: d.nextAttemptAt,
      createdAt: d.createdAt,
      payload: JSON.parse(d.payload) as unknown,
    })),
    nextCursor: rows.length > filter.limit && last ? `${last.createdAt}:${last.id}` : null,
  }
})

/** Hands deliveries to the webhook queue; the consumer does the HTTP. */
export class WebhookQueue extends Context.Service<
  WebhookQueue,
  { enqueue(deliveryId: string, delaySeconds: number): Effect.Effect<void> }
>()("mailyard/WebhookQueue") {
  static readonly layer = Layer.effect(
    WebhookQueue,
    Effect.gen(function* () {
      const { WEBHOOK_QUEUE } = yield* Bindings
      return WebhookQueue.of({
        enqueue: (deliveryId, delaySeconds) =>
          Effect.promise(() =>
            WEBHOOK_QUEUE.send({ deliveryId }, { delaySeconds: Math.min(Math.max(delaySeconds, 0), 43200) }),
          ),
      })
    }),
  )
}

export const WebhookJob = Schema.Struct({ deliveryId: Schema.String })

/**
 * Records a delivery for every enabled endpoint subscribed to `type` and queues them. The event id is
 * shared by all of an event's deliveries, so receivers can de-duplicate across retries.
 */
export const emit = Effect.fn("webhooks.emit")(function* (
  type: WebhookEvent,
  data: Record<string, unknown>,
  /** Deliver to this endpoint only (an inbox rule's webhook action), whatever events it subscribes to. */
  onlyEndpointId?: string,
) {
  const database = yield* Database
  const endpoints = yield* database.query("webhooks.subscribers", (db) =>
    db.select().from(webhookEndpoints).where(eq(webhookEndpoints.enabled, true)).all(),
  )
  const targets = onlyEndpointId
    ? endpoints.filter((e) => e.id === onlyEndpointId)
    : endpoints.filter((e) => e.events.includes("*") || e.events.includes(type))
  if (targets.length === 0) return 0
  const ids = yield* Ids
  const eventId = `evt_${yield* ids.next}`
  const payload = JSON.stringify({ id: eventId, type, createdAt: new Date().toISOString(), data })
  const queue = yield* WebhookQueue
  for (const endpoint of targets) {
    const id = `whd_${yield* ids.next}`
    yield* database.query("webhooks.deliveryInsert", (db) =>
      db
        .insert(webhookDeliveries)
        .values({ id, endpointId: endpoint.id, eventId, eventType: type, payload, status: "pending" })
        .run(),
    )
    yield* queue.enqueue(id, 0)
  }
  return targets.length
})

/** Never let a webhook fan-out fail the thing that triggered it. */
export const emitSafely = (type: WebhookEvent, data: Record<string, unknown>, onlyEndpointId?: string) =>
  emit(type, data, onlyEndpointId).pipe(
    Effect.catchCause((cause) => Effect.logError(`webhooks: could not record ${type}`, cause)),
    Effect.asVoid,
  )

/** One HTTP attempt for one delivery, as the queue consumer runs it. */
export const deliver = Effect.fn("webhooks.deliver")(function* (deliveryId: string) {
  const database = yield* Database
  const delivery = yield* database.query("webhooks.deliveryFind", (db) =>
    db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get(),
  )
  if (!delivery || delivery.status === "succeeded" || delivery.status === "dead") return "skipped" as const
  const endpoint = yield* database.query("webhooks.endpointFind", (db) =>
    db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, delivery.endpointId)).get(),
  )
  if (!endpoint?.enabled) return "skipped" as const

  const secret = yield* (yield* SecretBox).open(endpoint.secretCiphertext)
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = yield* Effect.promise(() => sign(secret, delivery.eventId, timestamp, delivery.payload))
  const started = Date.now()
  const result = yield* Effect.promise(async () => {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mailyard-Webhooks/1",
          "webhook-id": delivery.eventId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature,
        },
        body: delivery.payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      return {
        ok: response.ok,
        status: response.status,
        error: response.ok ? null : (await response.text()).slice(0, 500),
      }
    } catch (e) {
      return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) }
    }
  })
  const attempts = delivery.attempts + 1
  const now = Date.now()
  const duration = now - started

  if (result.ok) {
    yield* database.query("webhooks.succeeded", (db) =>
      db.batch([
        db
          .update(webhookDeliveries)
          .set({
            status: "succeeded",
            attempts,
            lastStatusCode: result.status,
            lastError: null,
            lastDurationMs: duration,
            lastAttemptAt: now,
            nextAttemptAt: null,
          })
          .where(eq(webhookDeliveries.id, deliveryId)),
        db.update(webhookEndpoints).set({ lastSuccessAt: now }).where(eq(webhookEndpoints.id, endpoint.id)),
      ]),
    )
    return "succeeded" as const
  }

  const dead = attempts >= MAX_WEBHOOK_ATTEMPTS
  const delay = webhookRetryDelay(attempts)
  yield* database.query("webhooks.failed", (db) =>
    db.batch([
      db
        .update(webhookDeliveries)
        .set({
          status: dead ? "dead" : "retrying",
          attempts,
          lastStatusCode: result.status,
          lastError: result.error,
          lastDurationMs: duration,
          lastAttemptAt: now,
          nextAttemptAt: dead ? null : now + delay * 1000,
        })
        .where(eq(webhookDeliveries.id, deliveryId)),
      db.update(webhookEndpoints).set({ lastFailureAt: now }).where(eq(webhookEndpoints.id, endpoint.id)),
    ]),
  )
  if (!dead) yield* (yield* WebhookQueue).enqueue(deliveryId, delay)
  return dead ? ("dead" as const) : ("retrying" as const)
})

/** Sends a dead (or any) delivery again, from attempt one. */
export const replay = Effect.fn("webhooks.replay")(function* (endpointId: string, deliveryId: string) {
  const database = yield* Database
  const row = yield* database.query("webhooks.replay", (db) =>
    db
      .update(webhookDeliveries)
      .set({ status: "pending", attempts: 0, nextAttemptAt: null })
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.endpointId, endpointId)))
      .returning()
      .get(),
  )
  if (!row) return yield* new WebhookNotFound({ id: deliveryId })
  yield* (yield* WebhookQueue).enqueue(deliveryId, 0)
  return { id: row.id, status: row.status }
})

/** Queues a `ping`-style test event to one endpoint, regardless of its subscriptions. */
export const sendTest = Effect.fn("webhooks.test")(function* (endpointId: string) {
  const endpoint = yield* findEndpoint(endpointId)
  const database = yield* Database
  const ids = yield* Ids
  const eventId = `evt_${yield* ids.next}`
  const id = `whd_${yield* ids.next}`
  const payload = JSON.stringify({
    id: eventId,
    type: "webhook.test",
    createdAt: new Date().toISOString(),
    data: { message: "A test event from Mailyard." },
  })
  yield* database.query("webhooks.testInsert", (db) =>
    db
      .insert(webhookDeliveries)
      .values({ id, endpointId: endpoint.id, eventId, eventType: "webhook.test", payload, status: "pending" })
      .run(),
  )
  yield* (yield* WebhookQueue).enqueue(id, 0)
  return { deliveryId: id, eventId }
})

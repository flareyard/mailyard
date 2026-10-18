import { eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import {
  MAIL_EVENT_TYPES,
  MAIL_EVENTS_QUEUE,
  MAIL_EVENTS_VERSION,
  type MailEvent,
  type MailEventType,
} from "../contracts/mailEvents.ts"
import { mailboxes, settings } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"

/**
 * The producer side of the mail-events lane (HAL-3306). The lane is off until someone turns it on
 * (`PUT /v1/settings/mail-events`), so a workspace without Hermes writes nothing to the Queue and
 * pays nothing for it. When on, it carries the chosen mailboxes' events (all of them when
 * `mailboxIds` is null), of the chosen types (all when `types` is null).
 *
 * Publishing never fails what published: a full or missing queue is logged and the mail goes on.
 */

export const LaneSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** Only these mailboxes; null for every mailbox. */
  mailboxIds: Schema.NullOr(Schema.Array(Schema.String).check(Schema.isMaxLength(500))),
  /** Only these event types; null for all. */
  types: Schema.NullOr(Schema.Array(Schema.Literals(MAIL_EVENT_TYPES))),
  /** When the lane was last turned on. */
  since: Schema.NullOr(Schema.Number),
})
export type LaneSettings = typeof LaneSettings.Type

export class LaneInvalid extends Schema.TaggedError<LaneInvalid>()("LaneInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

const KEY = "mail_events"
const OFF: LaneSettings = { enabled: false, mailboxIds: null, types: null, since: null }
const CACHE_MS = 30_000
let cache: { at: number; value: LaneSettings } | null = null

const readLane = Effect.fn("mailEvents.read")(function* () {
  const database = yield* Database
  const row = yield* database.query("settings.mailEvents", (db) =>
    db.select().from(settings).where(eq(settings.key, KEY)).get(),
  )
  const decoded = Schema.decodeUnknownOption(LaneSettings)(row?.value)
  return decoded._tag === "Some" ? decoded.value : OFF
})

/** The lane's settings, cached for 30 seconds per isolate: every filing and send asks. */
export const laneSettings = Effect.fn("mailEvents.settings")(function* (now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache.value
  const value = yield* readLane().pipe(Effect.orElseSucceed(() => OFF))
  cache = { at: now, value }
  return value
})

/** What the settings page and `GET /v1/integrations` show. */
export const describeLane = Effect.fn("mailEvents.describe")(function* () {
  const env = yield* Bindings
  const lane = yield* readLane()
  return {
    ...lane,
    queue: MAIL_EVENTS_QUEUE,
    version: MAIL_EVENTS_VERSION,
    /** Whether this deployment has the queue bound at all (off Cloudflare it doesn't). */
    available: env.MAIL_EVENTS_QUEUE !== undefined,
  }
})

export const putLane = Effect.fn("mailEvents.put")(function* (input: {
  readonly enabled: boolean
  readonly mailboxIds?: ReadonlyArray<string> | null | undefined
  readonly types?: ReadonlyArray<MailEventType> | null | undefined
}) {
  const env = yield* Bindings
  if (input.enabled && !env.MAIL_EVENTS_QUEUE)
    return yield* new LaneInvalid({
      field: "enabled",
      message: `This deployment has no ${MAIL_EVENTS_QUEUE} queue bound (MAIL_EVENTS_QUEUE), so the lane can't run here.`,
    })
  const database = yield* Database
  const ids = input.mailboxIds ? [...new Set(input.mailboxIds)] : null
  if (ids && ids.length > 0) {
    const found = yield* database.query("mailEvents.mailboxes", (db) =>
      db.select({ id: mailboxes.id }).from(mailboxes).where(inArray(mailboxes.id, ids)).all(),
    )
    const missing = ids.filter((id) => !found.some((f) => f.id === id))
    if (missing.length > 0)
      return yield* new LaneInvalid({ field: "mailboxIds", message: `No mailbox ${missing.join(", ")}.` })
  }
  const current = yield* readLane()
  const value: LaneSettings = {
    enabled: input.enabled,
    mailboxIds: input.mailboxIds === undefined ? current.mailboxIds : ids,
    types: input.types === undefined ? current.types : input.types ? [...new Set(input.types)] : null,
    since: input.enabled ? (current.enabled ? current.since : Date.now()) : null,
  }
  const now = Date.now()
  yield* database.query("settings.mailEvents.put", (db) =>
    db
      .insert(settings)
      .values({ key: KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run(),
  )
  cache = { at: now, value }
  return { before: current, after: yield* describeLane() }
})

type Body<T> = T extends unknown ? Omit<T, "version" | "id" | "at"> & { readonly at?: number } : never

/** Puts one event on the lane, if the lane is on and takes this mailbox and type. */
export const publishMailEvent = (event: Body<MailEvent>) =>
  Effect.gen(function* () {
    const lane = yield* laneSettings()
    if (!lane.enabled) return
    if (lane.mailboxIds && !lane.mailboxIds.includes(event.mailboxId)) return
    if (lane.types && !lane.types.includes(event.type)) return
    const env = yield* Bindings
    if (!env.MAIL_EVENTS_QUEUE) return
    const id = `mev_${yield* (yield* Ids).next}`
    const body = { ...event, version: MAIL_EVENTS_VERSION, id, at: event.at ?? Date.now() } as MailEvent
    const queue = env.MAIL_EVENTS_QUEUE
    yield* Effect.tryPromise(() => queue.send(body, { contentType: "json" }))
  }).pipe(
    Effect.catchCause((cause) => Effect.logError(`mail-events: could not publish ${event.type}`, cause)),
  )

/** For tests: forget the cached settings. */
export const resetLaneCache = () => {
  cache = null
}

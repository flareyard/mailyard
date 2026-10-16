import { Ids } from "@flareyard/kit"
import { Effect, Schema } from "effect"
import { events } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { upsertContact } from "./contacts.ts"

export class ReservedEvent extends Schema.TaggedError<ReservedEvent>()("ReservedEvent", {
  event: Schema.String,
}) {}

/** Event names the app records itself (sends, opens, unsubscribes); callers can't fake them. */
export const isReserved = (event: string) => /^(mailflare|email|contact|segment)\./i.test(event)

/**
 * Records an event for a contact, creating the contact if needed. New contacts from events start
 * subscribed, as in Plunk; an existing contact's status only changes when `subscribed` is given.
 */
export const track = Effect.fn("events.track")(function* (input: {
  readonly event: string
  readonly email: string
  readonly subscribed?: boolean | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
}) {
  if (isReserved(input.event)) return yield* new ReservedEvent({ event: input.event })
  const { contact } = yield* upsertContact({
    email: input.email,
    data: input.data,
    subscribed: input.subscribed,
    whenNew: "subscribed",
  })
  const database = yield* Database
  const id = yield* (yield* Ids).next
  const at = Date.now()
  yield* database.query("events.insert", (db) =>
    db
      .insert(events)
      .values({ id, contactId: contact.id, name: input.event, data: input.data ?? null, at })
      .run(),
  )
  return { contact: contact.id, event: id, timestamp: new Date(at).toISOString() }
})

import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { contacts } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { emitSafely } from "./webhooks.ts"

export type ContactRow = typeof contacts.$inferSelect

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
 * tracked events, matching Plunk).
 */
export const upsertContact = Effect.fn("contacts.upsert")(function* (input: {
  readonly email: string
  readonly name?: string | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
  readonly subscribed?: boolean | undefined
  readonly whenNew: "subscribed" | "unsubscribed"
}) {
  const database = yield* Database
  const ids = yield* Ids
  const email = input.email.trim().toLowerCase()
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
    const blocked = ["bounced", "complained", "suppressed"].includes(existing.status)
    const status = explicit && !blocked ? explicit : existing.status
    const name = input.name ?? existing.name
    const updated = yield* database.query("contacts.update", (db) =>
      db
        .update(contacts)
        .set({ fields, status, name, lastActivityAt: now })
        .where(eq(contacts.id, existing.id))
        .returning()
        .get(),
    )
    return { contact: updated, merged: { ...fields, ...transient } }
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
      })
      .returning()
      .get(),
  )
  yield* emitSafely("contact.created", {
    contactId: created.id,
    email: created.email,
    status: created.status,
  })
  return { contact: created, merged: { ...persistent, ...transient } }
})

import { and, asc, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { mailboxImageSenders } from "../db/schema.ts"
import { SENDER_VALUE } from "../rules/manage.ts"
import { Database } from "../services/Database.ts"

/**
 * "Always show images from …" (HAL-3369): a mailbox's list of senders, by address or `@domain`, whose
 * remote images the reader loads without asking. Blocking them is the reader's own default (its frame
 * allows only `data:` and `cid:` images); this only records the exceptions.
 */

export class ImageSenderInvalid extends Schema.TaggedError<ImageSenderInvalid>()("ImageSenderInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

export const listImageSenders = Effect.fn("mail.imageSenders")(function* (mailboxId: string) {
  const database = yield* Database
  const rows = yield* database.query("imageSenders.list", (db) =>
    db
      .select()
      .from(mailboxImageSenders)
      .where(eq(mailboxImageSenders.mailboxId, mailboxId))
      .orderBy(asc(mailboxImageSenders.value))
      .limit(1_000)
      .all(),
  )
  return rows.map((r) => ({ value: r.value, createdBy: r.createdBy, createdAt: r.createdAt }))
})

export const addImageSender = Effect.fn("mail.addImageSender")(function* (
  mailboxId: string,
  raw: string,
  actor: string,
) {
  const value = raw.trim().toLowerCase()
  if (!SENDER_VALUE.test(value))
    return yield* new ImageSenderInvalid({ field: "value", message: `${raw} is neither an address nor @domain.` })
  const database = yield* Database
  const now = Date.now()
  yield* database.query("imageSenders.add", (db) =>
    db
      .insert(mailboxImageSenders)
      .values({ mailboxId, value, createdBy: actor, createdAt: now })
      .onConflictDoNothing()
      .run(),
  )
  return { value, createdBy: actor, createdAt: now }
})

export const removeImageSender = Effect.fn("mail.removeImageSender")(function* (mailboxId: string, raw: string) {
  const database = yield* Database
  const value = raw.trim().toLowerCase()
  yield* database.query("imageSenders.remove", (db) =>
    db
      .delete(mailboxImageSenders)
      .where(and(eq(mailboxImageSenders.mailboxId, mailboxId), eq(mailboxImageSenders.value, value)))
      .run(),
  )
  return { removed: value }
})

/** Whether a sender's images show without asking: the address, or its `@domain`, is listed. */
export const showsImagesFrom = Effect.fn("mail.showsImagesFrom")(function* (
  mailboxId: string,
  address: string | null,
) {
  if (!address) return false
  const lower = address.trim().toLowerCase()
  const domain = lower.slice(lower.lastIndexOf("@") + 1)
  const database = yield* Database
  const hit = yield* database.query("imageSenders.match", (db) =>
    db
      .select({ value: mailboxImageSenders.value })
      .from(mailboxImageSenders)
      .where(
        and(eq(mailboxImageSenders.mailboxId, mailboxId), inArray(mailboxImageSenders.value, [lower, `@${domain}`])),
      )
      .get(),
  )
  return hit !== undefined
})

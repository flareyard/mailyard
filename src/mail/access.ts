import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { mailboxes, mailboxMembers } from "../db/schema.ts"
import type { Caller, Scope } from "../domain/apiKeys.ts"
import { HOLDS_MAIL } from "../domain/mailboxes.ts"
import { Database } from "../services/Database.ts"

export class MailboxAccessDenied extends Schema.TaggedError<MailboxAccessDenied>()("MailboxAccessDenied", {
  message: Schema.String,
}) {}
export class MailboxMissing extends Schema.TaggedError<MailboxMissing>()("MailboxMissing", {
  id: Schema.String,
}) {}

export type Access = "read" | "write" | "send"

/**
 * Who may do what in a mailbox. Root and admin keys may do everything. Otherwise the key needs the
 * matching scope (`read`, or `send` to send) and a membership: viewers read; owners and members also
 * change flags and drafts and send.
 */
export const requireMailbox = Effect.fn("mail.requireMailbox")(function* (
  caller: Caller,
  mailboxId: string,
  need: Access,
) {
  const database = yield* Database
  const mailbox = yield* database.query("mail.mailbox", (db) =>
    db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get(),
  )
  if (!mailbox || !HOLDS_MAIL.has(mailbox.kind)) return yield* new MailboxMissing({ id: mailboxId })
  const scope: Scope = need === "send" ? "send" : "read"
  if (caller.keyId === "root" || caller.scopes.includes("admin")) return { mailbox, role: "admin" as const }
  if (!caller.scopes.includes(scope)) {
    return yield* new MailboxAccessDenied({ message: `This key lacks the "${scope}" scope.` })
  }
  const membership = yield* database.query("mail.membership", (db) =>
    db
      .select({ role: mailboxMembers.role })
      .from(mailboxMembers)
      .where(and(eq(mailboxMembers.mailboxId, mailboxId), eq(mailboxMembers.apiKeyId, caller.keyId)))
      .get(),
  )
  if (!membership)
    return yield* new MailboxAccessDenied({ message: "This key isn't a member of this mailbox." })
  if (need !== "read" && membership.role === "viewer") {
    return yield* new MailboxAccessDenied({
      message: "Viewers can read this mailbox but not change it or send from it.",
    })
  }
  return { mailbox, role: membership.role }
})

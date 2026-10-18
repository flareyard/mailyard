import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { mailboxes, mailboxMembers, mailboxPeople, members } from "../db/schema.ts"
import type { Caller, Scope } from "../domain/apiKeys.ts"
import { HOLDS_MAIL } from "../domain/mailboxes.ts"
import { can, isManager, SEES_ALL_MAILBOXES } from "../domain/permissions.ts"
import { Database } from "../services/Database.ts"

export class MailboxAccessDenied extends Schema.TaggedError<MailboxAccessDenied>()("MailboxAccessDenied", {
  message: Schema.String,
  /** `mailbox_role`: a person with viewer access tried to change or send (M9.2), with who owns it. */
  reason: Schema.optionalKey(Schema.Literals(["mailbox_role", "role"])),
  role: Schema.optionalKey(Schema.String),
  owners: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}
export class MailboxMissing extends Schema.TaggedError<MailboxMissing>()("MailboxMissing", {
  id: Schema.String,
}) {}

export type Access = "read" | "write" | "send"
export type MailboxRole = "owner" | "member" | "viewer"

/** Whether a caller sees every mailbox: root, admin keys, owners and admins, senders and viewers. */
export const seesAllMailboxes = (caller: Caller) =>
  caller.member ? SEES_ALL_MAILBOXES.has(caller.member.role) : caller.keyId === "root" || isManager(caller)

/** The caller's access in one mailbox: a key's membership, or a person's (HAL-3361). */
export const membershipIn = Effect.fn("mail.membershipIn")(function* (caller: Caller, mailboxId: string) {
  const database = yield* Database
  const row = caller.member
    ? yield* database.query("mail.personMembership", (db) =>
        db
          .select({ role: mailboxPeople.role })
          .from(mailboxPeople)
          .where(and(eq(mailboxPeople.mailboxId, mailboxId), eq(mailboxPeople.memberId, caller.keyId)))
          .get(),
      )
    : yield* database.query("mail.membership", (db) =>
        db
          .select({ role: mailboxMembers.role })
          .from(mailboxMembers)
          .where(and(eq(mailboxMembers.mailboxId, mailboxId), eq(mailboxMembers.apiKeyId, caller.keyId)))
          .get(),
      )
  return (row?.role ?? null) as MailboxRole | null
})

/** Every mailbox the caller has been given, with the access in each. */
export const membershipsOf = Effect.fn("mail.membershipsOf")(function* (caller: Caller) {
  const database = yield* Database
  const rows = caller.member
    ? yield* database.query("mail.personMemberships", (db) =>
        db
          .select({ mailboxId: mailboxPeople.mailboxId, role: mailboxPeople.role })
          .from(mailboxPeople)
          .where(eq(mailboxPeople.memberId, caller.keyId))
          .all(),
      )
    : yield* database.query("mail.memberships", (db) =>
        db
          .select({ mailboxId: mailboxMembers.mailboxId, role: mailboxMembers.role })
          .from(mailboxMembers)
          .where(eq(mailboxMembers.apiKeyId, caller.keyId))
          .all(),
      )
  return new Map(rows.map((r) => [r.mailboxId, r.role as MailboxRole]))
})

/** The people who own a mailbox, for a viewer's refusal ("ask Ada or Grace"). */
const ownersOf = Effect.fn("mail.owners")(function* (mailboxId: string) {
  const database = yield* Database
  const rows = yield* database.query("mail.owners", (db) =>
    db
      .select({ name: members.name })
      .from(mailboxPeople)
      .innerJoin(members, eq(members.id, mailboxPeople.memberId))
      .where(and(eq(mailboxPeople.mailboxId, mailboxId), eq(mailboxPeople.role, "owner")))
      .limit(10)
      .all(),
  )
  return rows.map((r) => r.name)
})

/**
 * Who may do what in a mailbox.
 * - Keys: root and admin keys may do everything. Otherwise the key needs the matching scope (`read`,
 *   or `send` to send) and a membership: viewers read; owners and members also change and send.
 * - People (HAL-3361): owners and admins may do everything. Senders and viewers read every mailbox;
 *   agents read only the ones they're given. Changing or sending needs `mail.send` from the role and
 *   owner or member access in the mailbox.
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
  if (caller.keyId === "root" || isManager(caller)) return { mailbox, role: "admin" as const }
  if (caller.member) {
    const membership = yield* membershipIn(caller, mailboxId)
    if (need === "read") {
      if (membership || SEES_ALL_MAILBOXES.has(caller.member.role))
        return { mailbox, role: membership ?? ("viewer" as const) }
      return yield* new MailboxAccessDenied({ message: "You haven't been given this mailbox." })
    }
    if (!can(caller, "mail.send"))
      return yield* new MailboxAccessDenied({
        message: `Your role (${caller.member.role}) can read mail but not change or send it.`,
        reason: "role",
        role: caller.member.role,
      })
    if (!membership)
      return yield* new MailboxAccessDenied({
        message: "You can read this mailbox but haven't been given it to reply or send from.",
      })
    if (membership === "viewer")
      return yield* new MailboxAccessDenied({
        message: "You're a viewer in this mailbox: you can read it but not change it or send from it.",
        reason: "mailbox_role",
        role: "viewer",
        owners: yield* ownersOf(mailboxId),
      })
    return { mailbox, role: membership }
  }
  const scope: Scope = need === "send" ? "send" : "read"
  if (!caller.scopes.includes(scope)) {
    return yield* new MailboxAccessDenied({ message: `This key lacks the "${scope}" scope.` })
  }
  const membership = yield* membershipIn(caller, mailboxId)
  if (!membership)
    return yield* new MailboxAccessDenied({ message: "This key isn't a member of this mailbox." })
  if (need !== "read" && membership === "viewer") {
    return yield* new MailboxAccessDenied({
      message: "Viewers can read this mailbox but not change it or send from it.",
    })
  }
  return { mailbox, role: membership }
})

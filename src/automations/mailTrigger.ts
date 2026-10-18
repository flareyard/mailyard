import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { automations } from "../db/schema.ts"
import { upsertContact } from "../domain/contacts.ts"
import { Database } from "../services/Database.ts"
import { fireTrigger } from "./runs.ts"

/**
 * Starts mail_received automations for a message just filed (HAL-3467). Nothing happens unless a
 * live automation listens, so ordinary inbound mail never creates contacts. The sender becomes the
 * contact, added unconfirmed if new and never subscribed. Automated mail (auto-replies, bulk, list
 * mail) and spam never trigger, so two systems can't start runs off each other's replies. Never fails
 * the filing that called it.
 */
export const fireMailReceived = (input: {
  readonly mailboxId: string
  readonly mailboxAddress: string
  readonly threadId: string
  readonly messageId: string
  readonly from: { readonly address: string; readonly name?: string | null | undefined } | null
  readonly subject: string
  readonly automated: boolean
  readonly spam: boolean
}) =>
  Effect.gen(function* () {
    const sender = input.from?.address?.trim().toLowerCase()
    if (!sender || input.automated || input.spam) return "skipped"
    // The mailbox writing to itself (a forward, a test) isn't someone to start a run for.
    if (sender === input.mailboxAddress.toLowerCase()) return "skipped"
    const database = yield* Database
    const listening = yield* database.query("automations.mailListening", (db) =>
      db
        .select({ id: automations.id })
        .from(automations)
        .where(and(eq(automations.status, "live"), eq(automations.triggerKey, "mail_received")))
        .limit(1)
        .get(),
    )
    if (!listening) return "no automation listening"
    const { contact } = yield* upsertContact({
      email: sender,
      name: input.from?.name ?? undefined,
      whenNew: "unconfirmed",
    })
    yield* fireTrigger({
      kind: "mail_received",
      contactId: contact.id,
      data: {
        mailboxId: input.mailboxId,
        threadId: input.threadId,
        messageId: input.messageId,
        from: sender,
        fromName: input.from?.name ?? null,
        subject: input.subject,
        senderDomain: sender.slice(sender.lastIndexOf("@") + 1),
      },
    })
    return "queued"
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("automations: could not start mail_received runs", cause).pipe(Effect.as("failed")),
    ),
  )

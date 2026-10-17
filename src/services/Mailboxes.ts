import { Context, Effect, Layer, Schema } from "effect"
import { Bindings } from "../Bindings.ts"
import type { FilingOptions, InboundDelivery } from "../mailbox/types.ts"

export class MailboxUnavailable extends Schema.TaggedError<MailboxUnavailable>()("MailboxUnavailable", {
  mailboxId: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Files messages into a mailbox. A MailboxDO per mailbox on Cloudflare. */
export class Mailboxes extends Context.Service<
  Mailboxes,
  {
    deliver(
      mailboxId: string,
      delivery: InboundDelivery,
      filing?: FilingOptions,
    ): Effect.Effect<
      { readonly id: string; readonly stored: boolean; readonly threadId: string },
      MailboxUnavailable
    >
    /** How many messages the mailbox holds. */
    count(mailboxId: string): Effect.Effect<number, MailboxUnavailable>
    /** Deletes everything the mailbox stores. Only after an export (src/domain/mailboxes.ts). */
    erase(mailboxId: string): Effect.Effect<void, MailboxUnavailable>
    /** Gives a sent copy the Message-ID Email Service assigned it. */
    setMessageId(mailboxId: string, id: string, messageId: string): Effect.Effect<void, MailboxUnavailable>
  }
>()("mailyard/Mailboxes") {
  static readonly layer = Layer.effect(
    Mailboxes,
    Effect.gen(function* () {
      const { MAILBOX } = yield* Bindings
      return Mailboxes.of({
        deliver: (mailboxId, delivery, filing) =>
          Effect.tryPromise({
            try: async () => {
              const result = await MAILBOX.get(MAILBOX.idFromName(mailboxId)).deliver(delivery, filing)
              return { id: result.id, stored: result.stored, threadId: result.threadId }
            },
            catch: (cause) => new MailboxUnavailable({ mailboxId, cause }),
          }),
        count: (mailboxId) =>
          Effect.tryPromise({
            try: () => MAILBOX.get(MAILBOX.idFromName(mailboxId)).count(),
            catch: (cause) => new MailboxUnavailable({ mailboxId, cause }),
          }),
        setMessageId: (mailboxId, id, messageId) =>
          Effect.tryPromise({
            try: async () => {
              await MAILBOX.get(MAILBOX.idFromName(mailboxId)).setMessageId(id, messageId)
            },
            catch: (cause) => new MailboxUnavailable({ mailboxId, cause }),
          }),
        erase: (mailboxId) =>
          Effect.tryPromise({
            try: () => MAILBOX.get(MAILBOX.idFromName(mailboxId)).erase(),
            catch: (cause) => new MailboxUnavailable({ mailboxId, cause }),
          }),
      })
    }),
  )
}

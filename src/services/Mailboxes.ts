import { Context, Effect, Layer, Schema } from "effect"
import { Bindings } from "../Bindings.ts"
import type { InboundDelivery } from "../mailbox/types.ts"

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
    ): Effect.Effect<{ readonly id: string; readonly stored: boolean }, MailboxUnavailable>
  }
>()("mailyard/Mailboxes") {
  static readonly layer = Layer.effect(
    Mailboxes,
    Effect.gen(function* () {
      const { MAILBOX } = yield* Bindings
      return Mailboxes.of({
        deliver: (mailboxId, delivery) =>
          Effect.tryPromise({
            try: async () => {
              const result = await MAILBOX.get(MAILBOX.idFromName(mailboxId)).deliver(delivery)
              return { id: result.id, stored: result.stored }
            },
            catch: (cause) => new MailboxUnavailable({ mailboxId, cause }),
          }),
      })
    }),
  )
}

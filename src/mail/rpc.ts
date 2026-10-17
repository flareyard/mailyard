import { Effect, Schema } from "effect"
import { Bindings } from "../Bindings.ts"
import { type MailboxErrorCode, mailboxErrorCode } from "../mailbox/types.ts"
import type { MailboxDO } from "../objects/MailboxDO.ts"
import { MailboxUnavailable } from "../services/Mailboxes.ts"

/** The mailbox refused the request (unknown id, invalid input, a conflict): an answer, not a fault. */
export class MailboxRefused extends Schema.TaggedError<MailboxRefused>()("MailboxRefused", {
  code: Schema.String,
  message: Schema.String,
}) {}

export const refusalCode = (e: MailboxRefused) => e.code as MailboxErrorCode

/**
 * Calls a method on a mailbox's Durable Object. Refusals the store throws (`"<code>: …"`) come back as
 * MailboxRefused; anything else, such as the object being unreachable, as MailboxUnavailable.
 */
export const callMailbox = <A>(mailboxId: string, run: (stub: DurableObjectStub<MailboxDO>) => Promise<A>) =>
  Effect.gen(function* () {
    const { MAILBOX } = yield* Bindings
    return yield* Effect.tryPromise({
      try: () => run(MAILBOX.get(MAILBOX.idFromName(mailboxId))),
      catch: (cause) => {
        const code = mailboxErrorCode(cause)
        if (code) {
          const message = cause instanceof Error ? cause.message.slice(code.length + 1).trim() : String(cause)
          return new MailboxRefused({ code, message })
        }
        return new MailboxUnavailable({ mailboxId, cause })
      },
    })
  })

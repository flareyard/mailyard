import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Env } from "../Bindings.ts"
import { applyEvent, EmailSendingEvent } from "../domain/deliveryEvents.ts"
import { retryDeferred } from "../domain/outbox.ts"
import { deliver, WebhookJob } from "../domain/webhooks.ts"
import { InboundJob, ingest } from "../inbound/pipeline.ts"
import type { appLayer } from "../layers.ts"
import { dispatchDraft, MailboxSendJob } from "../mail/send.ts"
import { SendJob } from "../services/SendQueue.ts"
import { runtimeFor } from "./inbound.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

/** Queue names, as in wrangler.jsonc (and, later, alchemy.run.ts). */
export const SEND_QUEUE = "mailyard-send"
export const EMAIL_EVENTS_QUEUE = "mailyard-email-events"
export const WEBHOOK_QUEUE = "mailyard-webhooks"
export const INBOUND_QUEUE = "mailyard-inbound"
export const MAILBOX_SEND_QUEUE = "mailyard-mailbox-send"

/** Every queue this Worker consumes; test/queues.test.ts checks wrangler.jsonc binds a consumer for each. */
export const CONSUMED_QUEUES = [
  SEND_QUEUE,
  EMAIL_EVENTS_QUEUE,
  WEBHOOK_QUEUE,
  INBOUND_QUEUE,
  MAILBOX_SEND_QUEUE,
] as const

const handle = <T, A>(
  message: Message<unknown>,
  decoded: Option.Option<T>,
  label: string,
  run: (body: T) => Effect.Effect<A, unknown, AppServices>,
) =>
  Effect.gen(function* () {
    if (Option.isNone(decoded)) {
      yield* Effect.logError(`${label}: dropping a malformed message`, message.body)
      return message.ack()
    }
    const exit = yield* Effect.exit(run(decoded.value))
    if (exit._tag === "Success") {
      yield* Effect.logInfo(`${label}: ${String(exit.value)}`)
      return message.ack()
    }
    yield* Effect.logError(`${label}: failed, will retry`, exit.cause)
    return message.retry({ delaySeconds: 60 })
  })

/**
 * One consumer for every queue. A message is acked when handled (or when it can never be handled:
 * malformed), and retried after a minute when something unexpected broke.
 */
export const handleQueue = async (batch: MessageBatch<unknown>, env: Env) => {
  const runtime = runtimeFor(env)
  const program = Effect.forEach(
    batch.messages,
    (message) => {
      if (batch.queue === SEND_QUEUE || batch.queue.startsWith(`${SEND_QUEUE}-`)) {
        return handle(message, Schema.decodeUnknownOption(SendJob)(message.body), "send queue", (job) =>
          retryDeferred(job.messageId),
        )
      }
      if (batch.queue === EMAIL_EVENTS_QUEUE || batch.queue.startsWith(`${EMAIL_EVENTS_QUEUE}-`)) {
        return handle(
          message,
          Schema.decodeUnknownOption(EmailSendingEvent)(message.body),
          "email events",
          (event) => applyEvent(event),
        )
      }
      if (batch.queue === WEBHOOK_QUEUE || batch.queue.startsWith(`${WEBHOOK_QUEUE}-`)) {
        return handle(message, Schema.decodeUnknownOption(WebhookJob)(message.body), "webhooks", (job) =>
          deliver(job.deliveryId),
        )
      }
      if (batch.queue === INBOUND_QUEUE || batch.queue.startsWith(`${INBOUND_QUEUE}-`)) {
        return handle(message, Schema.decodeUnknownOption(InboundJob)(message.body), "inbound", (job) =>
          ingest(job).pipe(Effect.map((o) => `${o.outcome} ${o.id}`)),
        )
      }
      if (batch.queue === MAILBOX_SEND_QUEUE || batch.queue.startsWith(`${MAILBOX_SEND_QUEUE}-`)) {
        return handle(
          message,
          Schema.decodeUnknownOption(MailboxSendJob)(message.body),
          "mailbox send",
          (job) => dispatchDraft(job).pipe(Effect.map((outcome) => `${outcome} ${job.draftId}`)),
        )
      }
      return Effect.logError(`queue ${batch.queue} has no consumer here`).pipe(Effect.as(message.retry()))
    },
    { discard: true },
  )
  await runtime.runPromise(program)
}

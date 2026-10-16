import { Effect, type Layer, ManagedRuntime, Option, Schema } from "effect"
import type { Env } from "../Bindings.ts"
import { applyEvent, EmailSendingEvent } from "../domain/deliveryEvents.ts"
import { retryDeferred } from "../domain/outbox.ts"
import { deliver, WebhookJob } from "../domain/webhooks.ts"
import { appLayer } from "../layers.ts"
import { SendJob } from "../services/SendQueue.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>
let runtime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined

/** Queue names, as in wrangler.jsonc (and, later, alchemy.run.ts). */
export const SEND_QUEUE = "mailflare-send"
export const EMAIL_EVENTS_QUEUE = "mailflare-email-events"
export const WEBHOOK_QUEUE = "mailflare-webhooks"

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
 * One consumer for both queues. A message is acked when handled (or when it can never be handled:
 * malformed), and retried after a minute when something unexpected broke.
 */
export const handleQueue = async (batch: MessageBatch<unknown>, env: Env) => {
  runtime ??= ManagedRuntime.make(appLayer(env))
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
      return Effect.logError(`queue ${batch.queue} has no consumer here`).pipe(Effect.as(message.retry()))
    },
    { discard: true },
  )
  await runtime.runPromise(program)
}

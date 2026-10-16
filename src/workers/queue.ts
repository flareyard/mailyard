import { Effect, type Layer, ManagedRuntime, Schema } from "effect"
import type { Env } from "../Bindings.ts"
import { retryDeferred } from "../domain/outbox.ts"
import { appLayer } from "../layers.ts"
import { SendJob } from "../services/SendQueue.ts"

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof appLayer>>, never> | undefined

/**
 * The send queue's consumer: each message is a deferred `messages_out` row to try again. `attempt`
 * re-enqueues a still-deferred message itself (with its own delay), so a job is always acked here
 * unless something unexpected broke, in which case the queue retries it.
 */
export const handleSendQueue = async (batch: MessageBatch<unknown>, env: Env) => {
  runtime ??= ManagedRuntime.make(appLayer(env))
  for (const message of batch.messages) {
    const job = Schema.decodeUnknownOption(SendJob)(message.body)
    if (job._tag === "None") {
      console.error("send queue: dropping a malformed job", message.body)
      message.ack()
      continue
    }
    const exit = await runtime.runPromiseExit(
      retryDeferred(job.value.messageId).pipe(
        Effect.tap((outcome) => Effect.logInfo(`send queue: ${job.value.messageId} → ${outcome}`)),
      ),
    )
    if (exit._tag === "Success") message.ack()
    else {
      console.error(`send queue: ${job.value.messageId} failed`, String(exit.cause))
      message.retry({ delaySeconds: 60 })
    }
  }
}

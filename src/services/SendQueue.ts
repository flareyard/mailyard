import { Context, Effect, Layer, Schema } from "effect"
import { Bindings } from "../Bindings.ts"

/** A deferred message to try again: the id of its `messages_out` row. */
export const SendJob = Schema.Struct({ messageId: Schema.String })
export type SendJob = typeof SendJob.Type

export class SendQueue extends Context.Service<
  SendQueue,
  { enqueue(job: SendJob, delaySeconds: number): Effect.Effect<void> }
>()("mailflare/SendQueue") {
  static readonly layer = Layer.effect(
    SendQueue,
    Effect.gen(function* () {
      const { SEND_QUEUE } = yield* Bindings
      return SendQueue.of({
        enqueue: (job, delaySeconds) =>
          Effect.promise(() =>
            SEND_QUEUE.send(job, { delaySeconds: Math.min(Math.max(delaySeconds, 0), 43200) }),
          ),
      })
    }),
  )
}

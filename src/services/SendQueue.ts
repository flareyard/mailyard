import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"

/** A deferred message to try again: the id of its `messages_out` row. */
export const SendJob = Schema.Struct({ messageId: Schema.String })
export type SendJob = typeof SendJob.Type

export class SendQueue extends Context.Service<
  SendQueue,
  { enqueue(job: SendJob, delaySeconds: number): Effect.Effect<void> }
>()("mailyard/SendQueue") {
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

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"
import {
  beginLargeExport,
  failLargeExport,
  finishLargeExport,
  writeExportPart,
} from "../exports/contactExport.ts"
import type { appLayer } from "../layers.ts"
import { runtimeFor } from "../workers/inbound.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

const RETRY = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const

/** R2 allows 10,000 parts; at 6 MiB each that's far past any contact list. */
const MAX_PARTS = 10_000

const released = <T>(value: T): T => {
  const disposer = (value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]
  if (typeof disposer === "function") disposer.call(value)
  return value
}

/**
 * Writes a contacts export too big for one request: a multipart upload to R2, one part (at least
 * 5 MiB of CSV) per step, then completes it. Each part is recorded with the position it reached, so
 * a retried step resumes rather than repeating rows.
 */
export class ContactExportWorkflow extends WorkflowEntrypoint<Env, { readonly exportId: string }> {
  override async run(event: WorkflowEvent<{ readonly exportId: string }>, step: WorkflowStep) {
    const runtime = runtimeFor(this.env)
    const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
    const id = event.payload.exportId
    try {
      const begin = released(await step.do("begin", RETRY, () => run(beginLargeExport(id))))
      if (begin.done) return { done: true }
      for (let part = 1; part <= MAX_PARTS; part++) {
        const result = released(await step.do(`part ${part}`, RETRY, () => run(writeExportPart(id, part))))
        if (result.done) break
      }
      const done = released(await step.do("finish", RETRY, () => run(finishLargeExport(id))))
      return { rows: done.rows }
    } catch (cause) {
      await step.do("record the failure", RETRY, () =>
        run(failLargeExport(id, cause instanceof Error ? cause.message.slice(0, 500) : "The export failed.")),
      )
      throw cause
    }
  }
}

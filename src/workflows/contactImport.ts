import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"
import { finishImport, importChunk, startImport } from "../imports/contactImport.ts"
import type { appLayer } from "../layers.ts"
import { runtimeFor } from "../workers/inbound.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

const RETRY = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const

/** Releases a step's result once read (see src/workflows/mailbox.ts: HAL-3244). */
const released = <T>(value: T): T => {
  const disposer = (value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]
  if (typeof disposer === "function") disposer.call(value)
  return value
}

/**
 * Imports a contact CSV: reads the header, then 5,000 rows a step from the byte offset the last
 * step reached, then marks the import completed. Each step commits its rows and counts together
 * (src/imports/contactImport.ts), so a retry picks up exactly where the last commit left off.
 */
export class ContactImportWorkflow extends WorkflowEntrypoint<Env, { readonly importId: string }> {
  override async run(event: WorkflowEvent<{ readonly importId: string }>, step: WorkflowStep) {
    const runtime = runtimeFor(this.env)
    const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
    const id = event.payload.importId

    const start = released(await step.do("header", RETRY, () => run(startImport(id))))
    if (start.failed) return { failed: true }
    let offset = start.offset
    for (let n = 0; ; n++) {
      const from = offset
      const chunk = released(await step.do(`rows ${n}`, RETRY, () => run(importChunk(id, from))))
      if (chunk.failed) return { failed: true }
      offset = chunk.offset
      if (chunk.done) break
    }
    const done = released(await step.do("finish", RETRY, () => run(finishImport(id))))
    return { failed: false, rows: done.rows, created: done.created }
  }
}

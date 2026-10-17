import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type { Effect, Layer } from "effect"
import type { Env } from "../Bindings.ts"
import { exportChunk, failExport, finishExport, planExport } from "../exports/exporter.ts"
import { failImport, finishImport, planImport, runBatch } from "../imports/importer.ts"
import type { appLayer } from "../layers.ts"
import { runtimeFor } from "../workers/inbound.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

/** Retries for a step that talks to the network: a flaky server or a busy R2 shouldn't fail the job. */
const RETRY = {
  retries: { limit: 5, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const

/** The most export steps one instance will take: each writes at least 8 MiB, so this is ~80 GB. */
const MAX_EXPORT_STEPS = 10_000 - 3

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Copies a mailbox from an IMAP server (or an mbox in R2): plan, then one step per batch, each its own
 * checkpoint (a failed batch retries without redoing the others), then finish. Whatever happens, the
 * source password is wiped when the instance ends.
 */
export class MailboxImportWorkflow extends WorkflowEntrypoint<Env, { readonly importId: string }> {
  override async run(event: WorkflowEvent<{ readonly importId: string }>, step: WorkflowStep) {
    const runtime = runtimeFor(this.env)
    const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
    const { importId } = event.payload
    try {
      const plan = await step.do("plan", RETRY, () => run(planImport(importId)))
      for (const [folderIndex, folder] of plan.folders.entries()) {
        for (let batchIndex = 0; batchIndex < folder.batches; batchIndex++) {
          await step.do(`batch ${folderIndex}.${batchIndex}`, RETRY, () =>
            run(runBatch(importId, folderIndex, batchIndex)),
          )
        }
      }
      return await step.do("finish", RETRY, () => run(finishImport(importId)))
    } catch (error) {
      await step.do("fail", () => run(failImport(importId, errorText(error))))
      throw error
    }
  }
}

/** Writes a mailbox's mbox and zip to R2: plan, a step per 8 MiB or more, then finish. */
export class MailboxExportWorkflow extends WorkflowEntrypoint<Env, { readonly exportId: string }> {
  override async run(event: WorkflowEvent<{ readonly exportId: string }>, step: WorkflowStep) {
    const runtime = runtimeFor(this.env)
    const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
    const { exportId } = event.payload
    try {
      const plan = await step.do("plan", RETRY, () => run(planExport(exportId)))
      if (plan.complete) return { messages: 0 }
      for (let n = 0; n < MAX_EXPORT_STEPS; n++) {
        const chunk = await step.do(`chunk ${n}`, RETRY, () => run(exportChunk(exportId)))
        if (chunk.done) break
      }
      return await step.do("finish", RETRY, () => run(finishExport(exportId)))
    } catch (error) {
      await step.do("fail", () => run(failExport(exportId, errorText(error))))
      throw error
    }
  }
}

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"
import { BULK_PAGE, failBulkJob, processBulkPage } from "../domain/contactBulk.ts"
import type { appLayer } from "../layers.ts"
import { runtimeFor } from "../workers/inbound.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

const RETRY = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const

/** 2,000 pages of 500: a million contacts, far past any list a person would act on at once. */
const MAX_PAGES = 2_000

const released = <T>(value: T): T => {
  const disposer = (value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]
  if (typeof disposer === "function") disposer.call(value)
  return value
}

/** A bulk action over more than 1,000 contacts (HAL-3422): one page per step, resumable. */
export class ContactBulkWorkflow extends WorkflowEntrypoint<Env, { readonly jobId: string }> {
  override async run(event: WorkflowEvent<{ readonly jobId: string }>, step: WorkflowStep) {
    const runtime = runtimeFor(this.env)
    const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
    const id = event.payload.jobId
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = released(await step.do(`page ${page}`, RETRY, () => run(processBulkPage(id))))
        if (result.done) return { pages: page, pageSize: BULK_PAGE }
      }
      await step.do("too many pages", RETRY, () =>
        run(failBulkJob(id, "More contacts than one job handles.")),
      )
      return { pages: MAX_PAGES }
    } catch (cause) {
      await step.do("record the failure", RETRY, () =>
        run(
          failBulkJob(id, cause instanceof Error ? cause.message.slice(0, 500) : "The bulk action failed."),
        ),
      )
      throw cause
    }
  }
}

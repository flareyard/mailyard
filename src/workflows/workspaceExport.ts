import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"
import { beginLargeExport, finishLargeExport, writeExportPart } from "../exports/contactExport.ts"
import {
  checkMailParts,
  contactsChild,
  failWorkspaceExport,
  finishWorkspaceExport,
  planWorkspaceExport,
  recordContactsPart,
  startMailPart,
  writeDataPart,
} from "../exports/workspaceExport.ts"
import type { appLayer } from "../layers.ts"
import { runtimeFor } from "../workers/inbound.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

const RETRY = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const

const MAX_CONTACT_PARTS = 10_000
/** Mailbox exports run in their own Workflows; this one checks on them, for at most a day. */
const MAIL_CHECKS = 288
const MAIL_CHECK_EVERY = "5 minutes"

const released = <T>(value: T): T => {
  const disposer = (value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]
  if (typeof disposer === "function") disposer.call(value)
  return value
}

/**
 * The whole workspace in one export (HAL-3451): plans the parts, starts each mailbox's own export,
 * writes contacts as a multipart CSV and the rest as JSON and CSV, waits for the mail, then writes
 * the manifest. Each part is its own step, so a retry redoes only what failed; a part that fails
 * for good is marked failed and the rest still finish.
 */
export class WorkspaceExportWorkflow extends WorkflowEntrypoint<Env, { readonly exportId: string }> {
  override async run(event: WorkflowEvent<{ readonly exportId: string }>, step: WorkflowStep) {
    const runtime = runtimeFor(this.env)
    const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
    const id = event.payload.exportId
    try {
      const plan = released(await step.do("plan", RETRY, () => run(planWorkspaceExport(id))))
      for (const part of plan.filter((p) => p.kind === "mail")) {
        const mailboxId = part.mailboxId as string
        await step.do(`start mail ${mailboxId}`, RETRY, () => run(startMailPart(id, mailboxId)))
      }

      const childId = released(await step.do("contacts child", RETRY, () => run(contactsChild(id))))
      const begun = released(await step.do("contacts begin", RETRY, () => run(beginLargeExport(childId))))
      if (!begun.done) {
        for (let n = 1; n <= MAX_CONTACT_PARTS; n++) {
          const result = released(
            await step.do(`contacts part ${n}`, RETRY, () => run(writeExportPart(childId, n))),
          )
          if (result.done) break
        }
        await step.do("contacts finish", RETRY, () => run(finishLargeExport(childId)))
      }
      await step.do("contacts record", RETRY, () => run(recordContactsPart(id, childId)))

      for (const kind of ["templates", "lists", "settings", "audit"] as const)
        await step.do(`write ${kind}`, RETRY, () => run(writeDataPart(id, kind)))

      for (let n = 0; n < MAIL_CHECKS; n++) {
        const done = released(await step.do(`check mail ${n}`, RETRY, () => run(checkMailParts(id))))
        if (done) break
        await step.sleep(`wait for mail ${n}`, MAIL_CHECK_EVERY)
      }
      await step.do("finish", RETRY, () => run(finishWorkspaceExport(id)))
      return { done: true }
    } catch (cause) {
      await step.do("record the failure", RETRY, () =>
        run(
          failWorkspaceExport(
            id,
            cause instanceof Error ? cause.message.slice(0, 500) : "The export failed.",
          ),
        ),
      )
      throw cause
    }
  }
}

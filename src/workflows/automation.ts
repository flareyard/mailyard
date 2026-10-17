import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import {
  afterWait,
  checkRun,
  eventTypeFor,
  executeNode,
  finishRun,
  holdRun,
  loadRun,
} from "../automations/runs.ts"
import type { Env } from "../Bindings.ts"
import type { appLayer } from "../layers.ts"
import { runtimeFor } from "../workers/inbound.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

const RETRY = {
  retries: { limit: 4, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const
/** A paused automation's runs look again this often. */
const HOLD_MS = 60 * 60_000
/** More steps than any graph has paths (200 nodes), plus holds and deferrals: a guard against a runaway loop. */
const MAX_TURNS = 2_000

const released = <T>(value: T): T => {
  const disposer = (value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]
  if (typeof disposer === "function") disposer.call(value)
  return value
}

/**
 * One contact's run through one automation version (HAL-3300). It starts where the run row says
 * (the trigger, or the step a retried run failed on), and each turn is a check (stop rules, pause)
 * then one step. Waits are durable sleeps; waiting for an event is `waitForEvent`, woken by a
 * tracked event (src/automations/runs.ts wakeWaiting) or timing out.
 */
export class AutomationRunWorkflow extends WorkflowEntrypoint<Env, { readonly runId: string }> {
  override async run(event: WorkflowEvent<{ readonly runId: string }>, step: WorkflowStep) {
    const runtime = runtimeFor(this.env)
    const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
    const { runId } = event.payload

    const start = released(await step.do("load", RETRY, () => run(loadRun(runId))))
    let node: string | null = start.node
    let seq = start.seq
    try {
      for (let turn = 0; turn < MAX_TURNS && node !== null; turn++) {
        const check = released(await step.do(`check ${turn}`, RETRY, () => run(checkRun(runId))))
        if (check.verdict === "stop") {
          await step.do(`stop ${turn}`, RETRY, () => run(finishRun(runId, "exited", check.detail)))
          return { ended: "exited", detail: check.detail }
        }
        if (check.verdict === "hold") {
          const until = Date.now() + HOLD_MS
          await step.do(`hold ${turn}`, RETRY, () => run(holdRun(runId, until)))
          await step.sleep(`paused ${turn}`, HOLD_MS)
          continue
        }
        const at: string = node
        const from = seq
        const out = released(
          await step.do(`step ${turn} ${at}`, RETRY, () => run(executeNode(runId, at, from))),
        )
        seq = out.seq
        if (out.kind === "exit") return { ended: "completed" }
        if ((out.kind === "sleep" || out.kind === "retry") && out.until !== null) {
          await step.sleepUntil(`wait ${turn} ${at}`, new Date(out.until))
          node = out.next
          continue
        }
        if (out.kind === "wait_event" && out.event !== null && out.until !== null) {
          let arrived = false
          try {
            await step.waitForEvent(`event ${turn} ${at}`, {
              type: eventTypeFor(out.event),
              timeout: Math.max(1_000, out.until - Date.now()),
            })
            arrived = true
          } catch {
            arrived = false
          }
          const waitSeq = seq
          const after = released(
            await step.do(`after ${turn} ${at}`, RETRY, () => run(afterWait(runId, at, waitSeq, arrived))),
          )
          node = after.next
          seq = after.seq
          continue
        }
        node = out.next
      }
      if (node !== null)
        await step.do("too long", RETRY, () =>
          run(finishRun(runId, "failed", "The run took too many steps.")),
        )
      return { ended: "completed" }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      await step.do("failed", RETRY, () => run(finishRun(runId, "failed", detail.slice(0, 500))))
      throw cause
    }
  }
}

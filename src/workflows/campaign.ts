import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"
import { finishSend, type Group, pickWinner, planSend, sendChunk, snapshotPage } from "../campaigns/send.ts"
import type { appLayer } from "../layers.ts"
import { runtimeFor } from "../workers/inbound.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

const RETRY = {
  retries: { limit: 5, delay: "15 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const

/** A pause waits this long for a resume before the instance gives up; the campaign stays paused. */
const RESUME_WAIT = "30 days"

/** Releases a step's result once read (see src/workflows/mailbox.ts: HAL-3244). */
const released = <T>(value: T): T => {
  const disposer = (value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]
  if (typeof disposer === "function") disposer.call(value)
  return value
}

/**
 * Sends one campaign: waits for its time, snapshots the audience into R2, then sends chunk by chunk
 * as the governor allows. Between chunks it sleeps until the governor's `retryAt` (the next minute
 * for pacing, the next midnight UTC for the quota). It waits for a resume event while paused, and
 * stops at once when cancelled. With an A/B test, the test group goes first and the rest of the
 * audience gets the winning subject.
 */
export class CampaignSendWorkflow extends WorkflowEntrypoint<
  Env,
  { readonly campaignId: string; readonly origin: string }
> {
  override async run(
    event: WorkflowEvent<{ readonly campaignId: string; readonly origin: string }>,
    step: WorkflowStep,
  ) {
    const runtime = runtimeFor(this.env)
    const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
    const { campaignId: id, origin } = event.payload

    const plan = released(await step.do("plan", RETRY, () => run(planSend(id))))
    if (plan.status === "cancelled") return { sent: 0, cancelled: true }
    if (plan.sendAt > Date.now()) await step.sleepUntil("wait for the send time", new Date(plan.sendAt))

    let page = { after: null as string | null, position: 0, test: 0, main: 0, done: false }
    for (let n = 0; !page.done; n++) {
      const from = page
      page = released(await step.do(`snapshot ${n}`, RETRY, () => run(snapshotPage(id, from))))
    }

    let sent = 0
    let waits = 0
    const sendGroup = async (group: Group, chunks: number) => {
      for (let n = 0; n < chunks; n++) {
        let notBefore = 0
        for (let attempt = 0; ; attempt++) {
          const result = released(
            await step.do(`send ${group} ${n}.${attempt}`, RETRY, () =>
              run(sendChunk(id, group, n, { origin, notBefore })),
            ),
          )
          sent += result.sent
          if (result.state === "done") break
          if (result.state === "cancelled") return "cancelled" as const
          if (result.state === "paused") {
            await step.waitForEvent(`resume ${group} ${n}.${attempt}`, {
              type: "resume",
              timeout: RESUME_WAIT,
            })
            continue
          }
          waits++
          notBefore = result.retryAt
          await step.sleepUntil(`wait ${group} ${n}.${attempt}`, new Date(result.retryAt))
        }
      }
      return "ok" as const
    }

    if ((await sendGroup("test", page.test)) === "cancelled") return { sent, cancelled: true }
    if (plan.ab && page.test > 0) {
      await step.sleep("A/B test window", `${plan.ab.waitHours} hours`)
      released(await step.do("pick the winner", RETRY, () => run(pickWinner(id))))
    }
    if ((await sendGroup("main", page.main)) === "cancelled") return { sent, cancelled: true }
    released(await step.do("finish", RETRY, () => run(finishSend(id))))
    return { sent, waits }
  }
}

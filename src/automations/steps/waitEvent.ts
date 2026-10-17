import { durationMs } from "../graph.ts"
import type { StepDefinition } from "./types.ts"

/** Waits for the contact to do an event, up to a timeout; the run takes the `event` or the `timeout` path. */
export const waitEvent: StepDefinition<"wait_event"> = {
  type: "wait_event",
  validate: (node) =>
    durationMs(node.config.timeout) > 366 * 86_400_000 ? "A timeout is at most a year." : null,
  run: async (node, ctx) => ({
    kind: "wait_event",
    event: node.config.event,
    until: ctx.now + durationMs(node.config.timeout),
    detail: `Waiting for ${node.config.event} for ${node.config.timeout.amount} ${node.config.timeout.unit}.`,
  }),
}

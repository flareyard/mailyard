import { durationMs } from "../graph.ts"
import type { StepDefinition } from "./types.ts"

/** Waits a fixed time. */
export const wait: StepDefinition<"wait"> = {
  type: "wait",
  validate: (node) =>
    durationMs(node.config.duration) > 366 * 86_400_000 ? "A wait is at most a year." : null,
  run: async (node, ctx) => {
    const until = ctx.now + durationMs(node.config.duration)
    return {
      kind: "sleep",
      until,
      detail: `Waiting ${node.config.duration.amount} ${node.config.duration.unit}.`,
    }
  },
}

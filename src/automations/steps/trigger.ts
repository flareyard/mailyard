import type { StepDefinition } from "./types.ts"

/** Where every run starts. Entry is decided before a run exists (src/automations/triggers.ts); here it just moves on. */
export const trigger: StepDefinition<"trigger"> = {
  type: "trigger",
  validate: (node) =>
    node.config.kind === "date" && node.config.repeat === "yearly" && Math.abs(node.config.offsetDays) > 180
      ? "A yearly date trigger can be at most 180 days either side of the date."
      : null,
  run: async () => ({ kind: "next", detail: "Entered." }),
}

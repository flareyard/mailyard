import type { StepDefinition } from "./types.ts"

const DAY = 86_400_000

/** Takes the `yes` or `no` path: does the contact match a rule tree, or did they do an event. */
export const branch: StepDefinition<"branch"> = {
  type: "branch",
  validate: () => null,
  run: async (node, ctx) => {
    const c = node.config
    const yes =
      c.kind === "rule"
        ? await ctx.matches(c.rule)
        : await ctx.didEvent(c.event, c.withinDays ? ctx.now - c.withinDays * DAY : ctx.runStartedAt)
    const what = c.kind === "rule" ? "matches the rule" : `did ${c.event}`
    return {
      kind: "next",
      port: yes ? "yes" : "no",
      detail: yes
        ? `Yes: ${what}.`
        : `No: hasn't ${c.kind === "rule" ? "matched the rule" : `done ${c.event}`}.`,
    }
  },
}

import type { StepDefinition } from "./types.ts"

/** Ends the run. */
export const exit: StepDefinition<"exit"> = {
  type: "exit",
  validate: () => null,
  run: async () => ({ kind: "exit", detail: "Finished." }),
}

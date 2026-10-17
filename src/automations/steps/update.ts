import type { StepDefinition } from "./types.ts"

/** Sets (or, with null, removes) custom fields on the contact. */
export const update: StepDefinition<"update"> = {
  type: "update",
  validate: (node) => {
    const keys = Object.keys(node.config.fields)
    if (keys.length === 0) return "Choose at least one field to set."
    if (keys.length > 20) return "At most 20 fields in one step."
    return null
  },
  run: async (node, ctx) => {
    await ctx.updateFields(node.config.fields)
    return { kind: "next", detail: `Updated ${Object.keys(node.config.fields).join(", ")}.` }
  },
}

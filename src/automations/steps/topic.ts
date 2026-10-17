import type { StepDefinition } from "./types.ts"

/** Subscribes the contact to a topic, or takes them off one. */
export const topic: StepDefinition<"topic"> = {
  type: "topic",
  validate: () => null,
  run: async (node, ctx) => {
    await ctx.setTopic(node.config.topicId, node.config.action)
    return {
      kind: "next",
      detail: `${node.config.action === "subscribe" ? "Subscribed to" : "Unsubscribed from"} ${node.config.topicId}.`,
    }
  },
}

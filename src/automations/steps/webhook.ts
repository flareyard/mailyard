import type { StepDefinition } from "./types.ts"

/** Posts a signed JSON payload about the contact and the run to an HTTPS endpoint; a non-2xx fails the step so it retries. */
export const webhook: StepDefinition<"webhook"> = {
  type: "webhook",
  validate: (node) => {
    try {
      const url = new URL(node.config.url)
      return url.protocol === "https:" ? null : "Webhooks go to https:// addresses."
    } catch {
      return "That isn't a URL."
    }
  },
  run: async (node, ctx) => {
    const { status } = await ctx.webhook(node.config.url, {
      ...(node.config.payload ?? {}),
      contact: {
        id: ctx.contact.id,
        email: ctx.contact.email,
        name: ctx.contact.name,
        fields: ctx.contact.fields,
      },
    })
    if (status < 200 || status >= 300) throw new Error(`The webhook answered ${status}.`)
    return { kind: "next", detail: `Webhook answered ${status}.` }
  },
}

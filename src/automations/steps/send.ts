import type { StepDefinition } from "./types.ts"

/**
 * Sends a template to the contact, through the same path as campaigns: the governor's pacing, the
 * suppression list, the unsubscribe headers and footer. A send over the cadence cap, or to someone
 * who can't be mailed, is skipped and the run goes on.
 */
export const send: StepDefinition<"send"> = {
  type: "send",
  validate: (node) =>
    node.config.subject !== undefined && node.config.subject.trim() === ""
      ? "The subject override is empty."
      : null,
  run: async (node, ctx) => {
    const c = node.config
    const result = await ctx.send({
      templateId: c.templateId,
      version: c.version,
      subject: c.subject ?? null,
      fromAddress: c.fromAddress ?? ctx.settings.fromAddress,
      topicId: c.topicId ?? ctx.settings.topicId,
      trackOpens: c.trackOpens ?? true,
      trackClicks: c.trackClicks ?? true,
    })
    if (result.status === "sent")
      return { kind: "next", detail: `Sent "${result.subject}".`, messageId: result.messageId }
    if (result.status === "deferred") return { kind: "retry", until: result.retryAt, detail: result.detail }
    return {
      kind: "next",
      detail: `Skipped: ${result.detail}`,
      ...(result.status === "skipped" && result.missing ? { missing: result.missing } : {}),
    }
  },
}

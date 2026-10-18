import { DEFAULT_SETTINGS } from "../../src/automations/graph.ts"
import type { SendInput, SendResult, StepContext } from "../../src/automations/steps/index.ts"

/**
 * A StepContext that records what a step asked for instead of doing it, for testing one step on its
 * own (test/automations/steps.test.ts). Override any part with `overrides`; `calls` lists every
 * side effect in order.
 */
export const fakeContext = (overrides: Partial<StepContext> = {}) => {
  const calls: Array<{ readonly kind: string; readonly args: ReadonlyArray<unknown> }> = []
  const record =
    <A extends ReadonlyArray<unknown>, R>(kind: string, result: R) =>
    async (...args: A): Promise<R> => {
      calls.push({ kind, args })
      return result
    }
  const ctx: StepContext = {
    now: Date.UTC(2026, 9, 18, 9),
    runStartedAt: Date.UTC(2026, 9, 18, 9),
    contact: {
      id: "c_1",
      email: "ada@example.com",
      name: "Ada",
      status: "subscribed",
      fields: { plan: "pro" },
    },
    settings: DEFAULT_SETTINGS,
    matches: record("matches", true),
    didEvent: record("didEvent", false),
    send: record<[SendInput], SendResult>("send", {
      status: "sent",
      messageId: "m_1",
      subject: "Hello",
      preview: "Hello",
    }),
    updateFields: record("updateFields", undefined),
    setTopic: record("setTopic", undefined),
    webhook: record("webhook", { status: 200 }),
    ...overrides,
  }
  return { ctx, calls }
}

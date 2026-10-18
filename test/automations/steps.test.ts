import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { GraphNode } from "../../src/automations/graph.ts"
import { runStep, STEPS, validateStep } from "../../src/automations/steps/index.ts"
import { fakeContext } from "./stepContext.ts"

/**
 * One step at a time, against a recording context (HAL-3304): the quickest test to copy for a new
 * step type. The whole-run behaviour (the Workflow, waits, re-entry) is in runs.test.ts and the dry
 * run in dryRun.test.ts.
 */
const decode = Schema.decodeUnknownSync(GraphNode)

describe("automation steps on their own", () => {
  it("has one definition per node type, under its own name", () => {
    for (const [type, step] of Object.entries(STEPS)) expect(step.type).toBe(type)
  })

  it("webhook: posts the contact and the extra payload, and fails on a non-2xx", async () => {
    const node = decode({
      id: "h",
      type: "webhook",
      config: { url: "https://hooks.example.com/x", payload: { source: "drip" } },
    })
    expect(validateStep(node)).toBeNull()
    const { ctx, calls } = fakeContext()
    expect(await runStep(node, ctx)).toEqual({ kind: "next", detail: "Webhook answered 200." })
    expect(calls).toEqual([
      {
        kind: "webhook",
        args: [
          "https://hooks.example.com/x",
          {
            source: "drip",
            contact: { id: "c_1", email: "ada@example.com", name: "Ada", fields: { plan: "pro" } },
          },
        ],
      },
    ])
    const failing = fakeContext({ webhook: async () => ({ status: 500 }) })
    await expect(runStep(node, failing.ctx)).rejects.toThrow("The webhook answered 500.")
  })

  it("webhook: the schema refuses http:// before validate sees it", () => {
    expect(() => decode({ id: "h", type: "webhook", config: { url: "http://x.test" } })).toThrow()
  })

  it("update: sets the fields, and refuses an empty step", async () => {
    const node = decode({ id: "u", type: "update", config: { fields: { plan: "team", trial: null } } })
    const { ctx, calls } = fakeContext()
    expect(await runStep(node, ctx)).toEqual({ kind: "next", detail: "Updated plan, trial." })
    expect(calls).toEqual([{ kind: "updateFields", args: [{ plan: "team", trial: null }] }])
    expect(validateStep(decode({ id: "u", type: "update", config: { fields: {} } }))).toBe(
      "Choose at least one field to set.",
    )
  })
})

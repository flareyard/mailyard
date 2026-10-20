import { describe, expect, it } from "vitest"
import { ApiError } from "../api/client.ts"
import { helperOff, refusalOf, refusalText } from "./assistant.ts"
import { ASSISTANT_OVERRIDES, ASSISTANT_SETTINGS } from "./assistant-fixtures.ts"
import type { MailOverride } from "./fixtures-core.ts"

const run = async (method: string, path: string, body: unknown = {}) => {
  const o = ASSISTANT_OVERRIDES.find((x: MailOverride) => x.method === method && x.path.test(path))
  const m = o ? path.match(o.path) : null
  if (!o || !m) throw new Error(`no fixture for ${method} ${path}`)
  return o.answer(m, body, new URL(`https://fixtures.local${path}`))
}

describe("which helpers the reader offers", () => {
  it("offers a helper only when a provider is set and the helper is on", () => {
    expect(helperOff(ASSISTANT_SETTINGS, "summaries")).toBeNull()
    expect(helperOff({ ...ASSISTANT_SETTINGS, provider: "off" }, "summaries")).toBe("off")
    expect(helperOff({ ...ASSISTANT_SETTINGS, available: false }, "drafts")).toBe("off")
    expect(helperOff({ ...ASSISTANT_SETTINGS, drafts: false }, "drafts")).toBe("disabled")
    expect(helperOff(undefined, "summaries")).toBeNull()
  })

  it("words every refusal for a person, with no ticket numbers", () => {
    const reasons = ["off", "disabled", "cap", "no_answer", "invalid", undefined]
    for (const helper of ["summaries", "drafts"] as const)
      for (const r of reasons) {
        const text = refusalText(r, helper, ASSISTANT_SETTINGS)
        expect(text).not.toMatch(/HAL-\d+/)
        expect(text.length).toBeGreaterThan(10)
      }
    expect(refusalText("off", "summaries")).toBe(
      "AI is off for this Mailyard. An owner can turn it on in Settings → AI.",
    )
    expect(refusalText("disabled", "drafts")).toBe(
      "Drafted replies are off. An owner or admin can turn them on in Settings → AI.",
    )
    expect(refusalText("cap", "summaries", ASSISTANT_SETTINGS)).toBe(
      "This mailbox has used today’s 200 summaries. More are available after 00:00 UTC.",
    )
  })

  it("reads the reason only from an AssistantRefused error", () => {
    expect(refusalOf(new ApiError(409, { _tag: "AssistantRefused", reason: "cap", message: "x" }))).toBe(
      "cap",
    )
    expect(refusalOf(new ApiError(409, { _tag: "Conflict", reason: "busy", message: "x" }))).toBeUndefined()
    expect(refusalOf(new Error("x"))).toBeUndefined()
  })
})

describe("fixture mode", () => {
  it("summarises a thread from its messages, and marks a refresh as new", async () => {
    const first = await run("POST", "/v1/mailboxes/mbx_support/threads/thr_08/summary")
    expect(first?.status).toBe(200)
    const body = first?.body as { summary: string; cached: boolean; bullets: string[] }
    expect(body.summary).toContain("Partner sync")
    expect(body.cached).toBe(true)
    const again = await run("POST", "/v1/mailboxes/mbx_support/threads/thr_08/summary", { refresh: true })
    expect(again).toMatchObject({ body: { cached: false } })
  })

  it("drafts a reply as an ordinary draft, and refuses past the cap", async () => {
    const r = await run("POST", "/v1/mailboxes/mbx_support/threads/thr_08/draft")
    expect(r?.status).toBe(200)
    expect(r).toMatchObject({ body: { draft: { id: expect.stringMatching(/^drf_fx/) } } })
    const capped = await run("POST", "/v1/mailboxes/mbx_support/threads/thr_broken/draft")
    expect(capped).toMatchObject({ status: 409, body: { _tag: "AssistantRefused", reason: "cap" } })
  })
})

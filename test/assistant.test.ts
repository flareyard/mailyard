import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { jsonIn } from "../src/domain/assistant.ts"
import { Assistant, replyText } from "../src/services/Assistant.ts"
import { chatCompletionsUrl } from "../src/services/Classifier.ts"
import { handleEmail } from "../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "./dns.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

/** HAL-3305: the helpers, against the fixed provider the test Worker is configured with. */
installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

type Settings = {
  summaries: boolean
  drafts: boolean
  categories: boolean
  segments: boolean
  dailyCallsPerMailbox: number
  provider: string
  available: boolean
  today: { byFeature: Array<{ feature: string; calls: number; inputTokens: number; outputTokens: number }> }
}
const OFF = { summaries: false, drafts: false, categories: false, segments: false, dailyCallsPerMailbox: 200 }
const setHelpers = (body: Partial<typeof OFF>) => admin("/v1/settings/assistant", "PUT", { ...OFF, ...body })

const setup = async () => {
  const domain = `as-${uid()}.test`
  setDns(goodDomain(domain))
  await admin("/v1/domains", "POST", { name: domain })
  const box = await json<{ id: string; address: string }>(
    await admin("/v1/mailboxes", "POST", { address: `help@${domain}`, kind: "user" }),
  )
  return { domain, box }
}

const receive = async (to: string, subject: string, headers = "") => {
  const from = `ada-${uid()}@example.org`
  const raw = `From: Ada <${from}>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${uid()}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n${headers}\r\nMy order #42 arrived broken. Can I get a refund?\r\n`
  const bytes = new TextEncoder().encode(raw)
  const outcome = (await handleEmail(
    {
      from,
      to,
      headers: new Headers(),
      raw: new Blob([bytes]).stream(),
      rawSize: bytes.byteLength,
      canBeForwarded: true,
      setReject: () => {},
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage,
    env,
  )) as { outcome: string }
  expect(outcome.outcome).toBe("filed")
}

const threadOf = async (mailboxId: string) =>
  (
    await json<{ threads: Array<{ id: string; labelIds: string[] }> }>(
      await admin(`/v1/mailboxes/${mailboxId}/threads`),
    )
  ).threads[0]

describe("the assistant helpers (HAL-3305)", () => {
  it("are all off by default, and refuse with a reason", async () => {
    await setHelpers({})
    const view = await json<Settings>(await admin("/v1/settings/assistant"))
    expect(view).toMatchObject({ ...OFF, provider: "fixed", available: true })
    const { box } = await setup()
    await receive(box.address, "Refund")
    const thread = await threadOf(box.id)
    const res = await admin(`/v1/mailboxes/${box.id}/threads/${thread?.id}/summary`, "POST", {})
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ reason: "disabled" })
    // Nothing was labelled while categories are off.
    expect(thread?.labelIds).toEqual([])
  })

  it("summarises a thread once per version, and counts the call and its tokens", async () => {
    await setHelpers({ summaries: true })
    const { box } = await setup()
    await receive(box.address, "Refund")
    const thread = await threadOf(box.id)
    const path = `/v1/mailboxes/${box.id}/threads/${thread?.id}/summary`
    const first = await json<{ summary: string; bullets: string[]; cached: boolean; version: string }>(
      await admin(path, "POST", {}),
    )
    expect(first).toMatchObject({
      summary: "Ada asks for a refund because order #42 arrived broken.",
      bullets: ["Order #42 arrived broken", "Wants a refund"],
      cached: false,
    })
    const again = await json<{ cached: boolean; version: string }>(await admin(path, "POST", {}))
    expect(again).toMatchObject({ cached: true, version: first.version })
    const refreshed = await json<{ cached: boolean }>(await admin(path, "POST", { refresh: true }))
    expect(refreshed.cached).toBe(false)
    const usage = await env.DB.prepare(
      "select calls, input_tokens, output_tokens from assistant_usage where mailbox_id = ? and feature = 'summary'",
    )
      .bind(box.id)
      .first<{ calls: number; input_tokens: number; output_tokens: number }>()
    expect(usage?.calls).toBe(2)
    expect(usage?.input_tokens).toBeGreaterThan(0)
    expect(usage?.output_tokens).toBeGreaterThan(0)
  })

  it("stops at the daily cap", async () => {
    await setHelpers({ summaries: true, dailyCallsPerMailbox: 1 })
    const { box } = await setup()
    await receive(box.address, "Refund")
    const thread = await threadOf(box.id)
    const path = `/v1/mailboxes/${box.id}/threads/${thread?.id}/summary`
    expect((await admin(path, "POST", { refresh: true })).status).toBe(200)
    const capped = await admin(path, "POST", { refresh: true })
    expect(capped.status).toBe(409)
    expect(await json(capped)).toMatchObject({ reason: "cap" })
    await setHelpers({})
  })

  it("drafts a reply as a normal draft, and sends nothing", async () => {
    await setHelpers({ drafts: true })
    const { box } = await setup()
    await receive(box.address, "Refund")
    const thread = await threadOf(box.id)
    const res = await admin(`/v1/mailboxes/${box.id}/threads/${thread?.id}/draft`, "POST", {
      instructions: "Say the refund has started",
    })
    expect(res.status).toBe(200)
    const { draft } = await json<{
      draft: { id: string; subject: string; bodyText: string; status: string; to: Array<{ address: string }> }
    }>(res)
    expect(draft).toMatchObject({ subject: "Re: Refund", status: "draft" })
    expect(draft.bodyText).toContain("I've started a refund")
    expect(draft.to[0]?.address).toMatch(/^ada-.*@example\.org$/)
    const sent = await env.DB.prepare("select count(*) as n from messages_out where mailbox_id = ?")
      .bind(box.id)
      .first<{ n: number }>()
    expect(sent?.n).toBe(0)
    // A reader can't make the mailbox write a draft.
    const reader = await createKey("secret", ["read"])
    expect(
      (
        await call(`/v1/mailboxes/${box.id}/threads/${thread?.id}/draft`, {
          method: "POST",
          key: reader.key,
          json: {},
        })
      ).status,
    ).toBe(403)
    await setHelpers({})
  })

  it("labels incoming mail with its category when categories are on, never spam", async () => {
    await setHelpers({ categories: true })
    const { box } = await setup()
    await receive(box.address, "Your receipt")
    const thread = await threadOf(box.id)
    const labels = await json<{ labels: Array<{ id: string; name: string }> }>(
      await admin(`/v1/mailboxes/${box.id}/labels`),
    )
    const updates = labels.labels.find((l) => l.name === "Updates")
    expect(updates).toBeDefined()
    expect(thread?.labelIds).toContain(updates?.id)
    await setHelpers({})
  })

  it("turns a sentence into a checked segment with its count, and saves nothing", async () => {
    await setHelpers({ segments: true })
    await admin("/v1/contacts", "POST", {
      email: `pro-${uid()}@example.net`,
      status: "subscribed",
      fields: { plan: "pro" },
    })
    const before = await env.DB.prepare("select count(*) as n from segments").first<{ n: number }>()
    const res = await admin("/v1/segments/from-text", "POST", { text: "subscribers on the pro plan" })
    expect(res.status).toBe(200)
    const body = await json<{ rule: { type: string; rules: unknown[] }; explanation: string; count: number }>(
      res,
    )
    expect(body.rule).toEqual({
      type: "all",
      rules: [
        { type: "field", field: "plan", op: "eq", value: "pro" },
        { type: "status", in: ["subscribed"] },
      ],
    })
    expect(body.explanation).toBe("Subscribed contacts on the pro plan.")
    expect(body.count).toBeGreaterThanOrEqual(1)
    const after = await env.DB.prepare("select count(*) as n from segments").first<{ n: number }>()
    expect(after?.n).toBe(before?.n)
    await setHelpers({})
  })
})

describe("the Assistant service (HAL-3305)", () => {
  it("takes an endpoint's base or its full chat completions URL", () => {
    expect(chatCompletionsUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/chat/completions")
    expect(chatCompletionsUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/chat/completions")
    // The install form asks for this one; it used to become …/chat/completions/chat/completions.
    expect(chatCompletionsUrl("https://api.openai.com/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    )
  })

  it("reads both reply shapes Workers AI gives, and JSON wrapped in prose", () => {
    expect(replyText({ response: " ok " })).toBe("ok")
    expect(replyText({ choices: [{ message: { content: "Hi" } }] })).toBe("Hi")
    expect(replyText({ choices: [{ message: { content: null } }] })).toBeNull()
    expect(jsonIn('Sure! ```json\n{"category":"social"}\n```')).toEqual({ category: "social" })
    expect(jsonIn("no json here")).toBeNull()
  })

  it("asks Workers AI with thinking off and counts its tokens, and answers nothing when it fails", async () => {
    const seen: Array<Record<string, unknown>> = []
    const ai = {
      run: async (model: string, input: Record<string, unknown>) => {
        seen.push({ model, ...input })
        return {
          choices: [{ message: { content: "A summary." } }],
          usage: { prompt_tokens: 40, completion_tokens: 5, neurons: 1.5 },
        }
      },
    } as unknown as Ai
    const reply = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Assistant).complete({
          feature: "summary",
          system: "s",
          user: "u",
          maxTokens: 50,
        })
      }).pipe(Effect.provide(Assistant.layerWorkersAi(ai, "@cf/zai-org/glm-4.7-flash", undefined))),
    )
    expect(reply).toMatchObject({
      text: "A summary.",
      inputTokens: 40,
      outputTokens: 5,
      neurons: 1.5,
      source: "workers-ai",
    })
    expect(seen[0]).toMatchObject({
      model: "@cf/zai-org/glm-4.7-flash",
      chat_template_kwargs: { enable_thinking: false },
    })
    const failing = { run: async () => Promise.reject(new Error("boom")) } as unknown as Ai
    const none = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Assistant).complete({
          feature: "summary",
          system: "s",
          user: "u",
          maxTokens: 50,
        })
      }).pipe(Effect.provide(Assistant.layerWorkersAi(failing, "m", undefined))),
    )
    expect(none.text).toBeNull()
  })
})

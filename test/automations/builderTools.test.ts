import { afterEach, describe, expect, it } from "vitest"
import type { Graph } from "../../src/automations/graph.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

/** Requests the worker makes to https://hooks.test, answered by `answer`. */
const received: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
let answer: () => Response | Promise<Response> = () => new Response("thanks", { status: 202 })
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  if (new URL(request.url).hostname !== "hooks.test") return realFetch(input, init)
  received.push({
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body: JSON.parse(await request.text()),
  })
  return answer()
}) as typeof fetch
afterEach(() => {
  received.length = 0
  answer = () => new Response("thanks", { status: 202 })
})

const settingsFor = (from: string) => ({
  fromAddress: from,
  topicId: null,
  reentry: { mode: "never" },
  cadence: null,
  stopEvents: [],
})

const setup = async () => {
  const domain = `bt-${uid()}.test`
  setDns(goodDomain(domain))
  await admin("/v1/domains", "POST", { name: domain, sending: true, receiving: false })
  return { from: `Team <team@${domain}>` }
}

const create = async (graph: Graph, from: string) => {
  const res = await admin("/v1/automations", "POST", {
    name: `B ${uid()}`,
    graph,
    settings: settingsFor(from),
  })
  return (await json<{ id: string }>(res)).id
}

const webhookGraph = (url: string): Graph =>
  ({
    nodes: [
      { id: "t", type: "trigger", config: { kind: "event", event: "ordered" } },
      { id: "h", type: "webhook", config: { url, payload: { source: "builder" } } },
      { id: "x", type: "exit", config: {} },
    ],
    edges: [
      { from: "t", to: "h" },
      { from: "h", to: "x" },
    ],
  }) as unknown as Graph

type TestResult = {
  status: number
  ok: boolean
  tookMs: number
  error: string | null
  response: string | null
  url: string
  contact: { id: string; email: string; sample: boolean }
}

describe("testing one webhook step (HAL-3417)", () => {
  it("sends the step's request, signed and marked as a test, about a sample or a real contact", async () => {
    const { from } = await setup()
    const id = await create(webhookGraph("https://hooks.test/orders?token=secret"), from)
    const res = await admin(`/v1/automations/${id}/nodes/h/test`, "POST", {})
    expect(res.status).toBe(200)
    const result = await json<TestResult>(res)
    expect(result).toMatchObject({
      status: 202,
      ok: true,
      error: null,
      response: "thanks",
      // The query string can hold a token: it's left out of the answer.
      url: "https://hooks.test/orders",
      contact: { sample: true },
    })
    expect(result.tookMs).toBeGreaterThanOrEqual(0)
    expect(received).toHaveLength(1)
    const [sent] = received
    expect(sent?.url).toBe("https://hooks.test/orders?token=secret")
    expect(sent?.headers["x-mailyard-test"]).toBe("true")
    expect(sent?.headers["webhook-signature"]).toMatch(/^v1,/)
    expect(sent?.headers["webhook-id"]).toMatch(/^test:h:/)
    expect(sent?.body).toMatchObject({
      type: "automation.webhook",
      test: true,
      automationId: id,
      runId: null,
      step: "h",
      source: "builder",
      contact: { email: "test.contact@example.com" },
    })

    const person = await json<{ id: string; email: string }>(
      await admin("/v1/contacts", "POST", {
        email: `p-${uid()}@example.net`,
        name: "Grace",
        fields: { plan: "pro" },
      }),
    )
    const real = await json<TestResult>(
      await admin(`/v1/automations/${id}/nodes/h/test`, "POST", { contactId: person.id }),
    )
    expect(real.contact).toEqual({ id: person.id, email: person.email, sample: false })
    expect(received[1]?.body.contact).toMatchObject({
      email: person.email,
      name: "Grace",
      fields: { plan: "pro" },
    })
  })

  it("reports a failing endpoint and a timeout without throwing", async () => {
    const { from } = await setup()
    const id = await create(webhookGraph("https://hooks.test/down"), from)
    answer = () => new Response("nope", { status: 500 })
    expect(
      await json<TestResult>(await admin(`/v1/automations/${id}/nodes/h/test`, "POST", {})),
    ).toMatchObject({
      status: 500,
      ok: false,
      response: "nope",
    })
    answer = () => {
      throw new DOMException("timed out", "TimeoutError")
    }
    expect(
      await json<TestResult>(await admin(`/v1/automations/${id}/nodes/h/test`, "POST", {})),
    ).toMatchObject({
      status: 0,
      ok: false,
      error: "timeout",
    })
  })

  it("refuses a step that isn't a webhook, an unknown step or contact, and a read-only key", async () => {
    const { from } = await setup()
    const id = await create(webhookGraph("https://hooks.test/x"), from)
    const notWebhook = await admin(`/v1/automations/${id}/nodes/x/test`, "POST", {})
    expect(notWebhook.status).toBe(400)
    expect(await json(notWebhook)).toMatchObject({ field: "nodeId" })
    expect((await admin(`/v1/automations/${id}/nodes/nope/test`, "POST", {})).status).toBe(400)
    expect(
      (await admin(`/v1/automations/${id}/nodes/h/test`, "POST", { contactId: "con_nope" })).status,
    ).toBe(400)
    expect((await admin("/v1/automations/aut_nope/nodes/h/test", "POST", {})).status).toBe(404)
    const reader = await createKey("secret", ["read"])
    expect(
      (await call(`/v1/automations/${id}/nodes/h/test`, { method: "POST", key: reader.key, json: {} }))
        .status,
    ).toBe(403)
    expect(received).toEqual([])
  })
})

describe("an event's data keys (HAL-3417)", () => {
  it("lists the keys recent events carried, nested as dotted keys, newest example first", async () => {
    const name = `ordered_${uid()}`
    const track = async (data: Record<string, unknown>) => {
      const r = await call("/v1/track", {
        method: "POST",
        key: ADMIN,
        json: { event: name, email: `k-${uid()}@example.net`, data },
      })
      expect(r.status).toBe(200)
    }
    await track({ plan: "basic", order: { total: 10, items: [1] } })
    await track({ plan: "pro", order: { total: 25, currency: "USD" }, coupon: null })
    const res = await admin(`/v1/events/${name}/keys`)
    expect(res.status).toBe(200)
    const body = await json<{
      name: string
      sampled: number
      keys: Array<{ key: string; tag: string; seen: number; types: string[]; example: unknown }>
    }>(res)
    expect(body).toMatchObject({ name, sampled: 2 })
    const byKey = Object.fromEntries(body.keys.map((k) => [k.key, k]))
    expect(byKey.plan).toMatchObject({ tag: "trigger.plan", seen: 2, types: ["string"], example: "pro" })
    expect(byKey["order.total"]).toMatchObject({ seen: 2, types: ["number"], example: 25 })
    expect(byKey["order.items"]).toMatchObject({ seen: 1, types: ["array"], example: "[1 item]" })
    expect(byKey["order.currency"]).toMatchObject({ seen: 1, example: "USD" })
    expect(byKey.coupon).toMatchObject({ seen: 1, types: ["null"], example: null })
    // The most common keys first.
    expect(body.keys.slice(0, 2).map((k) => k.seen)).toEqual([2, 2])

    const none = await json<{ sampled: number; keys: unknown[] }>(
      await admin(`/v1/events/never_${uid()}/keys`),
    )
    expect(none).toMatchObject({ sampled: 0, keys: [] })
  })
})

describe("dry run names the missing merge fields (HAL-3417)", () => {
  it("adds missing to a skipped send", async () => {
    const { from } = await setup()
    const template = (
      await json<{ id: string }>(
        await admin("/v1/templates", "POST", {
          name: `t-${uid()}`,
          kind: "html",
          subject: "For {{ first_name }}",
          source: "<p>{{ trigger.offer_url }}</p>",
          publish: true,
        }),
      )
    ).id
    const id = await create(
      {
        nodes: [
          { id: "t", type: "trigger", config: { kind: "event", event: "joined" } },
          { id: "s", type: "send", config: { templateId: template, version: "published" } },
          { id: "x", type: "exit", config: {} },
        ],
        edges: [
          { from: "t", to: "s" },
          { from: "s", to: "x" },
        ],
      } as unknown as Graph,
      from,
    )
    const res = await admin(`/v1/automations/${id}/dry-run`, "POST", { contact: { email: "d@example.com" } })
    expect(res.status).toBe(200)
    const run = await json<{ path: Array<{ nodeId: string; outcome: string; missing?: string[] }> }>(res)
    const step = run.path.find((p) => p.nodeId === "s")
    expect(step).toMatchObject({ outcome: "skipped" })
    expect([...(step?.missing ?? [])].sort()).toEqual(["first_name", "trigger.offer_url"])
  })
})

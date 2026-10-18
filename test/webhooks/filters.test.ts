import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { sampleEventData } from "../../src/domain/webhookSamples.ts"
import { WEBHOOK_EVENTS } from "../../src/domain/webhooks.ts"
import worker from "../../src/workers/api.ts"
import { handleEmail } from "../../src/workers/inbound.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)

/** Requests the worker makes to https://hooks.test. */
const received: Array<{ headers: Record<string, string>; body: string }> = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  if (new URL(request.url).hostname !== "hooks.test") return realFetch(input, init)
  received.push({ headers: Object.fromEntries(request.headers), body: await request.text() })
  return new Response("ok", { status: 200 })
}) as typeof fetch
afterEach(() => {
  received.length = 0
})

const runDelivery = async (deliveryId: string) => {
  const batch = createMessageBatch("mailyard-webhooks", [
    { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { deliveryId } },
  ])
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  return getQueueResult(batch, ctx)
}

type Endpoint = { id: string; filter: Record<string, string[]> | null; paused: boolean; held: number }
type Delivery = {
  id: string
  eventType: string
  status: string
  requestId: string | null
  payload: { type: string; data: Record<string, unknown> }
}

const hook = async (body: Record<string, unknown>) => {
  const res = await call("/v1/webhooks", {
    method: "POST",
    key: ADMIN,
    json: { url: `https://hooks.test/${uid()}`, ...body },
  })
  if (res.status !== 200) throw new Error(`hook ${res.status} ${await res.text()}`)
  return (await json<{ endpoint: Endpoint }>(res)).endpoint
}

const deliveries = async (endpointId: string) =>
  (
    await json<{ deliveries: Delivery[] }>(
      await call(`/v1/webhooks/${endpointId}/deliveries?limit=100`, { key: ADMIN }),
    )
  ).deliveries

const mailbox = async () => {
  const domain = `hooks-${uid()}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  return json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `support@${domain}`, kind: "user" },
    }),
  )
}

const receive = async (to: string, subject: string) => {
  const raw = `From: Ada <ada@example.org>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${uid()}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n\r\nHello\r\n`
  const bytes = new TextEncoder().encode(raw)
  const outcome = await handleEmail(
    {
      from: "ada@example.org",
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
  )
  if (outcome?.outcome !== "filed") throw new Error("not filed")
}

describe("webhook filters, pausing, samples and request ids (HAL-3464)", () => {
  it("delivers mail.received only for the filtered mailbox, and nothing that lacks the field", async () => {
    const support = await mailbox()
    const sales = await mailbox()
    const endpoint = await hook({
      events: ["mail.received", "contact.created"],
      filter: { mailboxIds: [support.id] },
    })
    expect(endpoint.filter).toEqual({ mailboxIds: [support.id] })
    await receive(support.address, "For support")
    await receive(sales.address, "For sales")
    // A contact event has no mailbox, so a mailbox-filtered endpoint doesn't get it.
    await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: `f-${uid()}@example.net` } })
    const got = await deliveries(endpoint.id)
    expect(got.map((d) => d.eventType)).toEqual(["mail.received"])
    expect(got[0]?.payload.data).toMatchObject({ mailboxId: support.id, subject: "For support" })

    // PATCH widens it; null removes the filter; empty lists mean no filter.
    const patched = await json<Endpoint>(
      await call(`/v1/webhooks/${endpoint.id}`, { method: "PATCH", key: ADMIN, json: { filter: null } }),
    )
    expect(patched.filter).toBeNull()
    await receive(sales.address, "Now for sales too")
    expect((await deliveries(endpoint.id)).filter((d) => d.eventType === "mail.received")).toHaveLength(2)
    const empty = await hook({ events: ["*"], filter: { mailboxIds: [], streams: [] } })
    expect(empty.filter).toBeNull()
  })

  it("filters message events by stream", async () => {
    const endpoint = await hook({
      events: ["message.sent", "message.rejected"],
      filter: { streams: ["campaign"] },
    })
    const transactional = await hook({ events: ["message.sent"], filter: { streams: ["transactional"] } })
    await call("/v1/send", {
      method: "POST",
      key: ADMIN,
      json: { to: `s-${uid()}@example.net`, subject: "Hi", body: "<p>Hi</p>", from: "hello@mailyard.test" },
    })
    expect(await deliveries(endpoint.id)).toHaveLength(0)
    const sent = await deliveries(transactional.id)
    expect(sent.map((d) => d.eventType)).toEqual(["message.sent"])
    expect(sent[0]?.payload.data).toMatchObject({
      stream: "transactional",
      campaignId: null,
      mailboxId: null,
    })
  })

  it("holds deliveries while paused, sends them in order on unpause, and drops nothing", async () => {
    const endpoint = await hook({ events: ["contact.created"], paused: true })
    expect(endpoint.paused).toBe(true)
    const emails = [`p1-${uid()}@example.net`, `p2-${uid()}@example.net`]
    for (const email of emails) await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email } })
    const held = await deliveries(endpoint.id)
    expect(held.map((d) => d.status)).toEqual(["paused", "paused"])
    expect((await json<Endpoint>(await call(`/v1/webhooks/${endpoint.id}`, { key: ADMIN }))).held).toBe(2)
    // A job that was already queued when it paused is held too, not sent.
    expect(await runDelivery(held[0]?.id ?? "")).toBeDefined()
    expect(received).toHaveLength(0)

    const unpaused = await json<Endpoint>(
      await call(`/v1/webhooks/${endpoint.id}`, { method: "PATCH", key: ADMIN, json: { paused: false } }),
    )
    expect(unpaused).toMatchObject({ paused: false, held: 0 })
    const pending = await deliveries(endpoint.id)
    expect(pending.every((d) => d.status === "pending")).toBe(true)
    for (const d of [...pending].reverse()) await runDelivery(d.id)
    expect(received.map((r) => (JSON.parse(r.body) as { data: { email: string } }).data.email)).toEqual(
      emails,
    )
  })

  it("puts the API request's id on the delivery and its x-mailyard-request-id header", async () => {
    const endpoint = await hook({ events: ["contact.created"] })
    const res = await call("/v1/contacts", {
      method: "POST",
      key: ADMIN,
      json: { email: `r-${uid()}@example.net` },
      headers: { "cf-ray": "9a8b7c6d5e4f3a21-LOS" },
    })
    expect(res.headers.get("x-request-id")).toBe("9a8b7c6d5e4f3a21-LOS")
    const [delivery] = await deliveries(endpoint.id)
    expect(delivery?.requestId).toBe("9a8b7c6d5e4f3a21-LOS")
    await runDelivery(delivery?.id ?? "")
    expect(received[0]?.headers["x-mailyard-request-id"]).toBe("9a8b7c6d5e4f3a21-LOS")
    // Mail arriving isn't an API request: no id, and no header.
    const box = await mailbox()
    const inbound = await hook({ events: ["mail.received"], filter: { mailboxIds: [box.id] } })
    await receive(box.address, "No request")
    const [mailDelivery] = await deliveries(inbound.id)
    expect(mailDelivery?.requestId).toBeNull()
  })

  it("sends a realistic sample of any event type, matching what the real event carries", async () => {
    const endpoint = await hook({ events: ["*"], paused: true })
    const res = await call(`/v1/webhooks/${endpoint.id}/test`, {
      method: "POST",
      key: ADMIN,
      json: { event: "mail.received" },
    })
    expect(await json(res)).toMatchObject({ eventType: "mail.received" })
    const [sample] = (await deliveries(endpoint.id)).filter((d) => d.eventType === "mail.received")
    expect(sample?.payload.data).toMatchObject({ sample: true, mailboxId: "mbx_sample" })
    // A test goes out even while the endpoint is paused.
    expect(sample?.status).toBe("pending")
    expect(
      await json(await call(`/v1/webhooks/${endpoint.id}/test`, { method: "POST", key: ADMIN })),
    ).toMatchObject({
      eventType: "webhook.test",
    })

    // Every event type has a sample, and those with a real counterpart here have its exact fields.
    for (const type of WEBHOOK_EVENTS) expect(sampleEventData(type).sample).toBe(true)
    const box = await mailbox()
    const real = await hook({ events: ["mail.received", "contact.created", "message.sent"] })
    await receive(box.address, "Real one")
    await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: `k-${uid()}@example.net` } })
    await call("/v1/send", {
      method: "POST",
      key: ADMIN,
      json: { to: `k-${uid()}@example.net`, subject: "Hi", body: "<p>Hi</p>", from: "hello@mailyard.test" },
    })
    const byType = new Map((await deliveries(real.id)).map((d) => [d.eventType, d.payload.data]))
    for (const type of ["mail.received", "contact.created", "message.sent"] as const) {
      const realKeys = Object.keys(byType.get(type) ?? {}).sort()
      const sampleKeys = Object.keys(sampleEventData(type))
        .filter((k) => k !== "sample")
        .sort()
      expect({ type, keys: sampleKeys }).toEqual({ type, keys: realKeys })
    }
  })
})

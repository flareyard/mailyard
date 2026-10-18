import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import worker from "../../src/workers/api.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"

let secret = ""
beforeAll(async () => {
  secret = (await createKey("secret")).key
})

/** Requests the worker makes to https://hooks.test, answered with whatever status the test sets. */
const received: Array<{ url: string; headers: Record<string, string>; body: string }> = []
let answer = 200
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  if (new URL(request.url).hostname !== "hooks.test") return realFetch(input, init)
  received.push({
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body: await request.text(),
  })
  return new Response(answer >= 400 ? "nope" : "ok", { status: answer })
}) as typeof fetch
afterEach(() => {
  received.length = 0
  answer = 200
})

/** Standard Webhooks verification, written independently of src/domain/webhooks.ts. */
const verify = async (whsec: string, headers: Record<string, string>, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(whsec.slice("whsec_".length)), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
  const [version, sig] = (headers["webhook-signature"] ?? "").split(",")
  if (version !== "v1" || !sig) return false
  return crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)),
    new TextEncoder().encode(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`),
  )
}

const runDelivery = async (deliveryId: string) => {
  const batch = createMessageBatch("mailyard-webhooks", [
    { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { deliveryId } },
  ])
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  return getQueueResult(batch, ctx)
}

const deliveryRow = (id: string) =>
  env.DB.prepare(
    "select status, attempts, next_attempt_at, last_status_code from webhook_deliveries where id = ?",
  )
    .bind(id)
    .first<{
      status: string
      attempts: number
      next_attempt_at: number | null
      last_status_code: number | null
    }>()

const createHook = async (events: Array<string>, url = "https://hooks.test/mailyard") => {
  const response = await call("/v1/webhooks", { method: "POST", key: ADMIN, json: { url, events } })
  return { response, body: await json<{ endpoint: { id: string }; secret: string }>(response) }
}

describe("webhook endpoints", () => {
  it("refuse http and private addresses, and unknown event types", async () => {
    expect((await createHook(["message.sent"], "http://hooks.test/x")).response.status).toBe(400)
    expect((await createHook(["message.sent"], "https://localhost/x")).response.status).toBe(400)
    expect((await createHook(["message.teleported"])).response.status).toBe(400)
  })

  it("need the admin scope to manage, and show the secret only at creation", async () => {
    expect(
      (
        await call("/v1/webhooks", {
          method: "POST",
          key: secret,
          json: { url: "https://hooks.test/a", events: ["*"] },
        })
      ).status,
    ).toBe(403)
    const { body } = await createHook(["*"])
    expect(body.secret).toMatch(/^whsec_/)
    const listed = await call("/v1/webhooks", { key: secret })
    expect(JSON.stringify(await listed.json())).not.toContain(body.secret)
  })
})

describe("delivery", () => {
  it("signs a message.sent event so a Standard Webhooks verifier accepts it", async () => {
    const { body } = await createHook(["message.sent"])
    await call("/v1/send", {
      method: "POST",
      key: secret,
      json: { to: "hook@example.net", subject: "Hooked", body: "<p>x</p>", from: "hello@mailyard.test" },
    })
    const pending = await env.DB.prepare(
      "select id from webhook_deliveries where endpoint_id = ? and event_type = 'message.sent'",
    )
      .bind(body.endpoint.id)
      .first<{ id: string }>()
    expect(pending).not.toBeNull()
    await runDelivery(pending?.id ?? "")

    expect(received).toHaveLength(1)
    const [hit] = received
    expect(await verify(body.secret, hit?.headers ?? {}, hit?.body ?? "")).toBe(true)
    // A tampered body must not verify.
    expect(await verify(body.secret, hit?.headers ?? {}, `${hit?.body} `)).toBe(false)
    const event = JSON.parse(hit?.body ?? "{}") as {
      type: string
      data: { recipient: string; subject: string }
    }
    expect(event.type).toBe("message.sent")
    expect(event.data).toMatchObject({ recipient: "hook@example.net", subject: "Hooked" })
    expect((await deliveryRow(pending?.id ?? ""))?.status).toBe("succeeded")
  })

  it("only sends an endpoint the event types it subscribed to", async () => {
    const { body } = await createHook(["event.tracked"])
    await call("/v1/send", {
      method: "POST",
      key: secret,
      json: { to: "nohook@example.net", subject: "s", body: "<p>x</p>", from: "hello@mailyard.test" },
    })
    const count = await env.DB.prepare("select count(*) as n from webhook_deliveries where endpoint_id = ?")
      .bind(body.endpoint.id)
      .first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it("retries a failing endpoint with growing delays, marks it dead after 8 tries, and replays it", async () => {
    const { body } = await createHook(["*"])
    const test = await json<{ deliveryId: string }>(
      await call(`/v1/webhooks/${body.endpoint.id}/test`, { method: "POST", key: ADMIN }),
    )
    answer = 500
    const delays: Array<number> = []
    for (let attempt = 1; attempt <= 8; attempt++) {
      const before = Date.now()
      await runDelivery(test.deliveryId)
      const row = await deliveryRow(test.deliveryId)
      expect(row?.attempts).toBe(attempt)
      expect(row?.last_status_code).toBe(500)
      if (attempt < 8) {
        expect(row?.status).toBe("retrying")
        delays.push(Math.round(((row?.next_attempt_at ?? 0) - before) / 1000))
      } else {
        expect(row?.status).toBe("dead")
      }
    }
    expect(delays).toEqual([30, 60, 120, 240, 480, 960, 1920])

    // A dead delivery is skipped by a stray job, and comes back on replay.
    await runDelivery(test.deliveryId)
    expect(received).toHaveLength(8)
    answer = 200
    const replayed = await call(`/v1/webhooks/${body.endpoint.id}/deliveries/${test.deliveryId}/replay`, {
      method: "POST",
      key: ADMIN,
    })
    expect(replayed.status).toBe(200)
    await runDelivery(test.deliveryId)
    expect((await deliveryRow(test.deliveryId))?.status).toBe("succeeded")

    const log = await json<{ deliveries: Array<{ id: string; status: string }> }>(
      await call(`/v1/webhooks/${body.endpoint.id}/deliveries`, { key: secret }),
    )
    expect(log.deliveries.find((d) => d.id === test.deliveryId)?.status).toBe("succeeded")
  })

  it("counts dead letters per endpoint and replays them all at once (HAL-3416)", async () => {
    const { body } = await createHook(["*"])
    const other = await createHook(["*"])
    const id = body.endpoint.id
    // Three dead deliveries here, one succeeded, and one dead at another endpoint.
    const insert = (endpointId: string, status: string, n: number) =>
      env.DB.prepare(
        "insert into webhook_deliveries (id, endpoint_id, event_id, event_type, payload, status, attempts, created_at) values (?, ?, ?, 'contact.created', '{}', ?, 8, ?)",
      )
        .bind(`d-${endpointId}-${status}-${n}`, endpointId, `e-${n}`, status, Date.now() + n)
        .run()
    for (const n of [1, 2, 3]) await insert(id, "dead", n)
    await insert(id, "succeeded", 4)
    await insert(other.body.endpoint.id, "dead", 5)

    const endpoint = async (eid: string) =>
      json<{ deadLetters: number }>(await call(`/v1/webhooks/${eid}`, { key: secret }))
    expect((await endpoint(id)).deadLetters).toBe(3)
    const listed = await json<{ webhooks: Array<{ id: string; deadLetters: number }> }>(
      await call("/v1/webhooks", { key: secret }),
    )
    expect(listed.webhooks.find((w) => w.id === id)?.deadLetters).toBe(3)
    expect(listed.webhooks.find((w) => w.id === other.body.endpoint.id)?.deadLetters).toBe(1)

    // Replay needs admin, and only takes status dead.
    const replayAll = (key: string, json: unknown) =>
      call(`/v1/webhooks/${id}/deliveries/replay`, { method: "POST", key, json })
    expect((await replayAll(secret, { status: "dead" })).status).toBe(403)
    expect((await replayAll(ADMIN, { status: "retrying" })).status).toBe(400)
    const replayed = await json<{ replayed: number; remaining: number }>(
      await replayAll(ADMIN, { status: "dead" }),
    )
    expect(replayed).toEqual({ replayed: 3, remaining: 0 })
    expect((await endpoint(id)).deadLetters).toBe(0)
    expect((await endpoint(other.body.endpoint.id)).deadLetters).toBe(1)
    for (const n of [1, 2, 3]) {
      await runDelivery(`d-${id}-dead-${n}`)
      expect((await deliveryRow(`d-${id}-dead-${n}`))?.status).toBe("succeeded")
    }
    expect((await deliveryRow(`d-${id}-succeeded-4`))?.attempts).toBe(8)
    expect(
      (
        await call(`/v1/webhooks/whk_none/deliveries/replay`, {
          method: "POST",
          key: ADMIN,
          json: { status: "dead" },
        })
      ).status,
    ).toBe(404)
  })

  it("reads only an endpoint's dead rows to count them", async () => {
    const plan = await env.DB.prepare(
      "explain query plan select endpoint_id, count(*) from webhook_deliveries where status = 'dead' and endpoint_id in (?) group by endpoint_id",
    )
      .bind("x")
      .all<{ detail: string }>()
    expect(plan.results.map((r) => r.detail).join(" | ")).toMatch(
      /USING (COVERING )?INDEX webhook_deliveries_(endpoint_status|status)/,
    )
  })

  it("stops verifying with the old secret after a rotation", async () => {
    const { body } = await createHook(["*"])
    const rotated = await json<{ secret: string }>(
      await call(`/v1/webhooks/${body.endpoint.id}/rotate-secret`, { method: "POST", key: ADMIN }),
    )
    const test = await json<{ deliveryId: string }>(
      await call(`/v1/webhooks/${body.endpoint.id}/test`, { method: "POST", key: ADMIN }),
    )
    await runDelivery(test.deliveryId)
    const [hit] = received
    expect(await verify(rotated.secret, hit?.headers ?? {}, hit?.body ?? "")).toBe(true)
    expect(await verify(body.secret, hit?.headers ?? {}, hit?.body ?? "")).toBe(false)
  })

  it("doesn't deliver to a disabled endpoint", async () => {
    const { body } = await createHook(["*"])
    const test = await json<{ deliveryId: string }>(
      await call(`/v1/webhooks/${body.endpoint.id}/test`, { method: "POST", key: ADMIN }),
    )
    await call(`/v1/webhooks/${body.endpoint.id}`, { method: "PATCH", key: ADMIN, json: { enabled: false } })
    await runDelivery(test.deliveryId)
    expect(received).toHaveLength(0)
  })
})

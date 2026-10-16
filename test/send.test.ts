import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import worker from "../src/workers/api.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

type SendResult = {
  success: true
  data: {
    emails: Array<{ contact: { id: string; email: string }; email: string; status: string }>
    timestamp: string
  }
}

let secret = ""
let publicKey = ""

beforeAll(async () => {
  secret = (await createKey("secret")).key
  publicKey = (await createKey("public")).key
})

const send = (body: unknown, init: { key?: string; idempotencyKey?: string } = {}) =>
  call("/v1/send", {
    method: "POST",
    key: init.key ?? secret,
    json: body,
    ...(init.idempotencyKey ? { headers: { "idempotency-key": init.idempotencyKey } } : {}),
  })

const row = (id: string) =>
  env.DB.prepare("select * from messages_out where id = ?").bind(id).first<Record<string, unknown>>()

describe("POST /v1/send (Plunk-compatible)", () => {
  it("sends Plunk's simple format: bare addresses, sender name, persistent and one-off data", async () => {
    const response = await send({
      to: "Ada@Example.net",
      subject: "Reset for {{ firstName }}",
      body: '<p>Hello {{firstName}}! Code: {{resetCode}}. Plan: {{ plan ?? "free" }}</p>',
      from: "hello@mailflare.test",
      name: "Mailflare",
      data: { firstName: "<Ada>", resetCode: { value: "ABC123", persistent: false } },
    })
    expect(response.status).toBe(200)
    const result = await json<SendResult>(response)
    expect(result.success).toBe(true)
    expect(result.data.emails).toHaveLength(1)
    const [sent] = result.data.emails
    expect(sent?.contact.email).toBe("ada@example.net")
    expect(sent?.status).toBe("sent")

    const message = await row(sent?.email ?? "")
    expect(message?.status).toBe("sent")
    expect(message?.subject).toBe("Reset for <Ada>")
    expect(message?.sender).toBe("hello@mailflare.test")

    // The rendered copy escapes data in HTML and keeps the one-off value out of the contact.
    const detail = await json<{ rendered: { html: string; text: string; from: string } }>(
      await call(`/v1/messages/${sent?.email}`, { key: secret }),
    )
    expect(detail.rendered.from).toBe("Mailflare <hello@mailflare.test>")
    expect(detail.rendered.html).toBe("<p>Hello &lt;Ada&gt;! Code: ABC123. Plan: free</p>")
    expect(detail.rendered.text).toBe("Hello <Ada>! Code: ABC123. Plan: free")
    const contact = await env.DB.prepare("select status, fields from contacts where email = ?")
      .bind("ada@example.net")
      .first<{ status: string; fields: string }>()
    expect(contact?.status).toBe("unsubscribed")
    expect(JSON.parse(contact?.fields ?? "{}")).toEqual({ firstName: "<Ada>" })
  })

  it("sends one message per recipient in the object and array formats", async () => {
    const response = await send({
      to: [{ name: "Jane", email: "jane@example.net" }, "john@example.net"],
      subject: "Newsletter",
      body: "<p>Hi {{name ?? 'there'}}</p>",
      from: { name: "News", email: "news@mailflare.test" },
      subscribed: true,
    })
    const result = await json<SendResult>(response)
    expect(result.data.emails.map((e) => e.contact.email)).toEqual(["jane@example.net", "john@example.net"])
    const jane = await json<{ rendered: { html: string } }>(
      await call(`/v1/messages/${result.data.emails[0]?.email}`, { key: secret }),
    )
    const john = await json<{ rendered: { html: string } }>(
      await call(`/v1/messages/${result.data.emails[1]?.email}`, { key: secret }),
    )
    expect(jane.rendered.html).toBe("<p>Hi Jane</p>")
    expect(john.rendered.html).toBe("<p>Hi there</p>")
  })

  it("replays a repeated Idempotency-Key and refuses it for a different body", async () => {
    const body = {
      to: "idem@example.net",
      subject: "Once",
      body: "<p>once</p>",
      from: "hello@mailflare.test",
    }
    const first = await json<SendResult>(await send(body, { idempotencyKey: "order-42" }))
    const again = await send(body, { idempotencyKey: "order-42" })
    expect(again.status).toBe(200)
    expect(await json<SendResult>(again)).toEqual(first)
    const { results } = await env.DB.prepare("select id from messages_out where recipient = ?")
      .bind("idem@example.net")
      .all()
    expect(results).toHaveLength(1)
    const different = await send({ ...body, subject: "Twice" }, { idempotencyKey: "order-42" })
    expect(different.status).toBe(409)
  })

  it("requires a sender when DEFAULT_FROM isn't set", async () => {
    const response = await send({ to: "x@example.net", subject: "s", body: "<p>b</p>" })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ _tag: "InvalidRequest", field: "from" })
  })

  it("answers 404 for an unknown template", async () => {
    const response = await send({ to: "x@example.net", template: "nope", from: "hello@mailflare.test" })
    expect(response.status).toBe(404)
  })

  it("refuses a message over the 5 MiB limit with 422, before sending anything", async () => {
    // 3.8 MiB raw is just over the 5 MiB limit once base64-encoded (×4/3).
    const big = btoa("a".repeat(3_985_000))
    const response = await send({
      to: "big@example.net",
      subject: "Big",
      body: "<p>big</p>",
      from: "hello@mailflare.test",
      attachments: [{ filename: "big.txt", content: big, contentType: "text/plain" }],
    })
    expect(response.status).toBe(422)
    const { results } = await env.DB.prepare("select id from messages_out where recipient = ?")
      .bind("big@example.net")
      .all()
    expect(results).toHaveLength(0)
  })

  it("lets a public key track but not send", async () => {
    expect((await send({ to: "x@example.net", subject: "s", body: "b" }, { key: publicKey })).status).toBe(
      403,
    )
  })

  it("answers 401 without a key or with an unknown one", async () => {
    expect((await call("/v1/send", { method: "POST", json: {} })).status).toBe(401)
    expect((await send({ to: "x@example.net" }, { key: "sk_not_a_real_key" })).status).toBe(401)
  })
})

describe("POST /v1/track (Plunk-compatible)", () => {
  it("records the event and creates the contact subscribed", async () => {
    const response = await call("/v1/track", {
      method: "POST",
      key: publicKey,
      json: { event: "signed-up", email: "new@example.net", data: { plan: "pro" } },
    })
    expect(response.status).toBe(200)
    const result = await json<{ success: true; data: { contact: string; event: string; timestamp: string } }>(
      response,
    )
    expect(result.success).toBe(true)
    const contact = await env.DB.prepare("select status, fields from contacts where id = ?")
      .bind(result.data.contact)
      .first<{ status: string; fields: string }>()
    expect(contact?.status).toBe("subscribed")
    expect(JSON.parse(contact?.fields ?? "{}")).toEqual({ plan: "pro" })
    const event = await env.DB.prepare("select name from events where id = ?").bind(result.data.event).first()
    expect(event).toEqual({ name: "signed-up" })
  })

  it("refuses reserved system event names", async () => {
    const response = await call("/v1/track", {
      method: "POST",
      key: publicKey,
      json: { event: "email.opened", email: "new@example.net" },
    })
    expect(response.status).toBe(400)
  })
})

describe("API keys", () => {
  it("needs the admin scope to list or create keys", async () => {
    expect((await call("/v1/api-keys", { key: secret })).status).toBe(403)
    const listed = await json<{ keys: Array<{ prefix: string; kind: string }> }>(
      await call("/v1/api-keys", { key: ADMIN }),
    )
    expect(listed.keys.some((k) => k.kind === "public")).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(secret)
  })

  it("stops a revoked key from working", async () => {
    const { key, apiKey } = await createKey("secret")
    expect((await call(`/v1/api-keys/${apiKey.id}`, { method: "DELETE", key: ADMIN })).status).toBe(200)
    expect((await call("/v1/messages", { key })).status).toBe(401)
  })
})

describe("GET /v1/messages", () => {
  it("pages newest first with a cursor and filters by recipient", async () => {
    for (const n of [1, 2, 3]) {
      await send({
        to: "pager@example.net",
        subject: `Page ${n}`,
        body: "<p>x</p>",
        from: "hello@mailflare.test",
      })
    }
    const first = await json<{ messages: Array<{ subject: string }>; nextCursor: string | null }>(
      await call("/v1/messages?recipient=pager@example.net&limit=2", { key: secret }),
    )
    expect(first.messages.map((m) => m.subject)).toEqual(["Page 3", "Page 2"])
    expect(first.nextCursor).not.toBeNull()
    const second = await json<{ messages: Array<{ subject: string }>; nextCursor: string | null }>(
      await call(`/v1/messages?recipient=pager@example.net&limit=2&cursor=${first.nextCursor}`, {
        key: secret,
      }),
    )
    expect(second.messages.map((m) => m.subject)).toEqual(["Page 1"])
    expect(second.nextCursor).toBeNull()
  })
})

describe("send queue", () => {
  it("delivers a deferred message when its retry job runs", async () => {
    const id = "deferred-1"
    const rendered = {
      from: { email: "hello@mailflare.test" },
      to: [{ email: "later@example.net" }],
      subject: "Later",
      html: "<p>later</p>",
      text: "later",
    }
    await env.STORE.put(`out/${id}.json`, JSON.stringify(rendered))
    await env.DB.prepare(
      "insert into messages_out (id, stream, recipient, sender, subject, status, attempts, rendered_key) values (?, 'transactional', 'later@example.net', 'hello@mailflare.test', 'Later', 'deferred', 1, ?)",
    )
      .bind(id, `out/${id}.json`)
      .run()
    const batch = createMessageBatch("mailflare-send", [
      { id: "job-1", timestamp: new Date(), attempts: 1, body: { messageId: id } },
    ])
    const ctx = createExecutionContext()
    await worker.queue(batch, env)
    const result = await getQueueResult(batch, ctx)
    expect(result.explicitAcks).toEqual(["job-1"])
    expect((await row(id))?.status).toBe("sent")
    expect((await row(id))?.attempts).toBe(2)
  })
})

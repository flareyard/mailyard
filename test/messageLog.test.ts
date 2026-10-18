import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { beforeAll, describe, expect, it } from "vitest"
import { attempt, decodeRendered } from "../src/domain/outbox.ts"
import { SendDeferred, Sender } from "../src/kit/Sender.ts"
import worker from "../src/workers/api.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

/** HAL-3413: the message log's filters, each message's trail, its headers and its raw source. */
let secret = ""
beforeAll(async () => {
  secret = (await createKey("secret")).key
})

type Event = {
  type: string
  at: number
  attempt: number | null
  provider: string | null
  detail: string | null
}
type Detail = {
  id: string
  source: string
  stream: string
  status: string
  idempotencyKey: string | null
  nextAttemptAt: number | null
  templateVersion: number | null
  events: Array<Event>
  headers: Array<{ name: string; value: string }>
}

const uid = () => crypto.randomUUID().slice(0, 8)

const send = async (to: string, idempotencyKey?: string) => {
  const res = await call("/v1/send", {
    method: "POST",
    key: secret,
    ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
    json: { to, subject: "Welcome", body: "<p>hi</p>", from: "hello@mailyard.test", name: "Hello" },
  })
  if (res.status !== 200) throw new Error(`send: ${res.status} ${await res.clone().text()}`)
  const { data } = await json<{ data: { emails: Array<{ email: string }> } }>(res)
  return data.emails[0]?.email ?? ""
}

const detail = async (id: string) => json<Detail>(await call(`/v1/messages/${id}`, { key: ADMIN }))
const list = async (query: string) =>
  (
    await json<{ messages: Array<{ id: string }> }>(await call(`/v1/messages?${query}`, { key: ADMIN }))
  ).messages.map((m) => m.id)

const cfIdOf = async (id: string) =>
  (
    await env.DB.prepare("select cf_message_id from messages_out where id = ?")
      .bind(id)
      .first<{ cf_message_id: string }>()
  )?.cf_message_id ?? ""

const deliverEvent = async (type: "delivered" | "bounced", cfMessageId: string, recipient: string) => {
  const body = {
    type: `cf.email.sending.message.${type}`,
    source: { type: "email.sending", domain: "mailyard.test" },
    payload: {
      eventId: crypto.randomUUID(),
      messageId: cfMessageId,
      recipient,
      terminal: true,
      delivery: {
        status: type,
        provider: "gmail",
        smtpResponse: type === "bounced" ? "550 5.1.1 no such user" : "250 ok",
      },
      ...(type === "bounced" ? { bounce: { type: "hard" } } : {}),
    },
    metadata: {
      accountId: "a",
      eventSubscriptionId: "s",
      eventSchemaVersion: 1,
      eventTimestamp: new Date().toISOString(),
    },
  }
  const batch = createMessageBatch("mailyard-email-events", [
    { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body },
  ])
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  return getQueueResult(batch, ctx)
}

describe("the message trail", () => {
  it("records accepted, sent, delivered and the first open; shows headers, the client's key and the source", async () => {
    const to = `trail-${uid()}@example.net`
    const key = `order-${uid()}`
    const id = await send(to, key)
    await deliverEvent("delivered", await cfIdOf(id), to)
    // A human open, twice: only the first is in the trail.
    await env.DB.prepare("update messages_out set first_opened_at = ?, opens = 1 where id = ?")
      .bind(Date.now(), id)
      .run()
    await env.DB.prepare("update messages_out set opens = 2 where id = ?").bind(id).run()
    const d = await detail(id)
    expect(d.events.map((e) => e.type)).toEqual(["accepted", "sent", "delivered", "opened"])
    expect(d.events[1]).toMatchObject({ attempt: 1 })
    expect(d.events[2]).toMatchObject({ provider: "gmail" })
    expect(d).toMatchObject({
      source: "api",
      stream: "transactional",
      idempotencyKey: key,
      nextAttemptAt: null,
    })
    const headers = Object.fromEntries(d.headers.map((h) => [h.name, h.value]))
    expect(headers.From).toContain("hello@mailyard.test")
    expect(headers.To).toBe(to)
    expect(headers.Subject).toBe("Welcome")
    expect(headers["Message-ID"]).toBe(`<${await cfIdOf(id)}>`)
  })

  it("records a hard bounce with its SMTP response", async () => {
    const to = `bounce-${uid()}@example.net`
    const id = await send(to)
    await deliverEvent("bounced", await cfIdOf(id), to)
    const bounced = (await detail(id)).events.at(-1)
    expect(bounced).toMatchObject({ type: "bounced", provider: "gmail" })
    expect((await detail(id)).status).toBe("bounced")
  })

  it("records a deferral with Mailyard's next attempt, then the send that worked", async () => {
    const to = `defer-${uid()}@example.net`
    const id = await send(to)
    const row = await env.DB.prepare("select rendered_key from messages_out where id = ?")
      .bind(id)
      .first<{ rendered_key: string }>()
    const stored = await env.STORE.get(row?.rendered_key ?? "")
    const message = decodeRendered(await (stored as R2ObjectBody).text())
    const deferring = Sender.of({
      send: () => Effect.fail(new SendDeferred({ code: "E_RATE", message: "try later" })),
    })
    const before = Date.now()
    await runtimeFor(env).runPromise(attempt(id, message, 1).pipe(Effect.provideService(Sender, deferring)))
    const deferred = await detail(id)
    expect(deferred.events.at(-1)).toMatchObject({ type: "deferred", attempt: 2 })
    expect(deferred.events.at(-1)?.detail).toContain("try later")
    // Attempt 2 backs off two minutes.
    expect(deferred.nextAttemptAt).toBeGreaterThanOrEqual(before + 120_000)
    await runtimeFor(env).runPromise(attempt(id, message, 2))
    const sent = await detail(id)
    expect(sent.events.map((e) => e.type)).toEqual(["accepted", "sent", "deferred", "sent"])
    expect(sent.nextAttemptAt).toBeNull()
  })

  it("marks a suppressed recipient's message as suppressed", async () => {
    const to = `supp-${uid()}@example.net`
    await call("/v1/suppressions", { method: "POST", key: ADMIN, json: { email: to, reason: "manual" } })
    const id = await send(to)
    expect((await detail(id)).events.map((e) => e.type)).toEqual(["accepted", "suppressed"])
  })
})

describe("message log filters", () => {
  it("filters by stream, template, a time window and q (id, Cloudflare id, recipient prefix)", async () => {
    const tag = uid()
    const a = await send(`alpha-${tag}@example.net`)
    const b = await send(`beta-${tag}@example.net`)
    expect(await list(`q=alpha-${tag}`)).toEqual([a])
    expect(await list(`q=${b}`)).toEqual([b])
    expect(await list(`q=${await cfIdOf(a)}`)).toEqual([a])
    expect(await list("stream=transactional&limit=200")).toEqual(expect.arrayContaining([a, b]))
    expect(await list(`stream=campaign&q=alpha-${tag}`)).toEqual([])
    const created = await env.DB.prepare("select created_at from messages_out where id = ?")
      .bind(a)
      .first<{ created_at: number }>()
    const at = created?.created_at ?? 0
    expect(await list(`q=alpha-${tag}&from=${at}&to=${at + 1}`)).toEqual([a])
    expect(await list(`q=alpha-${tag}&from=${at + 1}`)).toEqual([])
    expect(await list(`templateId=tpl_none_${tag}`)).toEqual([])
  })

  it("serves each filter from an index", async () => {
    const plans: Array<string> = []
    const plan = async (sql: string, ...args: Array<unknown>) => {
      const rows = await env.DB.prepare(`explain query plan ${sql}`)
        .bind(...args)
        .all<{ detail: string }>()
      plans.push(rows.results.map((r) => r.detail).join(" | "))
    }
    const base = "select id from messages_out where"
    const order = "order by created_at desc, id desc limit 51"
    await plan(`${base} stream = ? ${order}`, "campaign")
    await plan(`${base} template_id = ? ${order}`, "t")
    await plan(`${base} created_at >= ? and created_at < ? ${order}`, 0, 1)
    await plan(
      `${base} (id = ? or cf_message_id = ? or (recipient >= ? and recipient < ?)) ${order}`,
      "x",
      "x",
      "x",
      "x￿",
    )
    await plan("select * from message_events where message_id = ? order by at, id", "m")
    for (const p of plans)
      expect(p, p).not.toMatch(
        /SCAN messages_out(?! USING INDEX messages_out_(stream|template|created))|SCAN message_events/,
      )
    expect(plans[0]).toContain("messages_out_stream")
    expect(plans[1]).toContain("messages_out_template")
    expect(plans[4]).toContain("message_events_message")
  })
})

describe("GET /v1/messages/{id}/raw", () => {
  it("rebuilds the sent message as .eml, for secret keys with read", async () => {
    const to = `raw-${uid()}@example.net`
    const id = await send(to)
    const res = await call(`/v1/messages/${id}/raw`, { key: ADMIN })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("message/rfc822")
    const eml = await res.text()
    expect(eml).toContain("Subject: Welcome")
    expect(eml).toContain(`To: ${to}`)
    expect(eml).toContain(`Message-ID: <${await cfIdOf(id)}>`)
    expect(eml).toContain("MIME-Version: 1.0")
    expect((await call(`/v1/messages/${id}/raw`, { key: (await createKey("public")).key })).status).toBe(403)
    expect((await call(`/v1/messages/${id}/raw`)).status).toBe(401)
    expect((await call("/v1/messages/nope/raw", { key: ADMIN })).status).toBe(404)
  })
})

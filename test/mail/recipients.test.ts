import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import worker from "../../src/workers/api.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)

/** Shaped like the documented examples, as test/events.test.ts sends them. */
const event = (type: string, messageId: string, recipient: string, extra: Record<string, unknown> = {}) => ({
  type: `cf.email.sending.message.${type}`,
  source: { type: "email.sending", zoneId: "023e105f4ecef8ad9ca31a8372d0c353", domain: "mailyard.test" },
  payload: {
    eventId: crypto.randomUUID(),
    messageId,
    sender: "sam@mailyard.test",
    recipient,
    subject: "Status",
    terminal: type !== "deferred",
    delivery: {
      status: type,
      provider: "gmail",
      deliveryTimeMs: 1234,
      smtpStatusCode: "250",
      ...(extra.smtp ? { smtpResponse: extra.smtp } : {}),
    },
    ...(extra.bounce ? { bounce: extra.bounce } : {}),
  },
  metadata: {
    accountId: "f9f79265f388666de8122cfb508d7776",
    eventSubscriptionId: "1830c4bb612e43c3af7f4cada31fbf3f",
    eventSchemaVersion: 1,
    eventTimestamp: new Date().toISOString(),
  },
})

const deliverEvents = async (...bodies: Array<unknown>) => {
  const batch = createMessageBatch(
    "mailyard-email-events",
    bodies.map((body, i) => ({ id: `e${i}-${uid()}`, timestamp: new Date(), attempts: 1, body })),
  )
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  await getQueueResult(batch, ctx)
}

describe("per-recipient delivery on sent copies (HAL-3408)", () => {
  it("records each recipient, moves each with its own events, and pushes the change", async () => {
    const domain = `rcp-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const box = await json<{ id: string; address: string }>(
      await call("/v1/mailboxes", {
        method: "POST",
        key: ADMIN,
        json: { address: `sam@${domain}`, kind: "user" },
      }),
    )
    const base = `/v1/mailboxes/${box.id}`
    const suppressedAddress = `gone-${uid()}@example.org`
    await call("/v1/suppressions", { method: "POST", key: ADMIN, json: { email: suppressedAddress } })
    const draft = await json<{ id: string }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: ADMIN,
        json: {
          to: [{ address: "ada@example.org" }, { address: suppressedAddress }],
          cc: [{ address: "grace@example.org" }],
          bcc: [{ address: "audit@example.org" }],
          subject: "Status",
          bodyText: "Hello all.",
        },
      }),
    )
    await call(`${base}/drafts/${draft.id}/send`, { method: "POST", key: ADMIN, json: { undoSeconds: 0 } })
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box.id))
    const deadline = Date.now() + 10_000
    while ((await stub.draft(draft.id))?.status !== "due" && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50))
    const send = createMessageBatch("mailyard-mailbox-send", [
      {
        id: `m-${uid()}`,
        timestamp: new Date(),
        attempts: 1,
        body: { mailboxId: box.id, draftId: draft.id, origin: null },
      },
    ])
    const ctx = createExecutionContext()
    await worker.queue(send, env)
    await getQueueResult(send, ctx)

    const log = await env.DB.prepare(
      "select id, cf_message_id, mailbox_message_id from messages_out where mailbox_id = ? order by created_at desc limit 1",
    )
      .bind(box.id)
      .first<{ id: string; cf_message_id: string; mailbox_message_id: string }>()
    expect(log?.cf_message_id).toBeTruthy()
    type Detail = {
      delivery: {
        recipients: Array<{
          recipient: string
          kind: string
          status: string
          attempts: number
          smtpResponse: string | null
        }>
      }
    }
    const detail = async () =>
      (await json<Detail>(await call(`${base}/messages/${log?.mailbox_message_id}`, { key: ADMIN }))).delivery
        .recipients
    const byAddress = async () => Object.fromEntries((await detail()).map((r) => [r.recipient, r]))
    expect(await byAddress()).toMatchObject({
      "ada@example.org": { kind: "to", status: "sent" },
      "grace@example.org": { kind: "cc", status: "sent" },
      "audit@example.org": { kind: "bcc", status: "sent" },
      [suppressedAddress]: { status: "suppressed" },
    })

    // A live client sees each change.
    const res = await exports.default.fetch(
      new Request(`https://mailyard.test${base}/live`, {
        headers: { upgrade: "websocket", authorization: `Bearer ${ADMIN}` },
      }),
    )
    const socket = res.webSocket as WebSocket
    socket.accept()
    const frames: Array<Record<string, unknown>> = []
    socket.addEventListener("message", (e) =>
      frames.push(JSON.parse(String(e.data)) as Record<string, unknown>),
    )

    const cf = log?.cf_message_id as string
    await deliverEvents(
      event("delivered", cf, "ada@example.org"),
      event("deferred", cf, "grace@example.org", { smtp: "451 try later" }),
      event("deferred", cf, "grace@example.org", { smtp: "451 still busy" }),
      event("bounced", cf, "audit@example.org", { bounce: { type: "hard", reason: "550 no such user" } }),
    )
    // A late deferral never moves a delivered recipient back.
    await deliverEvents(event("deferred", cf, "ada@example.org"))
    expect(await byAddress()).toMatchObject({
      "ada@example.org": { status: "delivered" },
      "grace@example.org": { status: "deferred", attempts: 2, smtpResponse: "451 still busy" },
      "audit@example.org": { status: "bounced", smtpResponse: "550 no such user" },
    })
    const until = Date.now() + 3000
    while (frames.filter((f) => f.type === "delivery.changed").length < 4 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20))
    const pushed = frames.filter((f) => f.type === "delivery.changed")
    expect(pushed.length).toBeGreaterThanOrEqual(4)
    expect(pushed.at(-1)).toMatchObject({ messageId: log?.mailbox_message_id, logId: log?.id })
    socket.close()
  })
})

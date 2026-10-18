import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest"
import { decodeMailEvent, type MailEvent } from "../src/contracts/mailEvents.ts"
import worker from "../src/workers/api.ts"
import { handleEmail } from "../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "./dns.ts"
import { ADMIN, call, json } from "./helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

const queue = (env as unknown as { MAIL_EVENTS_QUEUE: Queue }).MAIL_EVENTS_QUEUE
let spy: MockInstance
beforeEach(() => {
  spy = vi.spyOn(queue, "send").mockResolvedValue(undefined as never)
})
afterEach(() => spy.mockRestore())

/** What went on the lane, each body decoded the way Hermes decodes it. */
const published = () => spy.mock.calls.map(([body]) => decodeMailEvent(body))
const ofType = <T extends MailEvent["type"]>(type: T) =>
  published().filter((e): e is Extract<MailEvent, { type: T }> => e.type === type)

const lane = (body: Record<string, unknown>) => admin("/v1/settings/mail-events", "PUT", body)

const setup = async () => {
  const domain = `me-${uid()}.test`
  setDns(goodDomain(domain))
  await admin("/v1/domains", "POST", { name: domain })
  const box = await json<{ id: string; address: string }>(
    await admin("/v1/mailboxes", "POST", { address: `support@${domain}`, kind: "user" }),
  )
  const other = await json<{ id: string; address: string }>(
    await admin("/v1/mailboxes", "POST", { address: `sales@${domain}`, kind: "user" }),
  )
  return { domain, box, other }
}

const receive = async (to: string, subject: string, headers = "") => {
  const from = `ada-${uid()}@example.org`
  const raw = `From: Ada Lovelace <${from}>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${uid()}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n${headers}\r\nHello there\r\n`
  const bytes = new TextEncoder().encode(raw)
  const outcome = await handleEmail(
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
  )
  if (outcome?.outcome !== "filed") throw new Error(`not filed: ${JSON.stringify(outcome)}`)
  return from
}

/** A mailbox send, handed over the way the alarm does, then sent by the queue consumer. */
const sendFrom = async (mailboxId: string, to: string) => {
  const base = `/v1/mailboxes/${mailboxId}`
  const draft = await json<{ id: string }>(
    await admin(`${base}/drafts`, "POST", { to: [{ address: to }], subject: "Re: hello", bodyText: "Hi" }),
  )
  await admin(`${base}/drafts/${draft.id}/send`, "POST", { undoSeconds: 0 })
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId))
  const deadline = Date.now() + 15_000
  while ((await stub.draft(draft.id))?.status === "scheduled" && Date.now() < deadline) await sleep(50)
  const batch = createMessageBatch("mailyard-mailbox-send", [
    {
      id: `ms-${uid()}`,
      timestamp: new Date(),
      attempts: 1,
      body: { mailboxId, draftId: draft.id, origin: "https://mailyard.test" },
    },
  ])
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  await getQueueResult(batch, ctx)
  const row = await env.DB.prepare(
    "select id, cf_message_id as cf from messages_out where mailbox_id = ? order by created_at desc limit 1",
  )
    .bind(mailboxId)
    .first<{ id: string; cf: string }>()
  if (!row) throw new Error("no send")
  return row
}

const deliveryEvent = (cfMessageId: string, recipient: string, type: "delivered" | "bounced") => ({
  type: `cf.email.sending.message.${type}`,
  source: { type: "email.sending", zoneId: "z", domain: "mailyard.test" },
  payload: {
    eventId: crypto.randomUUID(),
    messageId: cfMessageId,
    sender: "support@mailyard.test",
    recipient,
    subject: "Re: hello",
    terminal: true,
    delivery: { status: type, provider: "gmail", smtpStatusCode: type === "bounced" ? "550" : "250" },
    ...(type === "bounced" ? { bounce: { type: "hard" } } : {}),
  },
  metadata: {
    accountId: "a",
    eventSubscriptionId: "s",
    eventSchemaVersion: 1,
    eventTimestamp: new Date().toISOString(),
  },
})

describe("the mail-events lane (HAL-3306)", () => {
  it("is off by default and publishes nothing", async () => {
    await lane({ enabled: false, mailboxIds: null, types: null })
    const view = await json<{ enabled: boolean; available: boolean; queue: string; version: number }>(
      await admin("/v1/settings/mail-events"),
    )
    expect(view).toMatchObject({ enabled: false, available: true, queue: "mailyard-mail-events", version: 1 })
    const { box } = await setup()
    await receive(box.address, "quiet")
    expect(spy).not.toHaveBeenCalled()
    const integrations = await json<{ hermes: Record<string, unknown> }>(await admin("/v1/integrations"))
    expect(integrations.hermes).toMatchObject({ connected: false, lane: null, available: true })
  })

  it("refuses a mailbox that doesn't exist", async () => {
    const r = await lane({ enabled: true, mailboxIds: ["mbx_nope"] })
    expect(r.status).toBe(400)
    expect(await json(r)).toMatchObject({ field: "mailboxIds" })
  })

  it("carries the chosen mailboxes' mail, handovers and deliveries, in the contract's shape", async () => {
    const { box, other } = await setup()
    const on = await lane({ enabled: true, mailboxIds: [box.id], types: null })
    expect(on.status).toBe(200)
    const view = await json<{ enabled: boolean; since: number }>(on)
    expect(view.enabled).toBe(true)
    expect(view.since).toBeGreaterThan(0)

    const from = await receive(box.address, "Invoice 42")
    await receive(other.address, "not on the lane")
    const received = ofType("message.received")
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      version: 1,
      mailboxId: box.id,
      from: { email: from, name: "Ada Lovelace" },
      to: box.address,
      subject: "Invoice 42",
      folder: "inbox",
      spam: false,
      automated: false,
    })
    expect(received[0]?.snippet).toContain("Hello there")
    const threadId = received[0]?.threadId ?? ""

    // A handover through the API.
    const assigned = await admin(`/v1/mailboxes/${box.id}/threads/bulk`, "POST", {
      threadIds: [threadId],
      action: "assign",
      assignee: null,
    })
    expect(assigned.status).toBe(200)
    expect(ofType("thread.assigned")).toEqual([
      expect.objectContaining({ mailboxId: box.id, threadId, assignee: null }),
    ])

    // A send from the mailbox, and how it was delivered.
    const sent = await sendFrom(box.id, from)
    expect(ofType("message.sent")).toEqual([
      expect.objectContaining({ mailboxId: box.id, outId: sent.id, recipient: from, subject: "Re: hello" }),
    ])
    const batch = createMessageBatch("mailyard-email-events", [
      {
        id: `ev-${uid()}`,
        timestamp: new Date(),
        attempts: 1,
        body: deliveryEvent(sent.cf, from, "delivered"),
      },
    ])
    const ctx = createExecutionContext()
    await worker.queue(batch, env)
    await getQueueResult(batch, ctx)
    expect(ofType("delivery")).toEqual([
      expect.objectContaining({ kind: "delivered", mailboxId: box.id, outId: sent.id, recipient: from }),
    ])
    // Every event has its own id.
    const ids = published().map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)

    const integrations = await json<{ hermes: Record<string, unknown> }>(await admin("/v1/integrations"))
    expect(integrations.hermes).toMatchObject({
      connected: true,
      lane: "mailyard-mail-events",
      mailboxes: [box.id],
      allMailboxes: false,
      since: view.since,
    })
  })

  it("filters by type, and keeps `since` while it stays on", async () => {
    const { box } = await setup()
    const first = await json<{ since: number }>(await lane({ enabled: true, mailboxIds: null, types: null }))
    const narrowed = await json<{ since: number; types: string[] }>(
      await lane({ enabled: true, types: ["thread.assigned"] }),
    )
    expect(narrowed.since).toBe(first.since)
    expect(narrowed.types).toEqual(["thread.assigned"])
    await receive(box.address, "not this type")
    expect(ofType("message.received")).toEqual([])
    const audit = await json<{ entries: Array<{ action: string }> }>(
      await admin("/v1/audit?action=settings.mail_events"),
    )
    expect(audit.entries.length).toBeGreaterThan(0)
    await lane({ enabled: false })
  })
})

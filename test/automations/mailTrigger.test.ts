import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Graph } from "../../src/automations/graph.ts"
import { runIdFor } from "../../src/automations/runs.ts"
import worker from "../../src/workers/api.ts"
import { handleEmail } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

/** The Worker's bindings with the trigger queue swapped for one that records what's sent. */
const recording = () => {
  const sent: Array<Record<string, unknown>> = []
  const queue = {
    send: async (body: Record<string, unknown>) => {
      sent.push(body)
    },
    sendBatch: async (batch: ReadonlyArray<{ body: Record<string, unknown> }>) => {
      for (const b of batch) sent.push(b.body)
    },
  }
  return { sent, bindings: { ...env, AUTOMATION_QUEUE: queue } as unknown as typeof env }
}

/** Real mail through Email Routing's handler, with the recording queue. */
const receive = async (
  bindings: typeof env,
  input: { to: string; from: string; subject: string; headers?: string },
) => {
  const raw = `From: Ada Lovelace <${input.from}>\r\nTo: ${input.to}\r\nSubject: ${input.subject}\r\nMessage-ID: <${uid()}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n${input.headers ?? ""}\r\nHello\r\n`
  const bytes = new TextEncoder().encode(raw)
  const outcome = await handleEmail(
    {
      from: input.from,
      to: input.to,
      headers: new Headers(),
      raw: new Blob([bytes]).stream(),
      rawSize: bytes.byteLength,
      canBeForwarded: true,
      setReject: () => {},
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage,
    bindings,
  )
  if (outcome?.outcome !== "filed") throw new Error(`not filed: ${JSON.stringify(outcome)}`)
}

/** The automation queue's consumer, run by hand on the jobs the recording queue caught. */
const runTriggers = async (jobs: ReadonlyArray<Record<string, unknown>>) => {
  const batch = createMessageBatch(
    "mailyard-automation-triggers",
    jobs.map((body) => ({ id: `at-${uid()}`, timestamp: new Date(), attempts: 1, body })),
  )
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  return getQueueResult(batch, ctx)
}

const setup = async () => {
  const domain = `mt-${uid()}.test`
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

const automation = async (trigger: Record<string, unknown>, from: string) => {
  const graph: Graph = {
    nodes: [
      { id: "t", type: "trigger", config: trigger },
      { id: "w", type: "wait", config: { duration: { amount: 1, unit: "days" } } },
      { id: "x", type: "exit", config: {} },
    ],
    edges: [
      { from: "t", to: "w" },
      { from: "w", to: "x" },
    ],
  } as unknown as Graph
  const a = await json<{ id: string; issues: unknown[] }>(
    await admin("/v1/automations", "POST", {
      name: `Mail ${uid()}`,
      graph,
      settings: {
        fromAddress: from,
        topicId: null,
        reentry: { mode: "never" },
        cadence: null,
        stopEvents: [],
      },
    }),
  )
  expect(a.issues).toEqual([])
  const published = await admin(`/v1/automations/${a.id}/publish`, "POST", {})
  if (published.status !== 200) throw new Error(`publish: ${await published.text()}`)
  return a.id
}

const contactByEmail = (email: string) =>
  env.DB.prepare("select id, status from contacts where email = ?")
    .bind(email)
    .first<{ id: string; status: string }>()

describe("the mail_received automation trigger (HAL-3467)", () => {
  it("starts a run when matching mail lands, with the message as trigger data", async () => {
    const { domain, box } = await setup()
    const id = await automation(
      {
        kind: "mail_received",
        mailboxIds: [box.id],
        senderDomains: ["example.org"],
        subjectContains: "invoice",
      },
      `Team <team@${domain}>`,
    )
    const { sent, bindings } = recording()
    const sender = `ada-${uid()}@billing.example.org`
    await receive(bindings, { to: box.address, from: sender, subject: "Your INVOICE #42" })
    const jobs = sent.filter((s) => s.kind === "mail_received")
    expect(jobs).toHaveLength(1)
    // The sender became a contact: unconfirmed, never subscribed.
    const contact = await contactByEmail(sender)
    expect(contact?.status).toBe("unconfirmed")
    await runTriggers(jobs)
    const run = await env.DB.prepare("select state, trigger_data from automation_runs where id = ?")
      .bind(runIdFor(id, contact?.id ?? "", 1))
      .first<{ state: string; trigger_data: string }>()
    expect(run).not.toBeNull()
    expect(JSON.parse(run?.trigger_data ?? "{}")).toMatchObject({
      mailboxId: box.id,
      from: sender,
      fromName: "Ada Lovelace",
      subject: "Your INVOICE #42",
      senderDomain: "billing.example.org",
      threadId: expect.any(String),
      messageId: expect.any(String),
    })
  })

  it("skips mail outside the filters, and never starts on automated, list or spam mail", async () => {
    const { domain, box, other } = await setup()
    const id = await automation(
      {
        kind: "mail_received",
        mailboxIds: [box.id],
        senderDomains: ["example.org"],
        subjectContains: "invoice",
      },
      `Team <team@${domain}>`,
    )
    const { sent, bindings } = recording()
    // Wrong mailbox, wrong domain, wrong subject: each is queued (something listens) but doesn't enter.
    const cases = [
      { to: other.address, from: `a-${uid()}@example.org`, subject: "invoice" },
      { to: box.address, from: `b-${uid()}@elsewhere.net`, subject: "invoice" },
      { to: box.address, from: `c-${uid()}@example.org`, subject: "hello" },
    ]
    for (const c of cases) await receive(bindings, c)
    const result = await runTriggers(sent.filter((s) => s.kind === "mail_received"))
    expect(result).toBeDefined()
    for (const c of cases) {
      const contact = await contactByEmail(c.from)
      const run = await env.DB.prepare(
        "select id from automation_runs where automation_id = ? and contact_id = ?",
      )
        .bind(id, contact?.id ?? "")
        .first()
      expect({ from: c.from, run }).toEqual({ from: c.from, run: null })
    }

    // Auto-replies, bulk and list mail never even queue, and create no contact.
    sent.length = 0
    const auto = `auto-${uid()}@example.org`
    await receive(bindings, {
      to: box.address,
      from: auto,
      subject: "Re: invoice",
      headers: "Auto-Submitted: auto-replied\r\n",
    })
    const bulk = `bulk-${uid()}@example.org`
    await receive(bindings, {
      to: box.address,
      from: bulk,
      subject: "invoice",
      headers: "Precedence: bulk\r\n",
    })
    const list = `list-${uid()}@example.org`
    await receive(bindings, {
      to: box.address,
      from: list,
      subject: "invoice",
      headers: "List-Id: <news.example.org>\r\n",
    })
    // The mailbox writing to itself doesn't either.
    await receive(bindings, { to: box.address, from: box.address, subject: "invoice" })
    expect(sent.filter((s) => s.kind === "mail_received")).toEqual([])
    expect(await contactByEmail(auto)).toBeNull()
    expect(await contactByEmail(bulk)).toBeNull()
    expect(await contactByEmail(list)).toBeNull()
  })

  it("leaves the audience alone when no automation listens", async () => {
    const { box } = await setup()
    // No live mail_received automation in this file's storage at this point? Pause any first.
    const live = await env.DB.prepare(
      "select id from automations where status = 'live' and trigger_key = 'mail_received'",
    ).all<{
      id: string
    }>()
    for (const a of live.results) await admin(`/v1/automations/${a.id}/pause`, "POST", {})
    const { sent, bindings } = recording()
    const sender = `quiet-${uid()}@example.org`
    await receive(bindings, { to: box.address, from: sender, subject: "invoice" })
    expect(sent).toEqual([])
    expect(await contactByEmail(sender)).toBeNull()
  })
})

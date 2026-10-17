import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Env } from "../../src/Bindings.ts"
import { type InboundJob, rawKeyOf } from "../../src/inbound/pipeline.ts"
import worker from "../../src/workers/api.ts"
import { handleEmail } from "../../src/workers/inbound.ts"
import attachments from "../fixtures/eml/attachments.eml?raw"
import inline from "../fixtures/eml/inline-image.eml?raw"
import alternative from "../fixtures/eml/multipart-alternative.eml?raw"
import { ADMIN, call, createKey, json } from "../helpers.ts"
import { deepMessage, largeMessage, simpleMessage } from "./messages.ts"

const bytes = (raw: string | Uint8Array) => (typeof raw === "string" ? new TextEncoder().encode(raw) : raw)

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("")
const sha = async (raw: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", raw))

/** A ForwardableEmailMessage as Email Routing hands one to `email()`, recording any rejection. */
const incoming = (raw: string | Uint8Array, to: string, from = "bounce@example.org", rawSize?: number) => {
  const body = bytes(raw)
  const state = { rejected: null as string | null }
  const message = {
    from,
    to,
    headers: new Headers(),
    raw: new Blob([body]).stream(),
    rawSize: rawSize ?? body.byteLength,
    canBeForwarded: true,
    setReject: (reason: string) => {
      state.rejected = reason
    },
    forward: async () => {
      throw new Error("not used")
    },
    reply: async () => {
      throw new Error("not used")
    },
  } as unknown as ForwardableEmailMessage
  return { message, state }
}

const deliver = async (raw: string | Uint8Array, to: string, bindings: Env = env) => {
  const { message, state } = incoming(raw, to)
  const outcome = await handleEmail(message, bindings)
  return { outcome, rejected: state.rejected }
}

let domainCounter = 0
/** A fresh domain per test, so tests never see each other's mailboxes. */
const domain = async (catchAll: "bounce" | "keep" = "bounce") => {
  const name = `d${++domainCounter}-${crypto.randomUUID().slice(0, 8)}.test`
  const id = `dom_${crypto.randomUUID()}`
  await env.DB.prepare("insert into domains (id, name, catch_all) values (?, ?, ?)")
    .bind(id, name, catchAll)
    .run()
  const mailbox = async (
    local: string,
    kind: "user" | "shared" | "group" | "alias" | "catch_all" = "user",
    targets?: ReadonlyArray<string>,
  ) => {
    const mailboxId = `mbx_${crypto.randomUUID()}`
    await env.DB.prepare(
      "insert into mailboxes (id, domain_id, address, kind, targets) values (?, ?, ?, ?, ?)",
    )
      .bind(mailboxId, id, `${local}@${name}`, kind, targets ? JSON.stringify(targets) : null)
      .run()
    return mailboxId
  }
  return { id, name, mailbox }
}

const box = (mailboxId: string) => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId))

const ledgerRow = (id: string) =>
  env.DB.prepare("select * from inbound_messages where id = ?").bind(id).first<{
    status: string
    error: string | null
    attempts: number
    delivered_to: string
    resolution: string | null
  }>()

const idOf = (outcome: unknown) => (outcome as { id: string }).id

const runInboundQueue = async (jobs: ReadonlyArray<InboundJob>) => {
  const batch = createMessageBatch(
    "mailyard-inbound",
    jobs.map((body, i) => ({
      id: `in${i}-${crypto.randomUUID()}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  )
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  return getQueueResult(batch, ctx)
}

describe("email(): store, parse, file", () => {
  it("files a message through the Worker's email export: raw and body in R2, the message in its mailbox", async () => {
    const d = await domain()
    const sam = await d.mailbox("sam")
    const raw = bytes(alternative)
    const { message, state } = incoming(raw, `sam@${d.name}`)
    await worker.email(message, env)
    expect(state.rejected).toBeNull()

    const hash = await sha(raw)
    const stored = await env.STORE.get(rawKeyOf(hash))
    expect(new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(raw)
    expect(stored?.httpMetadata?.contentType).toBe("message/rfc822")
    const body = (await (await env.STORE.get(`body/${hash}.json`))?.json()) as { text: string; html: string }
    expect(body.text).toContain("the diagrams help")
    expect(body.html).toContain("<blockquote>")

    const row = await env.DB.prepare("select * from inbound_messages where sha256 = ?")
      .bind(hash)
      .first<{ id: string; status: string; subject: string; message_id: string; from_address: string }>()
    expect(row).toMatchObject({
      status: "filed",
      subject: "Re: Engine design notes",
      message_id: "<reply-2@example.org>",
      from_address: "ada@example.org",
    })

    const filed = await box(sam).message(row?.id ?? "")
    expect(filed).toMatchObject({
      envelopeFrom: "bounce@example.org",
      envelopeTo: `sam@${d.name}`,
      via: "mailbox",
      tag: null,
      subject: "Re: Engine design notes",
      inReplyTo: "<note-1@acme.test>",
      references: ["<thread-0@acme.test>", "<note-1@acme.test>"],
      from: { name: "Ada Lovelace", address: "ada@example.org" },
      snippet: "Thanks, the diagrams help — more below.",
      hasHtml: true,
      bodyKey: `body/${hash}.json`,
      rawKey: rawKeyOf(hash),
    })
    expect(filed?.auth).toMatchObject({
      spf: "pass",
      dmarc: "pass",
      dkim: [{ result: "pass", domain: "example.org" }],
    })
    expect(await box(sam).schemaVersion()).toBe(2)
  })

  it("stores attachments content-addressed in R2 and lists them on the message", async () => {
    const d = await domain()
    const sam = await d.mailbox("sam")
    const { outcome } = await deliver(inline, `sam@${d.name}`)
    const filed = await box(sam).message(idOf(outcome))
    expect(filed?.attachments).toHaveLength(1)
    const [logo] = filed?.attachments ?? []
    expect(logo).toMatchObject({
      filename: "logo.png",
      contentId: "logo@example.org",
      related: true,
      size: 67,
    })
    expect(logo?.r2Key).toBe(`att/${logo?.sha256}`)
    const object = await env.STORE.get(logo?.r2Key ?? "")
    expect(object?.size).toBe(67)
    expect(object?.httpMetadata?.contentType).toBe("image/png")
    expect(filed?.automated).toBe(true)
    expect(filed?.listId).toBe("Example News <news.example.org>")
  })

  it("files a near-25 MiB message with its attachment intact, and bounces anything over the limit", async () => {
    const d = await domain()
    const sam = await d.mailbox("sam")
    const { raw, payload } = largeMessage(24.5 * 1024 * 1024)
    const { outcome } = await deliver(raw, `sam@${d.name}`)
    expect(outcome?.outcome).toBe("filed")
    const [big] = (await box(sam).message(idOf(outcome)))?.attachments ?? []
    expect(big?.size).toBe(payload.byteLength)
    expect((await env.STORE.head(big?.r2Key ?? ""))?.size).toBe(payload.byteLength)

    const { message, state } = incoming("tiny", `sam@${d.name}`, "x@example.org", 26 * 1024 * 1024)
    await handleEmail(message, env)
    expect(state.rejected).toBe("Message exceeds the 25 MiB limit")
  }, 60_000)

  it("delivers the same message once, however many times Email Routing hands it over", async () => {
    const d = await domain()
    const sam = await d.mailbox("sam")
    const raw = simpleMessage({ to: `sam@${d.name}` })
    const first = await deliver(raw, `sam@${d.name}`)
    const second = await deliver(raw, `sam@${d.name}`)
    expect(first.outcome?.outcome).toBe("filed")
    expect(second.outcome).toEqual({ outcome: "duplicate", id: idOf(first.outcome) })
    expect(await box(sam).count()).toBe(1)
  })
})

describe("recipient resolution", () => {
  it("routes user+tag@ to user@ and keeps the tag; an exact plus-address mailbox wins", async () => {
    const d = await domain()
    const sam = await d.mailbox("sam")
    const vip = await d.mailbox("sam+vip")
    const tagged = await deliver(attachments, `Sam+Invoices@${d.name.toUpperCase()}`)
    expect(tagged.outcome).toMatchObject({ outcome: "filed", mailboxIds: [sam] })
    expect(await box(sam).message(idOf(tagged.outcome))).toMatchObject({ tag: "invoices", via: "mailbox" })

    const exact = await deliver(simpleMessage({}), `sam+vip@${d.name}`)
    expect(exact.outcome).toMatchObject({ outcome: "filed", mailboxIds: [vip] })
    expect(await box(vip).message(idOf(exact.outcome))).toMatchObject({ tag: null })
  })

  it("expands aliases and groups, nested, deduplicated, and safe against cycles", async () => {
    const d = await domain()
    const ada = await d.mailbox("ada")
    const grace = await d.mailbox("grace")
    const support = await d.mailbox("support", "shared")
    const hello = await d.mailbox("hello", "alias", [ada])
    // team → ada, grace, the hello alias (→ ada again) and the shared support inbox.
    await d.mailbox("team", "group", [ada, grace, hello, support])
    const { outcome } = await deliver(simpleMessage({}), `team@${d.name}`)
    expect(outcome).toMatchObject({ outcome: "filed", mailboxIds: [ada, grace, support] })
    for (const id of [ada, grace, support]) expect(await box(id).count()).toBe(1)
    expect(await box(ada).message(idOf(outcome))).toMatchObject({ via: "group" })

    const aliased = await deliver(simpleMessage({}), `hello@${d.name}`)
    expect(aliased.outcome).toMatchObject({ outcome: "filed", mailboxIds: [ada] })
    expect(await box(ada).message(idOf(aliased.outcome))).toMatchObject({ via: "alias" })

    const loopA = `mbx_${crypto.randomUUID()}`
    const loopB = await d.mailbox("loop-b", "alias", [loopA, grace])
    await env.DB.prepare(
      "insert into mailboxes (id, domain_id, address, kind, targets) values (?, ?, ?, 'alias', ?)",
    )
      .bind(loopA, d.id, `loop-a@${d.name}`, JSON.stringify([loopB]))
      .run()
    const looped = await deliver(simpleMessage({}), `loop-a@${d.name}`)
    expect(looped.outcome).toMatchObject({ outcome: "filed", mailboxIds: [grace] })
  })

  it("an alias pointing nowhere bounces rather than vanishing", async () => {
    const d = await domain()
    await d.mailbox("empty", "alias", [`mbx_${crypto.randomUUID()}`])
    const { outcome, rejected } = await deliver(simpleMessage({}), `empty@${d.name}`)
    expect(outcome?.outcome).toBe("rejected")
    expect(rejected).toBe(`empty@${d.name} does not deliver to any mailbox`)
  })

  it("keeps mail for unknown addresses in the catch-all when the domain says keep", async () => {
    const d = await domain("keep")
    const catchAll = await d.mailbox("catch-all", "catch_all")
    const { outcome, rejected } = await deliver(simpleMessage({}), `nobody+x@${d.name}`)
    expect(rejected).toBeNull()
    expect(outcome).toMatchObject({ outcome: "filed", mailboxIds: [catchAll] })
    expect(await box(catchAll).message(idOf(outcome))).toMatchObject({
      via: "catch_all",
      tag: "x",
      envelopeTo: `nobody+x@${d.name}`,
    })
  })

  it("bounces unknown addresses when the domain says bounce, and unknown domains always", async () => {
    const d = await domain("bounce")
    await d.mailbox("catch-all", "catch_all")
    const unknown = await deliver(simpleMessage({}), `nobody@${d.name}`)
    expect(unknown.rejected).toBe(`No mailbox here for nobody@${d.name}`)
    expect((await ledgerRow(idOf(unknown.outcome)))?.status).toBe("rejected")

    const foreign = await deliver(simpleMessage({}), "someone@not-ours.test")
    expect(foreign.rejected).toBe("This server does not accept mail for not-ours.test")

    // The sender's retry gets the same answer, without a second ledger row.
    const again = await deliver(simpleMessage({ messageId: "<fixed@example.org>" }), `nobody@${d.name}`)
    const repeat = await deliver(simpleMessage({ messageId: "<fixed@example.org>" }), `nobody@${d.name}`)
    expect(repeat.rejected).toBe(again.rejected)
  })
})

describe("never losing mail", () => {
  /** The real bindings, except a mailbox that fails and a queue that records what it is sent. */
  const brokenMailboxes = () => {
    const sent: Array<InboundJob> = []
    const bindings = {
      ...env,
      MAILBOX: {
        idFromName: (name: string) => env.MAILBOX.idFromName(name),
        get: () => {
          throw new Error("mailbox unavailable")
        },
      },
      INBOUND_QUEUE: {
        send: async (job: InboundJob) => {
          sent.push(job)
        },
      },
    } as unknown as Env
    return { bindings, sent }
  }

  it("a delivery failure keeps the raw copy, marks the row failed and queues a retry that files it", async () => {
    const d = await domain()
    const sam = await d.mailbox("sam")
    const raw = simpleMessage({ subject: "Retry me" })
    const { bindings, sent } = brokenMailboxes()
    const { outcome, rejected } = await deliver(raw, `sam@${d.name}`, bindings)
    expect(rejected).toBeNull()
    expect(outcome).toMatchObject({ outcome: "queued" })
    expect((outcome as { error: string }).error).toContain("MailboxUnavailable")

    const id = idOf(outcome)
    expect(await ledgerRow(id)).toMatchObject({ status: "failed", attempts: 1 })
    expect(await env.STORE.head(rawKeyOf(await sha(raw)))).not.toBeNull()
    expect(sent).toEqual([
      {
        sha256: await sha(raw),
        size: raw.byteLength,
        envelopeFrom: "bounce@example.org",
        envelopeTo: `sam@${d.name}`,
        receivedAt: expect.any(Number),
      },
    ])

    const result = await runInboundQueue(sent)
    expect(result.explicitAcks).toHaveLength(1)
    expect(await ledgerRow(id)).toMatchObject({ status: "filed", attempts: 2, error: null })
    expect(await box(sam).message(id)).toMatchObject({ subject: "Retry me" })
  })

  it("a parse failure keeps the raw copy and stays reprocessable", async () => {
    const d = await domain()
    await d.mailbox("sam")
    const raw = deepMessage(80)
    const { bindings, sent } = brokenMailboxes()
    const { outcome } = await deliver(raw, `sam@${d.name}`, bindings)
    expect(outcome).toMatchObject({ outcome: "queued" })
    const id = idOf(outcome)
    expect((await ledgerRow(id))?.error).toMatch(/^ParseFailed: /)
    expect(sent).toHaveLength(1)
    expect((await env.STORE.get(rawKeyOf(await sha(raw))))?.size).toBe(raw.byteLength)

    // The consumer retries it (and would, up to max_retries, before the dead-letter queue).
    const result = await runInboundQueue(sent)
    expect(result.retryMessages).toHaveLength(1)

    const response = await call(`/v1/inbound/${id}/reprocess`, { method: "POST", key: ADMIN })
    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({ id, status: "failed", attempts: 3 })
  })

  it("a job queued before its ledger row existed creates the row and files the message", async () => {
    const d = await domain()
    const sam = await d.mailbox("sam")
    const raw = simpleMessage({ subject: "Ledger was down" })
    const hash = await sha(raw)
    await env.STORE.put(rawKeyOf(hash), raw)
    await runInboundQueue([
      {
        sha256: hash,
        size: raw.byteLength,
        envelopeFrom: "x@example.org",
        envelopeTo: `sam@${d.name}`,
        receivedAt: Date.now(),
      },
    ])
    const row = await env.DB.prepare("select id, status from inbound_messages where sha256 = ?")
      .bind(hash)
      .first<{ id: string; status: string }>()
    expect(row?.status).toBe("filed")
    expect(await box(sam).message(row?.id ?? "")).toMatchObject({ subject: "Ledger was down" })
  })

  it("a retry for an address deleted meanwhile is held, and files once the address exists again", async () => {
    const d = await domain()
    const raw = simpleMessage({ subject: "Held" })
    const hash = await sha(raw)
    await env.STORE.put(rawKeyOf(hash), raw)
    await runInboundQueue([
      {
        sha256: hash,
        size: raw.byteLength,
        envelopeFrom: "x@example.org",
        envelopeTo: `later@${d.name}`,
        receivedAt: Date.now(),
      },
    ])
    const row = await env.DB.prepare("select id, status, error from inbound_messages where sha256 = ?")
      .bind(hash)
      .first<{ id: string; status: string; error: string }>()
    expect(row).toMatchObject({ status: "held", error: `No mailbox here for later@${d.name}` })

    const later = await d.mailbox("later")
    const response = await call(`/v1/inbound/${row?.id}/reprocess`, { method: "POST", key: ADMIN })
    expect(await json(response)).toMatchObject({ status: "filed", mailboxIds: [later], deliveredTo: [later] })
    expect(await box(later).count()).toBe(1)
  })

  it("a retry after a partial group delivery files only into the mailboxes still missing it", async () => {
    const d = await domain()
    const ada = await d.mailbox("ada")
    const grace = await d.mailbox("grace")
    await d.mailbox("team", "group", [ada, grace])
    const raw = simpleMessage({ subject: "Partial" })
    let calls = 0
    const sent: Array<InboundJob> = []
    const flaky = {
      ...env,
      MAILBOX: {
        idFromName: (name: string) => env.MAILBOX.idFromName(name),
        get: (id: DurableObjectId) => {
          if (++calls === 2) throw new Error("second mailbox down")
          return env.MAILBOX.get(id)
        },
      },
      INBOUND_QUEUE: { send: async (job: InboundJob) => void sent.push(job) },
    } as unknown as Env
    const { outcome } = await deliver(raw, `team@${d.name}`, flaky)
    expect(outcome?.outcome).toBe("queued")
    const id = idOf(outcome)
    expect(JSON.parse((await ledgerRow(id))?.delivered_to ?? "[]")).toEqual([ada])
    await runInboundQueue(sent)
    expect(JSON.parse((await ledgerRow(id))?.delivered_to ?? "[]")).toEqual([ada, grace])
    expect([await box(ada).count(), await box(grace).count()]).toEqual([1, 1])
  })
})

describe("events and the ledger API", () => {
  it("emits mail.received to subscribed webhooks, once per mailbox", async () => {
    const created = await call("/v1/webhooks", {
      method: "POST",
      key: ADMIN,
      json: { url: "https://hooks.test/inbound", events: ["mail.received"] },
    })
    expect(created.status).toBe(200)
    const endpointId = (await json<{ endpoint: { id: string } }>(created)).endpoint.id
    const d = await domain()
    const ada = await d.mailbox("ada")
    const grace = await d.mailbox("grace")
    await d.mailbox("team", "group", [ada, grace])
    const { outcome } = await deliver(alternative, `team@${d.name}`)
    const { results } = await env.DB.prepare(
      "select payload from webhook_deliveries where endpoint_id = ? and event_type = 'mail.received'",
    )
      .bind(endpointId)
      .all<{ payload: string }>()
    const events = results.map(
      (r) => JSON.parse(r.payload) as { type: string; data: Record<string, unknown> },
    )
    expect(events.map((e) => e.data.mailboxId).sort()).toEqual([ada, grace].sort())
    expect(events[0]).toMatchObject({
      type: "mail.received",
      data: {
        id: idOf(outcome),
        to: `team@${d.name}`,
        via: "group",
        subject: "Re: Engine design notes",
        from: { name: "Ada Lovelace", address: "ada@example.org" },
        attachments: 0,
        auth: { spf: "pass", dkim: ["pass"], dmarc: "pass" },
      },
    })
    await call(`/v1/webhooks/${endpointId}`, { method: "DELETE", key: ADMIN })
  })

  it("lists and reads the ledger with a read key; reprocess needs admin", async () => {
    const d = await domain()
    await d.mailbox("sam")
    const filed = await deliver(simpleMessage({ subject: "Listed" }), `sam@${d.name}`)
    const bounced = await deliver(simpleMessage({}), `ghost@${d.name}`)
    const reader = (await createKey("secret", ["read"])).key

    const list = await call("/v1/inbound?status=rejected&limit=200", { key: reader })
    expect(list.status).toBe(200)
    const page = await json<{ messages: Array<{ id: string; status: string }>; nextCursor: string | null }>(
      list,
    )
    expect(page.messages.every((m) => m.status === "rejected")).toBe(true)
    expect(page.messages.map((m) => m.id)).toContain(idOf(bounced.outcome))

    const one = await call(`/v1/inbound/${idOf(filed.outcome)}`, { key: reader })
    expect(await json(one)).toMatchObject({ status: "filed", subject: "Listed", via: "mailbox", attempts: 1 })

    const paged = await json<{ messages: Array<{ id: string }>; nextCursor: string }>(
      await call("/v1/inbound?limit=1", { key: reader }),
    )
    expect(paged.messages).toHaveLength(1)
    const next = await json<{ messages: Array<{ id: string }> }>(
      await call(`/v1/inbound?limit=1&cursor=${encodeURIComponent(paged.nextCursor)}`, { key: reader }),
    )
    expect(next.messages[0]?.id).not.toBe(paged.messages[0]?.id)

    expect(
      (await call(`/v1/inbound/${idOf(filed.outcome)}/reprocess`, { method: "POST", key: reader })).status,
    ).toBe(403)
    expect((await call("/v1/inbound/inb_missing", { key: reader })).status).toBe(404)
  })
})

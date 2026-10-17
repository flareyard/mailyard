import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Env } from "../../src/Bindings.ts"
import { sendBlock } from "../../src/mail/send.ts"
import type { MailboxDO } from "../../src/objects/MailboxDO.ts"
import worker from "../../src/workers/api.ts"
import { runtimeFor } from "../../src/workers/inbound.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"
import { delivery } from "../mailbox/deliveries.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)

const setup = async (sending = true) => {
  const domain = `blk-${uid()}.test`
  const created = await json<{ id: string }>(
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain, sending } }),
  )
  const box = await json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `sam@${domain}`, kind: "user" },
    }),
  )
  return { domain, domainId: created.id, box, base: `/v1/mailboxes/${box.id}` }
}

const draftTo = async (base: string, to: string, key?: string) => {
  const res = await call(`${base}/drafts`, {
    method: "POST",
    key: ADMIN,
    json: { to: [{ address: to }], subject: "Hi", bodyText: "Hello" },
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  })
  expect(res.status).toBe(200)
  return json<{ id: string; blockedReason: string | null }>(res)
}

const send = (base: string, draftId: string, key?: string) =>
  call(`${base}/drafts/${draftId}/send`, {
    method: "POST",
    key: ADMIN,
    json: { undoSeconds: 0 },
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  })

describe("typed send refusals (SendBlocked)", () => {
  it("refuses a send from a domain with sending off", async () => {
    const { base, domainId } = await setup(false)
    const draft = await draftTo(base, "ada@example.org")
    const res = await send(base, draft.id)
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ _tag: "SendBlocked", reason: "domain_unhealthy", domainId })
  })

  it("refuses a send when a working domain's DNS broke (critical drift), not while it's being set up", async () => {
    const { base, domainId } = await setup()
    const draft = await draftTo(base, "ada@example.org")
    await env.DB.prepare(
      "insert into alerts (id, key, kind, severity, title, detail) values (?, ?, 'dns_drift', 'critical', 'MX no longer passes', 'd')",
    )
      .bind(`alr_${uid()}`, `dns_drift:${domainId}`)
      .run()
    const res = await send(base, draft.id)
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ reason: "domain_unhealthy", domainId })
  })

  it("refuses when every recipient is suppressed, and lets transactional-only suppressions through", async () => {
    const { base } = await setup()
    const blocked = `sup-${uid()}@example.org`
    const bulkOnly = `bulk-${uid()}@example.org`
    await call("/v1/suppressions", { method: "POST", key: ADMIN, json: { email: blocked } })
    await call("/v1/suppressions", {
      method: "POST",
      key: ADMIN,
      json: { email: bulkOnly, reason: "unsubscribe" },
    })
    const res = await send(base, (await draftTo(base, blocked)).id)
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ reason: "all_recipients_suppressed" })
    expect((await send(base, (await draftTo(base, bulkOnly)).id)).status).toBe(200)
  })

  it("checks again as it goes out, and puts the reason on the draft", async () => {
    const { base, box } = await setup()
    const to = `late-${uid()}@example.org`
    const draft = await draftTo(base, to)
    expect((await send(base, draft.id)).status).toBe(200)
    // Suppressed after the send was accepted, before the alarm handed it over.
    await call("/v1/suppressions", { method: "POST", key: ADMIN, json: { email: to } })
    // Hand it over the way the alarm does, however long a loaded run takes to make it due.
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box.id))
    const deadline = Date.now() + 10_000
    while ((await stub.draft(draft.id))?.status !== "due" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      await runInDurableObject(stub, (instance: MailboxDO) => instance.alarm())
    }
    expect((await stub.draft(draft.id))?.status).toBe("due")
    const batch = createMessageBatch("mailyard-mailbox-send", [
      {
        id: `m-${uid()}`,
        timestamp: new Date(),
        attempts: 1,
        body: { mailboxId: box.id, draftId: draft.id, origin: null },
      },
    ])
    const ctx = createExecutionContext()
    await worker.queue(batch, env)
    await getQueueResult(batch, ctx)
    const after = await json<{ status: string; blockedReason: string | null; lastError: string | null }>(
      await call(`${base}/drafts/${draft.id}`, { key: ADMIN }),
    )
    expect(after).toMatchObject({ status: "draft", blockedReason: "all_recipients_suppressed" })
    expect(after.lastError).toContain("suppression list")
  })

  it("refuses when Cloudflare says today's quota is used up", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url
      if (url.includes("/email/sending/limits"))
        return Response.json({
          success: true,
          result: {
            quota: { value: 100, unit: "day" },
            usage: { sent: 100, over_quota: true, resets_at: "2099-01-01T00:00:00Z" },
          },
        })
      return realFetch(input, init)
    }) as typeof fetch
    try {
      const { box } = await setup()
      const connected = { ...env, CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_EMAIL_READ_TOKEN: "t" } as Env
      const blocked = await runtimeFor(connected).runPromise(
        sendBlock({ from: box.address, recipients: ["a@b.co"] }),
      )
      expect(blocked).toMatchObject({
        reason: "quota_exhausted",
        resetsAt: Date.parse("2099-01-01T00:00:00Z"),
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("idempotent draft create and send", () => {
  it("returns the same draft and the same send for a repeated key", async () => {
    const { base } = await setup()
    const key = `offline-${uid()}`
    const first = await draftTo(base, "ada@example.org", key)
    const again = await draftTo(base, "ada@example.org", key)
    expect(again.id).toBe(first.id)
    const drafts = await json<{ drafts: Array<{ id: string }> }>(await call(`${base}/drafts`, { key: ADMIN }))
    expect(drafts.drafts.filter((d) => d.id === first.id)).toHaveLength(1)

    const sendKey = `send-${uid()}`
    const sent = await json<{ sendAt: number }>(await send(base, first.id, sendKey))
    const resent = await json<{ sendAt: number }>(await send(base, first.id, sendKey))
    expect(resent.sendAt).toBe(sent.sendAt)
    // The same key with a different body is a conflict.
    const conflict = await call(`${base}/drafts`, {
      method: "POST",
      key: ADMIN,
      json: { subject: "different" },
      headers: { "idempotency-key": key },
    })
    expect(conflict.status).toBe(409)
  })
})

describe("the live socket catches up", () => {
  const connect = async (mailboxId: string, since?: number) => {
    const res = await exports.default.fetch(
      new Request(
        `https://mailyard.test/v1/mailboxes/${mailboxId}/live${since !== undefined ? `?since=${since}` : ""}`,
        {
          headers: { upgrade: "websocket", authorization: `Bearer ${ADMIN}` },
        },
      ),
    )
    expect(res.status).toBe(101)
    const socket = res.webSocket as WebSocket
    socket.accept()
    const frames: Array<Record<string, unknown>> = []
    socket.addEventListener("message", (e) =>
      frames.push(JSON.parse(String(e.data)) as Record<string, unknown>),
    )
    const until = async (pred: (f: Array<Record<string, unknown>>) => boolean) => {
      const deadline = Date.now() + 3000
      while (!pred(frames) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      return frames
    }
    return { socket, frames, until }
  }

  it("numbers frames, replays what came after `since`, and says reset when it's gone", async () => {
    const { box } = await setup()
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box.id))
    const first = await connect(box.id)
    const hello = (await first.until((f) => f.length >= 1))[0] as { type: string; seq: number }
    expect(hello.type).toBe("hello")
    const start = hello.seq
    first.socket.close()
    // Two messages arrive while nobody's connected.
    await stub.deliver(delivery({ messageId: `<a${uid()}@x>` }))
    await stub.deliver(delivery({ messageId: `<b${uid()}@x>` }))
    const back = await connect(box.id, start)
    const frames = await back.until((f) => f.some((x) => x.type === "resumed"))
    const added = frames.filter((f) => f.type === "message.added")
    expect(added).toHaveLength(2)
    expect(added.map((f) => f.seq)).toEqual([start + 1, start + 2])
    expect(frames.at(-1)).toMatchObject({ type: "resumed", since: start, replayed: 2, seq: start + 2 })
    // Asking over the open socket works too, and an up-to-date client gets nothing to replay.
    back.socket.send(JSON.stringify({ type: "resume", since: start + 2 }))
    await back.until((f) => f.filter((x) => x.type === "resumed").length >= 2)
    expect(back.frames.at(-1)).toMatchObject({ type: "resumed", replayed: 0 })
    // Once the log no longer holds what came after `since`, the client is told to refetch.
    await runInDurableObject(stub, (_i: MailboxDO, state) => {
      state.storage.sql.exec("DELETE FROM live_events WHERE seq <= ?", start + 1)
    })
    const stale = await connect(box.id, start - 1 < 0 ? 0 : start - 1)
    const got = await stale.until((f) => f.some((x) => x.type === "reset"))
    expect(got.find((x) => x.type === "reset")).toMatchObject({ seq: start + 2 })
    back.socket.close()
    stale.socket.close()
  })
})

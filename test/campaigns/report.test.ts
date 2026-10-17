import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { rawKeyOf } from "../../src/inbound/pipeline.ts"
import worker from "../../src/workers/api.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"
import { simpleMessage } from "../inbound/messages.ts"
import { sendTracked } from "../tracking/sendTracked.ts"

installDohFixture()

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = new URL(new Request(input, init).url).hostname
  return host === "cloudflare-dns.com" ? realFetch(input, init) : new Response(null, { status: 200 })
}) as typeof fetch

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("")

/** A reply to `inReplyTo`, delivered to a fresh mailbox and run through the inbound pipeline. */
const reply = async (inReplyTo: string) => {
  const name = `rep-${crypto.randomUUID().slice(0, 8)}.test`
  const domainId = `dom_${crypto.randomUUID()}`
  await env.DB.prepare("insert into domains (id, name, catch_all) values (?, ?, 'bounce')")
    .bind(domainId, name)
    .run()
  await env.DB.prepare("insert into mailboxes (id, domain_id, address, kind) values (?, ?, ?, 'user')")
    .bind(`mbx_${crypto.randomUUID()}`, domainId, `news@${name}`)
    .run()
  const raw = simpleMessage({ subject: "Re: A", headers: `In-Reply-To: ${inReplyTo}` })
  const sha256 = hex(await crypto.subtle.digest("SHA-256", raw))
  await env.STORE.put(rawKeyOf(sha256), raw)
  const batch = createMessageBatch("mailyard-inbound", [
    {
      id: `in-${crypto.randomUUID()}`,
      timestamp: new Date(),
      attempts: 1,
      body: {
        sha256,
        size: raw.byteLength,
        envelopeFrom: "ada@example.org",
        envelopeTo: `news@${name}`,
        receivedAt: Date.now(),
      },
    },
  ])
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  await getQueueResult(batch, ctx)
}

type Report = {
  status: string
  audience: number
  sent: number
  delivered: number
  opened: number
  machineOnlyOpens: number
  clicked: number
  replied: number
  unsubscribed: number
  bounced: { hard: number; soft: number }
  complained: number
  rates: Record<string, number>
  providers: Array<{ provider: string; sent: number; delivered: number; bounced: number; opened: number }>
  links: Array<{ url: string; clicks: number; machineClicks: number }>
  activity: Array<{ hour: number; opens: number; clicks: number }>
  ab: null | { winner: string | null; variants: Array<{ variant: string; sent: number }> }
}

describe("campaign report", () => {
  it("counts the funnel, providers, links, replies and unsubscribes from the rows", async () => {
    const { campaignId, messages } = await sendTracked(5, {
      bodyHtml:
        '<html><body><a href="https://shop.test/sale">Sale</a> <a href="https://shop.test/about">About</a></body></html>',
    })
    expect(messages).toHaveLength(5)
    const [a, b, c, d, e] = messages
    if (!a || !b || !c || !d || !e) throw new Error("five messages")

    // Delivery outcomes as Email Sending would report them.
    const set = (id: string, status: string, provider: string, bounceType: string | null = null) =>
      env.DB.prepare("update messages_out set status = ?, provider = ?, bounce_type = ? where id = ?")
        .bind(status, provider, bounceType, id)
        .run()
    await set(a.id, "delivered", "gmail")
    await set(b.id, "delivered", "gmail")
    await set(c.id, "delivered", "outlook")
    await set(d.id, "bounced", "outlook", "hard")
    await set(e.id, "complained", "yahoo")

    // a: a person opens and clicks both links; b: only Apple's proxy opens; c: a scanner clicks.
    await call(a.pixel, { headers: { "user-agent": CHROME } })
    await new Promise((r) => setTimeout(r, 300))
    for (const link of a.links) await call(link, { headers: { "user-agent": CHROME }, redirect: "manual" })
    await call(a.links[0] ?? "", { headers: { "user-agent": CHROME }, redirect: "manual" })
    await call(b.pixel, { headers: { "user-agent": "Mozilla/5.0" } })
    await call(c.links[0] ?? "", { headers: { "user-agent": "Proofpoint URL Defense" }, redirect: "manual" })
    await new Promise((r) => setTimeout(r, 300))

    // c replies; b unsubscribes with one click from the campaign's header.
    if (!c.cf_message_id) throw new Error("no Message-ID")
    await reply(`<${c.cf_message_id.replace(/^<|>$/g, "").toUpperCase()}>`)
    await env.DB.prepare(
      "insert into events (id, contact_id, name, data, at) values (?, ?, 'email.unsubscribed', ?, ?)",
    )
      .bind(
        `evt_${crypto.randomUUID()}`,
        b.contact_id,
        JSON.stringify({ campaignId, topicId: null, how: "one-click" }),
        Date.now(),
      )
      .run()

    const res = await call(`/v1/campaigns/${campaignId}/report`, { key: ADMIN })
    expect(res.status).toBe(200)
    const report = await json<Report>(res)
    expect(report).toMatchObject({
      status: "sent",
      audience: 5,
      sent: 5,
      delivered: 4,
      opened: 1,
      machineOnlyOpens: 1,
      clicked: 1,
      replied: 1,
      unsubscribed: 1,
      bounced: { hard: 1, soft: 0 },
      complained: 1,
      ab: null,
    })
    expect(report.rates.delivery).toBe(0.8)
    expect(report.rates.open).toBe(0.25)
    expect(report.rates.clickToOpen).toBe(1)
    expect(report.providers).toEqual([
      expect.objectContaining({ provider: "gmail", sent: 2, delivered: 2, bounced: 0, opened: 1 }),
      expect.objectContaining({ provider: "outlook", sent: 2, delivered: 1, bounced: 1, opened: 0 }),
      expect.objectContaining({ provider: "yahoo", sent: 1, delivered: 1, bounced: 0, opened: 0 }),
    ])
    expect(report.links).toEqual([
      { url: "https://shop.test/sale", clicks: 2, machineClicks: 1 },
      { url: "https://shop.test/about", clicks: 1, machineClicks: 0 },
    ])
    expect(report.activity.reduce((n, x) => n + x.opens, 0)).toBe(1)
    expect(report.activity.reduce((n, x) => n + x.clicks, 0)).toBe(1)

    // Per recipient, filterable by outcome and paged.
    type Page = {
      recipients: Array<{ messageId: string; status: string; unsubscribed: boolean; clicks: number }>
      nextCursor: string | null
    }
    const all = await json<Page>(await call(`/v1/campaigns/${campaignId}/recipients?limit=3`, { key: ADMIN }))
    expect(all.recipients).toHaveLength(3)
    const rest = await json<Page>(
      await call(`/v1/campaigns/${campaignId}/recipients?limit=3&cursor=${all.nextCursor}`, { key: ADMIN }),
    )
    expect(rest.recipients).toHaveLength(2)
    expect(rest.nextCursor).toBeNull()
    expect(new Set([...all.recipients, ...rest.recipients].map((r) => r.messageId)).size).toBe(5)
    const only = async (status: string) =>
      (
        await json<Page>(
          await call(`/v1/campaigns/${campaignId}/recipients?status=${status}`, { key: ADMIN }),
        )
      ).recipients
    expect((await only("clicked")).map((r) => r.messageId)).toEqual([a.id])
    expect((await only("bounced")).map((r) => r.messageId)).toEqual([d.id])
    expect((await only("unsubscribed")).map((r) => r.messageId)).toEqual([b.id])
    expect((await only("delivered")).length).toBe(4)
    expect((await call(`/v1/campaigns/${campaignId}/recipients?status=nope`, { key: ADMIN })).status).toBe(
      400,
    )
  }, 90_000)

  it("resends to the people who didn't open, as a new draft", async () => {
    const { campaignId, messages } = await sendTracked(3)
    for (const m of messages)
      await env.DB.prepare("update messages_out set status = 'delivered' where id = ?").bind(m.id).run()
    const opener = messages[0]
    if (!opener) throw new Error("no message")
    await call(opener.pixel, { headers: { "user-agent": CHROME } })
    await new Promise((r) => setTimeout(r, 300))

    const res = await call(`/v1/campaigns/${campaignId}/resend-non-openers`, { method: "POST", key: ADMIN })
    expect(res.status).toBe(200)
    const draft = await json<{ id: string; status: string; segmentId: string; subject: string }>(res)
    expect(draft).toMatchObject({ status: "draft", subject: "A" })
    const preview = await json<{ matching: number; sendable: number }>(
      await call(`/v1/campaigns/${draft.id}/audience/preview`, { method: "POST", key: ADMIN }),
    )
    expect(preview.matching).toBe(2)
    expect(preview.sendable).toBe(2)

    // Not for a draft, and not for a campaign that never tracked opens.
    expect(
      (await call(`/v1/campaigns/${draft.id}/resend-non-openers`, { method: "POST", key: ADMIN })).status,
    ).toBe(400)
    const untracked = await sendTracked(1, { trackOpens: false })
    expect(
      (await call(`/v1/campaigns/${untracked.campaignId}/resend-non-openers`, { method: "POST", key: ADMIN }))
        .status,
    ).toBe(400)
  }, 90_000)

  it("reports A/B variants and 404s an unknown campaign", async () => {
    const { campaignId } = await sendTracked(4, {
      subjectB: "B",
      ab: { percent: 50, waitHours: 1, metric: "opens" },
    })
    const report = await json<Report>(await call(`/v1/campaigns/${campaignId}/report`, { key: ADMIN }))
    expect(report.ab?.variants.map((v) => v.variant)).toEqual(["a", "b"])
    expect(report.ab?.variants.reduce((n, v) => n + v.sent, 0)).toBe(report.sent)
    expect(report.ab?.winner).not.toBeNull()
    expect((await call("/v1/campaigns/cmp_nope/report", { key: ADMIN })).status).toBe(404)
  }, 90_000)
})

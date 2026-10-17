import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, nextMidnight, projectEta, providerOf } from "../../src/campaigns/governor.ts"
import worker from "../../src/workers/api.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"

/** Each test runs on its own made-up day, so their counts never meet in the shared governor. */
const day = (n: number, hour = 12) => Date.UTC(2031, 0, n, hour)
const governor = () => env.SEND_GOVERNOR.get(env.SEND_GOVERNOR.idFromName("account"))
const uid = () => crypto.randomUUID().slice(0, 8)
const people = (n: number, domain: string, prefix = "c") =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, domain }))

const reset = async (patch: Record<string, unknown> = {}) =>
  governor().configure({
    ...DEFAULT_CONFIG,
    dailyQuota: 100,
    providerPerMinute: { gmail: 10_000, microsoft: 10_000, yahoo: 10_000, apple: 10_000, other: 10_000 },
    warmup: { ...DEFAULT_CONFIG.warmup, enabled: false },
    ...patch,
  } as never)

describe("governor rules", () => {
  it("knows the big providers by their consumer domains", () => {
    expect(providerOf("gmail.com")).toBe("gmail")
    expect(providerOf("Hotmail.co.uk")).toBe("microsoft")
    expect(providerOf("yahoo.fr")).toBe("yahoo")
    expect(providerOf("icloud.com")).toBe("apple")
    expect(providerOf("mbprep.app")).toBe("other")
  })

  it("projects when a send will finish, with and without warm-up", () => {
    const now = day(1, 6)
    expect(
      projectEta({
        remaining: 50,
        now,
        todayAllowance: 80,
        dailyBulk: 80,
        warmupCap: null,
        warmupUsedToday: 0,
        warmupFactor: 2,
      }),
    ).toEqual({ days: 0, at: now })
    // 80 today, then 80 a day: 300 needs today plus three more days.
    expect(
      projectEta({
        remaining: 300,
        now,
        todayAllowance: 80,
        dailyBulk: 80,
        warmupCap: null,
        warmupUsedToday: 0,
        warmupFactor: 2,
      }),
    ).toEqual({
      days: 3,
      at: nextMidnight(now) + 2 * 86_400_000,
    })
    // Warm-up from 50: 50 + 80 (capped by quota at 100 then) + 80 ... for 200: days 0,1,2.
    expect(
      projectEta({
        remaining: 200,
        now,
        todayAllowance: 80,
        dailyBulk: 80,
        warmupCap: 50,
        warmupUsedToday: 0,
        warmupFactor: 2,
      }).days,
    ).toBe(2)
  })
})

describe("SendGovernorDO", () => {
  it("keeps the transactional share of the quota, and starts fresh at midnight UTC", async () => {
    await reset()
    const g = governor()
    const campaignId = `q-${uid()}`
    const first = await g.acquire({
      campaignId,
      sendingDomain: "news.test",
      recipients: people(100, "example.net"),
      now: day(1),
    })
    expect(first.granted).toHaveLength(80)
    expect(first.reason).toBe("quota")
    expect(first.retryAt).toBe(nextMidnight(day(1)))
    // Transactional mail is never refused, even past the quota.
    await g.consume({ stream: "transactional", count: 30, now: day(1) })
    const overview = await g.overview({ now: day(1) })
    expect(overview).toMatchObject({
      quota: 100,
      bulkRemaining: 0,
      sent: { campaign: 80, transactional: 30 },
    })

    const next = await g.acquire({
      campaignId,
      sendingDomain: "news.test",
      recipients: people(20, "example.net", "d"),
      now: day(2, 0) + 1,
    })
    expect(next.granted).toHaveLength(20)
    expect(next.reason).toBeNull()
  })

  it("gives bulk only what transactional mail has left", async () => {
    await reset()
    const g = governor()
    await g.consume({ stream: "transactional", count: 95, now: day(3) })
    const grant = await g.acquire({
      campaignId: `t-${uid()}`,
      sendingDomain: "news.test",
      recipients: people(20, "example.net"),
      now: day(3),
    })
    expect(grant.granted).toHaveLength(5)
  })

  it("paces each provider per minute, sending to others meanwhile", async () => {
    await reset({
      providerPerMinute: { gmail: 5, microsoft: 10_000, yahoo: 10_000, apple: 10_000, other: 10_000 },
    })
    const g = governor()
    const campaignId = `p-${uid()}`
    const recipients = [...people(10, "gmail.com", "g"), ...people(3, "example.net", "o")]
    const now = day(4, 9)
    const first = await g.acquire({ campaignId, sendingDomain: "news.test", recipients, now })
    expect(first.granted).toEqual(["g0", "g1", "g2", "g3", "g4", "o0", "o1", "o2"])
    expect(first.reason).toBe("provider")
    expect(first.retryAt).toBe(Math.floor(now / 60_000) * 60_000 + 60_000)
    const rest = recipients.filter((r) => !first.granted.includes(r.key))
    const second = await g.acquire({
      campaignId,
      sendingDomain: "news.test",
      recipients: rest,
      now: first.retryAt ?? 0,
    })
    expect(second.granted).toEqual(["g5", "g6", "g7", "g8", "g9"])
  })

  it("warms a new sending domain up, doubling after a clean day and holding after a dirty one", async () => {
    await reset({
      dailyQuota: 10_000,
      warmup: { ...DEFAULT_CONFIG.warmup, enabled: true, start: 50, factor: 2 },
    })
    const g = governor()
    const domain = `warm-${uid()}.test`
    const campaignId = `w-${uid()}`
    const d1 = await g.acquire({
      campaignId,
      sendingDomain: domain,
      recipients: people(60, "example.net"),
      now: day(5),
    })
    expect(d1.granted).toHaveLength(50)
    expect(d1.reason).toBe("warmup")
    for (let i = 0; i < 50; i++)
      await g.record({ campaignId: null, sendingDomain: domain, outcome: "delivered", now: day(5) })

    const d2 = await g.acquire({
      campaignId,
      sendingDomain: domain,
      recipients: people(200, "example.net"),
      now: day(6),
    })
    expect(d2.granted).toHaveLength(100)
    for (let i = 0; i < 90; i++)
      await g.record({ campaignId: null, sendingDomain: domain, outcome: "delivered", now: day(6) })
    for (let i = 0; i < 10; i++)
      await g.record({ campaignId: null, sendingDomain: domain, outcome: "bounced", now: day(6) })

    // 10% bounced on day 6, over the 2% limit: day 7 holds at 100.
    const d3 = await g.acquire({
      campaignId,
      sendingDomain: domain,
      recipients: people(200, "example.net"),
      now: day(7),
    })
    expect(d3.granted).toHaveLength(100)
    const overview = await g.overview({ now: day(7) })
    expect(overview.warming.find((w) => w.domain === domain)).toMatchObject({
      cap: 100,
      day: 3,
      sentToday: 100,
    })

    // An established domain isn't warmed at all.
    await g.configure({ establishedDomains: [domain] })
    const free = await g.acquire({
      campaignId,
      sendingDomain: domain,
      recipients: people(300, "example.net", "e"),
      now: day(7),
    })
    expect(free.granted).toHaveLength(300)
  })

  it("pauses a campaign whose bounce or complaint rate crosses the line, until it's resumed", async () => {
    await reset()
    const g = governor()
    const bouncy = `b-${uid()}`
    for (let i = 0; i < 46; i++)
      await g.record({ campaignId: bouncy, sendingDomain: "news.test", outcome: "delivered", now: day(8) })
    for (let i = 0; i < 3; i++)
      await g.record({ campaignId: bouncy, sendingDomain: "news.test", outcome: "bounced", now: day(8) })
    // 49 outcomes: under the 50 needed to judge, so it keeps going.
    expect(
      (await g.campaign({ campaignId: bouncy, sendingDomain: "news.test", remaining: 0, now: day(8) }))
        .paused,
    ).toBe(false)
    const tipped = await g.record({
      campaignId: bouncy,
      sendingDomain: "news.test",
      outcome: "bounced",
      now: day(8),
    })
    expect(tipped.paused).toBe(true)
    expect(tipped.reason).toContain("Bounce rate 8.0%")
    const held = await g.acquire({
      campaignId: bouncy,
      sendingDomain: "news.test",
      recipients: people(5, "example.net"),
      now: day(8),
    })
    expect(held).toEqual({ granted: [], retryAt: null, reason: "paused" })
    await g.resume(bouncy, day(8))
    expect(
      (
        await g.acquire({
          campaignId: bouncy,
          sendingDomain: "news.test",
          recipients: people(5, "example.net"),
          now: day(8),
        })
      ).granted,
    ).toHaveLength(5)

    const complained = `c-${uid()}`
    for (let i = 0; i < 100; i++)
      await g.record({
        campaignId: complained,
        sendingDomain: "news.test",
        outcome: "delivered",
        now: day(8),
      })
    expect(
      (
        await g.record({
          campaignId: complained,
          sendingDomain: "news.test",
          outcome: "complained",
          now: day(8),
        })
      ).paused,
    ).toBe(false)
    const second = await g.record({
      campaignId: complained,
      sendingDomain: "news.test",
      outcome: "complained",
      now: day(8),
    })
    expect(second.paused).toBe(true)
    expect(second.reason).toContain("Complaint rate")
  })
})

describe("governor wiring", () => {
  const deliver = async (body: unknown) => {
    const batch = createMessageBatch("mailyard-email-events", [
      { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body },
    ])
    const ctx = createExecutionContext()
    await worker.queue(batch, env)
    return getQueueResult(batch, ctx)
  }
  const bounce = (messageId: string, recipient: string) => ({
    type: "cf.email.sending.message.bounced",
    source: { type: "email.sending", zoneId: "z", domain: "news.mailyard.test" },
    payload: {
      eventId: crypto.randomUUID(),
      messageId,
      sender: "news@news.mailyard.test",
      recipient,
      subject: "Hi",
      terminal: true,
      delivery: { status: "bounced", provider: "gmail" },
      bounce: { type: "hard" },
    },
    metadata: {
      accountId: "a",
      eventSubscriptionId: "s",
      eventSchemaVersion: 1,
      eventTimestamp: new Date().toISOString(),
    },
  })

  it("pauses a live campaign from its delivery events, raising an alert", async () => {
    await reset({ pause: { ...DEFAULT_CONFIG.pause, minOutcomes: 3 } })
    const campaignId = `cmp_live_${uid()}`
    await env.DB.prepare(
      "insert into campaigns (id, name, status, from_address, subject) values (?, 'Spring sale', 'sending', 'news@news.mailyard.test', 'Hi')",
    )
      .bind(campaignId)
      .run()
    for (let i = 0; i < 3; i++) {
      const cf = `cf-${uid()}`
      await env.DB.prepare(
        "insert into messages_out (id, stream, cf_message_id, campaign_id, recipient, sender, subject, status) values (?, 'campaign', ?, ?, ?, 'news@news.mailyard.test', 'Hi', 'sent')",
      )
        .bind(`m-${uid()}`, cf, campaignId, `r${i}-${uid()}@example.net`)
        .run()
      const result = await deliver(bounce(cf, `r${i}@example.net`))
      expect(result.explicitAcks.length + result.retryMessages.length).toBe(1)
    }
    const row = await env.DB.prepare("select status from campaigns where id = ?")
      .bind(campaignId)
      .first<{ status: string }>()
    expect(row?.status).toBe("paused")
    const alerts = await json<{
      alerts: Array<{ id: string; kind: string; subject: { id: string } | null; severity: string }>
    }>(await call("/v1/alerts", { key: ADMIN }))
    const alert = alerts.alerts.find((a) => a.subject?.id === campaignId)
    expect(alert).toMatchObject({ kind: "campaign.paused", severity: "critical" })
    const resolved = await json<{ resolvedAt: number | null }>(
      await call(`/v1/alerts/${alert?.id}/resolve`, { method: "POST", key: ADMIN }),
    )
    expect(resolved.resolvedAt).not.toBeNull()
    const open = await json<{ alerts: Array<{ id: string }> }>(await call("/v1/alerts", { key: ADMIN }))
    expect(open.alerts.some((a) => a.id === alert?.id)).toBe(false)
  })

  it("counts transactional sends against the day, and shows the pace over HTTP", async () => {
    await reset({ dailyQuota: 500 })
    const before = await json<{ sent: { transactional: number } }>(
      await call("/v1/sending/governor", { key: ADMIN }),
    )
    const { key } = await createKey("secret")
    await call("/v1/send", {
      method: "POST",
      key,
      json: { to: `t-${uid()}@example.net`, subject: "Code", body: "<p>123</p>", from: "hi@mailyard.test" },
    })
    const after = await json<{ sent: { transactional: number }; quota: number; quotaSource: string }>(
      await call("/v1/sending/governor", { key: ADMIN }),
    )
    expect(after.sent.transactional).toBe(before.sent.transactional + 1)
    expect(after).toMatchObject({ quota: 500, quotaSource: "configured" })
  })

  it("validates and audits sending settings, admin only", async () => {
    const bad = await call("/v1/settings/sending", {
      method: "PUT",
      key: ADMIN,
      json: { transactionalReserve: 1.5 },
    })
    expect(bad.status).toBe(400)
    const saved = await json<{ transactionalReserve: number; providerPerMinute: { gmail: number } }>(
      await call("/v1/settings/sending", {
        method: "PUT",
        key: ADMIN,
        json: { transactionalReserve: 0.3, providerPerMinute: { gmail: 77 } },
      }),
    )
    expect(saved).toMatchObject({ transactionalReserve: 0.3, providerPerMinute: { gmail: 77 } })
    const audit = await env.DB.prepare(
      "select action from audit where action = 'settings.sending' limit 1",
    ).first()
    expect(audit).toEqual({ action: "settings.sending" })
    const { key } = await createKey("secret", ["read"])
    expect(
      (await call("/v1/settings/sending", { method: "PUT", key, json: { transactionalReserve: 0.1 } }))
        .status,
    ).toBe(403)
    expect((await call("/v1/settings/sending", { key })).status).toBe(200)
  })
})

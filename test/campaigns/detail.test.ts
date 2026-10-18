import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

/** HAL-3428: list summaries and counts, report minimums, pausedBy codes, timezone, edit conflicts, last test. */
installDohFixture()
const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

const sendingDomain = async () => {
  const name = `cd-${uid()}.test`
  setDns(goodDomain(name))
  await admin("/v1/domains", "POST", { name, sending: true, receiving: false })
  return name
}

type Campaign = {
  id: string
  updatedAt: number
  updatedBy: string | null
  timezone: string | null
  pausedBy: string | null
  lastTest: { at: number; results: Array<{ email: string }> } | null
}

const draft = async (extra: Record<string, unknown> = {}) => {
  const domain = await sendingDomain()
  const res = await admin("/v1/campaigns", "POST", {
    name: `Draft ${uid()}`,
    fromAddress: `News <news@${domain}>`,
    subject: "Hello",
    bodyHtml: "<p>Hi</p>",
    ...extra,
  })
  if (res.status !== 200) throw new Error(`campaign: ${await res.text()}`)
  return json<Campaign>(res)
}

const sentCampaign = async (sends: number) => {
  const id = `cmp_${uid()}`
  await env.DB.prepare(
    "insert into campaigns (id, name, from_address, subject, status, started_at, created_at, updated_at) values (?, ?, 'x@y.co', 'S', 'sent', ?, ?, ?)",
  )
    .bind(id, `Sent ${id}`, Date.now(), Date.now(), Date.now())
    .run()
  const statements: Array<D1PreparedStatement> = []
  for (let i = 0; i < sends; i++)
    statements.push(
      env.DB.prepare(
        "insert into messages_out (id, stream, campaign_id, recipient, sender, subject, status) values (?, 'campaign', ?, ?, 'x@y.co', 'S', 'queued')",
      ).bind(`${id}_${i}`, id, `p${i}@example.net`),
    )
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100))
  // Through the same status changes the send path makes, so the triggers count them.
  await env.DB.prepare("update messages_out set status = 'sent' where campaign_id = ?").bind(id).run()
  await env.DB.prepare(
    "update messages_out set status = 'delivered' where campaign_id = ? and cast(substr(id, length(?) + 2) as integer) % 10 <> 0",
  )
    .bind(id, id)
    .run()
  await env.DB.prepare(
    "update messages_out set status = 'bounced', bounce_type = 'hard' where campaign_id = ? and cast(substr(id, length(?) + 2) as integer) % 10 = 0",
  )
    .bind(id, id)
    .run()
  await env.DB.prepare(
    "update messages_out set first_opened_at = ? where campaign_id = ? and cast(substr(id, length(?) + 2) as integer) % 4 = 1",
  )
    .bind(Date.now(), id, id)
    .run()
  return id
}

describe("the campaign list (HAL-3428)", () => {
  it("gives each campaign that has sent its numbers, from the rollup", async () => {
    const id = await sentCampaign(120)
    const d = await draft()
    const { campaigns } = await json<{
      campaigns: Array<{
        id: string
        summary: { sent: number; delivered: number; bounced: number; opened: number } | null
      }>
    }>(await admin("/v1/campaigns?limit=200"))
    expect(campaigns.find((c) => c.id === id)?.summary).toMatchObject({
      sent: 120,
      delivered: 108,
      bounced: 12,
      opened: 30,
    })
    expect(campaigns.find((c) => c.id === d.id)?.summary).toBeNull()
  })

  it("counts campaigns by status", async () => {
    await draft()
    type Counts = Record<
      "draft" | "scheduled" | "sending" | "paused" | "sent" | "cancelled" | "active" | "total",
      number
    >
    const counts = await json<Counts>(await admin("/v1/campaigns/counts"))
    expect(counts.draft).toBeGreaterThanOrEqual(1)
    expect(counts.total).toBe(
      counts.draft + counts.scheduled + counts.sending + counts.paused + counts.sent + counts.cancelled,
    )
    expect(counts.active).toBe(counts.scheduled + counts.sending + counts.paused)
  })
})

describe("the campaign report (HAL-3428)", () => {
  it("gives rates from 100 sends, as fractions", async () => {
    const id = await sentCampaign(120)
    const report = await json<{
      insufficientData: boolean
      rates: { delivery: number; bounce: number; open: number }
    }>(await admin(`/v1/campaigns/${id}/report`))
    expect(report.insufficientData).toBe(false)
    expect(report.rates.delivery).toBe(0.9)
    expect(report.rates.bounce).toBe(0.1)
  })
})

describe("campaign editing (HAL-3428)", () => {
  it("stores a time zone, refuses a made-up one, and records who saved", async () => {
    const c = await draft({ timezone: "Africa/Lagos" })
    expect(c).toMatchObject({ timezone: "Africa/Lagos", updatedBy: "root" })
    const bad = await admin(`/v1/campaigns/${c.id}`, "PATCH", { timezone: "Mars/Olympus" })
    expect(bad.status).toBe(400)
    expect(await json<{ field: string }>(bad)).toMatchObject({ field: "timezone" })
  })

  it("refuses a stale edit with who saved it and when", async () => {
    const c = await draft()
    const first = await json<Campaign>(
      await admin(`/v1/campaigns/${c.id}`, "PATCH", { subject: "One", ifMatch: c.updatedAt }),
    )
    expect(first.updatedAt).toBeGreaterThanOrEqual(c.updatedAt)
    const stale = await admin(`/v1/campaigns/${c.id}`, "PATCH", { subject: "Two", ifMatch: c.updatedAt - 1 })
    expect(stale.status).toBe(409)
    expect(await json<{ reason: string; updatedAt: number; updatedBy: string }>(stale)).toMatchObject({
      reason: "stale",
      updatedAt: first.updatedAt,
      updatedBy: "root",
    })
    // Without ifMatch, a save goes through as before.
    expect((await admin(`/v1/campaigns/${c.id}`, "PATCH", { subject: "Three" })).status).toBe(200)
  })

  it("keeps the last test send", async () => {
    const c = await draft()
    const sent = await admin(`/v1/campaigns/${c.id}/test`, "POST", { to: ["qa@example.net"] })
    expect(sent.status).toBe(200)
    const got = await json<Campaign>(await admin(`/v1/campaigns/${c.id}`))
    expect(got.lastTest?.results.map((r) => r.email)).toEqual(["qa@example.net"])
    expect(got.lastTest?.at).toBeGreaterThan(0)
  })
})

describe("pause codes (HAL-3428)", () => {
  it("says a person paused it", async () => {
    const id = `cmp_${uid()}`
    await env.DB.prepare(
      "insert into campaigns (id, name, from_address, subject, status, send_at, created_at, updated_at) values (?, 'P', 'x@y.co', 'S', 'scheduled', ?, ?, ?)",
    )
      .bind(id, Date.now() + 3_600_000, Date.now(), Date.now())
      .run()
    const paused = await json<Campaign & { status: string; pausedReason: string }>(
      await admin(`/v1/campaigns/${id}/pause`, "POST"),
    )
    expect(paused).toMatchObject({ status: "paused", pausedBy: "admin" })
  })
})

import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import { toCsv } from "../../src/workers/statsCsv.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"
import { delivery } from "../mailbox/deliveries.ts"

/** HAL-3421: cross-campaign engagement, storage usage, and every chart as CSV. */
let key = ""
beforeAll(async () => {
  key = (await createKey("secret", ["read"])).key
})

const uid = () => crypto.randomUUID().slice(0, 8)

const campaign = async (name: string, startedAt = Date.now()) => {
  const id = `cmp_${uid()}`
  await env.DB.prepare(
    "insert into campaigns (id, name, from_address, subject, status, started_at, created_at, updated_at) values (?, ?, 'x@y.co', 'S', 'sending', ?, ?, ?)",
  )
    .bind(id, name, startedAt, Date.now(), Date.now())
    .run()
  return id
}

const message = async (campaignId: string, n: number) => {
  const id = `${campaignId}_m${n}`
  await env.DB.prepare(
    "insert into messages_out (id, stream, campaign_id, recipient, sender, subject, status) values (?, 'campaign', ?, ?, 'x@y.co', 'S', 'queued')",
  )
    .bind(id, campaignId, `p${n}@example.net`)
    .run()
  return id
}

const update = (id: string, set: string, ...values: Array<unknown>) =>
  env.DB.prepare(`update messages_out set ${set} where id = ?`)
    .bind(...values, id)
    .run()

type Engagement = {
  campaigns: Array<{
    id: string
    delivered: number
    uniqueOpens: number
    machineOpens: number
    uniqueClicks: number
    unsubscribed: number
    openRate: number | null
  }>
  byHour: Array<{ weekday: string; hours: Array<{ hour: number; opens: number; clicks: number }> }>
  unsubscribesByTopic: Array<{ topicId: string; name: string; unsubscribed: number }>
}

describe("engagement across campaigns (HAL-3421)", () => {
  it("counts each campaign's deliveries, opens, machine opens, clicks and unsubscribes as they happen", async () => {
    const c = await campaign(`Launch ${uid()}`)
    const ids = await Promise.all([1, 2, 3, 4].map((n) => message(c, n)))
    const at = Date.UTC(2026, 9, 14, 9, 30) // a Wednesday, 09:00 UTC
    for (const id of ids) await update(id, "status = 'sent'")
    for (const id of ids) await update(id, "status = 'delivered'")
    // A later complaint on a delivered message doesn't count it twice.
    await update(ids[0] as string, "status = 'complained'")
    await update(ids[0] as string, "first_opened_at = ?, opens = 1", at)
    await update(ids[0] as string, "opens = 2")
    await update(ids[1] as string, "first_opened_at = ?, first_clicked_at = ?", at, at)
    await update(ids[2] as string, "machine_opens = 3")
    await env.DB.prepare(
      "insert into contacts (id, email, status, fields) values (?, ?, 'unsubscribed', '{}')",
    )
      .bind(`ct_${c}`, `u-${c}@example.net`)
      .run()
    await env.DB.prepare(
      "insert into events (id, contact_id, name, data, at) values (?, ?, 'email.unsubscribed', ?, ?)",
    )
      .bind(`ev_${c}`, `ct_${c}`, JSON.stringify({ campaignId: c }), Date.now())
      .run()

    const e = await json<Engagement>(await call("/v1/stats/engagement?range=30d", { key }))
    expect(e.campaigns.find((x) => x.id === c)).toMatchObject({
      delivered: 4,
      uniqueOpens: 2,
      machineOpens: 1,
      uniqueClicks: 1,
      unsubscribed: 1,
      openRate: 0.5,
    })
    // The grid only covers the range, so look the cell up with the range that includes 2026-10-14.
    const row = await env.DB.prepare(
      "select opens, clicks from engagement_hourly where day = '2026-10-14' and hour = 9",
    ).first<{
      opens: number
      clicks: number
    }>()
    expect(row?.opens).toBeGreaterThanOrEqual(2)
    expect(row?.clicks).toBeGreaterThanOrEqual(1)
    expect(e.byHour.map((d) => d.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
    expect(e.byHour.every((d) => d.hours.length === 24)).toBe(true)
  })

  it("leaves campaigns started before the range out, and counts unsubscribes by topic", async () => {
    const old = await campaign(`Old ${uid()}`, Date.now() - 90 * 86_400_000)
    const topic = `tp_${uid()}`
    await env.DB.prepare("insert into topics (id, name, created_at) values (?, ?, ?)")
      .bind(topic, `News ${topic}`, Date.now())
      .run()
    const contact = `ct_${uid()}`
    await env.DB.prepare("insert into contacts (id, email, status, fields) values (?, ?, 'subscribed', '{}')")
      .bind(contact, `${contact}@example.net`)
      .run()
    for (const [i, to] of ["unsubscribed", "subscribed", "unsubscribed"].entries())
      await env.DB.prepare(
        'insert into subscription_changes (id, contact_id, topic_id, "from", "to", source, at) values (?, ?, ?, null, ?, \'test\', ?)',
      )
        .bind(`sc_${contact}_${i}`, contact, topic, to, Date.now())
        .run()
    const e = await json<Engagement>(await call("/v1/stats/engagement?range=7d", { key }))
    expect(e.campaigns.some((x) => x.id === old)).toBe(false)
    expect(e.unsubscribesByTopic.find((t) => t.topicId === topic)).toEqual({
      topicId: topic,
      name: `News ${topic}`,
      unsubscribed: 2,
    })
  })

  it("reads its rows by index", async () => {
    const plan = async (sql: string, ...args: Array<unknown>) =>
      (
        await env.DB.prepare(`explain query plan ${sql}`)
          .bind(...args)
          .all<{ detail: string }>()
      ).results
        .map((r) => r.detail)
        .join(" | ")
    expect(await plan("select * from engagement_hourly where day >= ?", "2026-01-01")).toMatch(
      /SEARCH engagement_hourly/,
    )
    expect(
      await plan(
        "select topic_id, count(*) from subscription_changes where \"to\" = 'unsubscribed' and at >= ? group by topic_id",
        1,
      ),
    ).toMatch(/SEARCH subscription_changes USING (COVERING )?INDEX subscription_changes_to/)
  })
})

describe("GET /v1/usage/storage (HAL-3421)", () => {
  it("adds up what each mailbox keeps, without listing R2", async () => {
    const domain = `st-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const box = await json<{ id: string }>(
      await call("/v1/mailboxes", {
        method: "POST",
        key: ADMIN,
        json: { address: `sam@${domain}`, kind: "user" },
      }),
    )
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box.id))
    await stub.deliver(delivery({ size: 1200 }))
    await stub.deliver(delivery({ size: 800 }))
    const s = await json<{
      totalBytes: number
      mailBytes: number
      byMailbox: Array<{ mailboxId: string; messages: number; bytes: number }>
    }>(await call("/v1/usage/storage", { key }))
    expect(s.byMailbox.find((m) => m.mailboxId === box.id)).toMatchObject({ messages: 2, bytes: 2000 })
    expect(s.totalBytes).toBeGreaterThanOrEqual(s.mailBytes)
    expect(s.mailBytes).toBeGreaterThanOrEqual(2000)
  })
})

describe("stats as CSV (HAL-3421)", () => {
  it("quotes what needs quoting and keeps a formula from running", () => {
    expect(
      toCsv({
        columns: ["a", "b"],
        rows: [
          ["x,y", 'say "hi"'],
          [null, 0.021],
          ["=cmd()", -1],
        ],
      }),
    ).toBe('a,b\r\n"x,y","say ""hi"""\r\n,0.021\r\n\'=cmd(),-1\r\n')
  })

  it("serves every chart, with rates as fractions, and refuses keys that can't read", async () => {
    for (const chart of [
      "volume",
      "delivery",
      "providers",
      "deferrals",
      "engagement",
      "engagement-hours",
      "unsubscribes",
      "inbound",
      "audience",
    ]) {
      const res = await call(`/v1/stats/${chart}.csv?range=7d`, { key })
      expect(res.status, chart).toBe(200)
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8")
      const text = await res.text()
      expect(text.split("\r\n")[0]?.length, chart).toBeGreaterThan(0)
    }
    const hourly = await (await call("/v1/stats/volume.csv?by=hour", { key })).text()
    expect(hourly.split("\r\n")[0]).toBe("hour,transactional,campaign,automation,mailbox")
    expect(hourly.trim().split("\r\n")).toHaveLength(25)
    const delivery = await (await call("/v1/stats/delivery.csv?range=7d", { key })).text()
    expect(delivery.split("\r\n")[0]).toContain("deliveryRate,bounceRate")
    expect((await call("/v1/stats/nope.csv", { key })).status).toBe(404)
    expect((await call("/v1/stats/volume.csv", { key: (await createKey("public")).key })).status).toBe(403)
    expect((await call("/v1/stats/volume.csv")).status).toBe(401)
  })
})

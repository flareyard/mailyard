import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { ADMIN, call, json } from "../helpers.ts"

/** HAL-3423: the in op, any-campaign rules, usedBy and in-use delete, the richer preview, topic stats. */
const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

const contact = async (body: Record<string, unknown>) => {
  const res = await admin("/v1/contacts", "POST", body)
  if (res.status !== 200) throw new Error(`contact: ${res.status} ${await res.text()}`)
  return json<{ id: string; email: string }>(res)
}

type Preview = {
  count: number
  sendable: number
  excluded: Record<string, number>
  tookMs: number
  sample: Array<{ email: string }>
}
const preview = async (filter: unknown) => {
  const res = await admin("/v1/segments/preview", "POST", { filter })
  return { status: res.status, body: (await res.json()) as Preview & { field?: string } }
}

describe("segment rules (HAL-3423)", () => {
  it("matches a field against a list, ignoring case for text", async () => {
    const tag = uid()
    for (const plan of ["pro", "Team", "free"])
      await contact({ email: `${plan}-${tag}@example.net`, fields: { plan, tag } })
    const { status, body } = await preview({
      type: "all",
      rules: [
        { type: "field", field: "tag", op: "eq", value: tag },
        { type: "field", field: "plan", op: "in", value: ["PRO", "team"] },
      ],
    })
    expect(status).toBe(200)
    expect(body.count).toBe(2)
    expect((await preview({ type: "field", field: "plan", op: "in", value: [] })).body.field).toBe("filter")
    expect((await preview({ type: "field", field: "plan", op: "eq", value: ["a"] })).body.field).toBe(
      "filter",
    )
  })

  it("matches any campaign, within a window", async () => {
    const tag = uid()
    const recent = await contact({ email: `recent-${tag}@example.net`, fields: { tag } })
    const old = await contact({ email: `old-${tag}@example.net`, fields: { tag } })
    await contact({ email: `never-${tag}@example.net`, fields: { tag } })
    const cmp = `cmp_${tag}`
    await env.DB.prepare(
      "insert into campaigns (id, name, from_address, subject, status, created_at, updated_at) values (?, 'C', 'x@y.co', 'S', 'sent', ?, ?)",
    )
      .bind(cmp, Date.now(), Date.now())
      .run()
    const mail = (id: string, who: { id: string; email: string }, at: number) =>
      env.DB.prepare(
        "insert into messages_out (id, stream, campaign_id, contact_id, recipient, sender, subject, status, first_opened_at, created_at) values (?, 'campaign', ?, ?, ?, 'x@y.co', 'S', 'delivered', ?, ?)",
      )
        .bind(id, cmp, who.id, who.email, at, at)
        .run()
    await mail(`m1_${tag}`, recent, Date.now() - 86_400_000)
    await mail(`m2_${tag}`, old, Date.now() - 60 * 86_400_000)
    const tagged = { type: "field", field: "tag", op: "eq", value: tag }
    const any = await preview({ type: "all", rules: [tagged, { type: "campaign", activity: "opened" }] })
    expect(any.body.count).toBe(2)
    const week = await preview({
      type: "all",
      rules: [tagged, { type: "campaign", activity: "received", withinDays: 7 }],
    })
    expect(week.body.sample.map((c) => c.email)).toEqual([recent.email])
    const none = await preview({
      type: "all",
      rules: [tagged, { type: "campaign", activity: "received", did: false }],
    })
    expect(none.body.count).toBe(1)
  })

  it("says who a send would mail, who it would leave out and why, and how long it took", async () => {
    const tag = uid()
    await contact({ email: `ok-${tag}@example.net`, status: "subscribed", fields: { tag } })
    await contact({ email: `no-${tag}@example.net`, status: "unsubscribed", fields: { tag } })
    const { body } = await preview({ type: "field", field: "tag", op: "eq", value: tag })
    expect(body).toMatchObject({ count: 2, sendable: 1, excluded: { unsubscribed: 1, bounced: 0 } })
    expect(body.tookMs).toBeGreaterThanOrEqual(0)
  })
})

describe("segment usage (HAL-3423)", () => {
  it("lists what uses a segment and refuses to delete it while anything does", async () => {
    const seg = await json<{ id: string; usedBy: Array<unknown> }>(
      await admin("/v1/segments", "POST", {
        name: `Used ${uid()}`,
        filter: { type: "status", in: ["subscribed"] },
      }),
    )
    expect(seg.usedBy).toEqual([])
    const automation = await json<{ id: string; name: string }>(
      await admin("/v1/automations", "POST", {
        name: `On segment ${uid()}`,
        graph: {
          nodes: [
            { id: "t", type: "trigger", config: { kind: "segment", segmentId: seg.id } },
            { id: "x", type: "exit", config: {} },
          ],
          edges: [{ from: "t", to: "x" }],
        },
      }),
    )
    const got = await json<{ usedBy: Array<{ type: string; id: string }> }>(
      await admin(`/v1/segments/${seg.id}`),
    )
    expect(got.usedBy).toEqual([{ type: "automation", id: automation.id, name: automation.name }])
    const listed = await json<{ segments: Array<{ id: string; usedBy: Array<unknown> }> }>(
      await admin("/v1/segments"),
    )
    expect(listed.segments.find((s) => s.id === seg.id)?.usedBy).toHaveLength(1)
    const refused = await admin(`/v1/segments/${seg.id}`, "DELETE")
    expect(refused.status).toBe(409)
    expect(await json<{ reason: string; message: string }>(refused)).toMatchObject({
      reason: "in-use",
      message: expect.stringContaining(automation.name),
    })
    await admin(`/v1/automations/${automation.id}`, "DELETE")
    expect((await admin(`/v1/segments/${seg.id}`, "DELETE")).status).toBe(200)
  })
})

describe("topic stats (HAL-3423)", () => {
  it("counts subscribers, joins and leaves, with rates only above 100 subscribers", async () => {
    const topic = await json<{ id: string; name: string }>(
      await admin("/v1/topics", "POST", { name: `Stats ${uid()}`, doubleOptIn: false }),
    )
    const now = Date.now()
    const statements: Array<D1PreparedStatement> = []
    for (let i = 0; i < 120; i++) {
      const id = `ts_${topic.id}_${i}`
      statements.push(
        env.DB.prepare(
          "insert into contacts (id, email, status, fields) values (?, ?, 'subscribed', '{}')",
        ).bind(id, `${id}@example.net`),
        env.DB.prepare(
          "insert into subscriptions (contact_id, topic_id, state, source, changed_at) values (?, ?, ?, 'test', ?)",
        ).bind(id, topic.id, i < 110 ? "subscribed" : "unsubscribed", now),
      )
      // 10 joined this week, 10 left.
      if (i >= 100)
        statements.push(
          env.DB.prepare(
            'insert into subscription_changes (id, contact_id, topic_id, "from", "to", source, at) values (?, ?, ?, null, ?, \'test\', ?)',
          ).bind(`chg_${id}`, id, topic.id, i < 110 ? "subscribed" : "unsubscribed", now - 3_600_000),
        )
    }
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100))
    const body = await json<{
      topics: Array<{
        topicId: string
        subscribers: number
        joined: number
        left: number
        subscribersAtStart: number
        growthRate: number | null
        unsubscribeRate: number | null
        insufficientData: boolean
      }>
    }>(await admin("/v1/topics/stats?range=7d"))
    const t = body.topics.find((x) => x.topicId === topic.id)
    expect(t).toMatchObject({
      subscribers: 110,
      joined: 10,
      left: 10,
      subscribersAtStart: 110,
      insufficientData: false,
    })
    expect(t?.unsubscribeRate).toBeCloseTo(10 / 110)
    expect(t?.growthRate).toBe(0)
    const small = await json<{ id: string }>(
      await admin("/v1/topics", "POST", { name: `Small ${uid()}`, doubleOptIn: false }),
    )
    const again = await json<{
      topics: Array<{ topicId: string; growthRate: number | null; insufficientData: boolean }>
    }>(await admin("/v1/topics/stats"))
    expect(again.topics.find((x) => x.topicId === small.id)).toMatchObject({
      growthRate: null,
      insufficientData: true,
    })
  })
})

describe("the published rule schema (HAL-3423)", () => {
  it("is a named schema in the OpenAPI document", async () => {
    const doc = await json<{ components?: { schemas?: Record<string, unknown> } }>(
      await call("/openapi.json"),
    )
    expect(Object.keys(doc.components?.schemas ?? {})).toContain("SegmentRule")
  })
})

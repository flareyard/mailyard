import { createExecutionContext, introspectWorkflowInstance } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { ADMIN, call, json } from "../helpers.ts"

/** HAL-3422: multi-value filters, the field registry, consent detail, suppression, timeline, bulk by filter. */
const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

type Contact = {
  id: string
  email: string
  status: string
  topics: Array<{
    topicId: string
    state: string
    changedAt?: number
    source?: string
    confirmedAt?: number | null
  }>
  suppression?: { reason: string; source: string; bulkOnly: boolean; cloudflare: { synced: boolean } } | null
}

const contact = async (body: Record<string, unknown>) => {
  const res = await admin("/v1/contacts", "POST", body)
  if (res.status !== 200) throw new Error(`contact: ${res.status} ${await res.text()}`)
  return json<Contact>(res)
}

describe("contact list filters (HAL-3422)", () => {
  it("takes comma lists for status and engagement", async () => {
    const tag = uid()
    const a = await contact({ email: `a-${tag}@example.net`, status: "subscribed", fields: { tag } })
    const b = await contact({ email: `b-${tag}@example.net`, status: "unsubscribed", fields: { tag } })
    const ids = async (q: string) =>
      (await json<{ contacts: Array<{ id: string }> }>(await admin(`/v1/contacts?q=${tag}&${q}`))).contacts
        .map((c) => c.id)
        .sort()
    expect(await ids("status=subscribed")).toEqual([a.id])
    expect(await ids("status=subscribed,unsubscribed")).toEqual([a.id, b.id].sort())
    expect(await ids("engagement=active,dormant")).toEqual([a.id, b.id].sort())
    expect((await admin(`/v1/contacts?status=subscribed,nonsense`)).status).toBe(400)
  })
})

describe("the field registry (HAL-3422)", () => {
  it("registers each new field with an inferred type, wherever it's written, and says where it's used", async () => {
    const tag = uid()
    await contact({ email: `f-${tag}@example.net`, fields: { [`plan_${tag}`]: "pro", [`seats_${tag}`]: 3 } })
    const c = await contact({ email: `g-${tag}@example.net` })
    await admin(`/v1/contacts/${c.id}`, "PATCH", {
      fields: { [`vip_${tag}`]: true, [`renews_${tag}`]: "2027-01-01" },
    })
    await admin("/v1/segments", "POST", {
      name: `Pro ${tag}`,
      filter: { type: "all", rules: [{ type: "field", field: `plan_${tag}`, op: "eq", value: "pro" }] },
    })
    const { fields } = await json<{
      fields: Array<{ key: string; type: string; label: string; usedBy: Array<{ type: string }> }>
    }>(await admin("/v1/contact-fields"))
    const byKey = Object.fromEntries(fields.filter((f) => f.key.endsWith(tag)).map((f) => [f.key, f]))
    expect(byKey[`plan_${tag}`]).toMatchObject({
      type: "string",
      label: `plan_${tag}`,
      usedBy: [{ type: "segment" }],
    })
    expect(byKey[`seats_${tag}`]?.type).toBe("number")
    expect(byKey[`vip_${tag}`]?.type).toBe("boolean")
    expect(byKey[`renews_${tag}`]?.type).toBe("date")

    const renamed = await json<{ label: string; type: string }>(
      await admin(`/v1/contact-fields/plan_${tag}`, "PATCH", { label: "Plan" }),
    )
    expect(renamed).toMatchObject({ label: "Plan", type: "string" })
    expect((await admin(`/v1/contact-fields/none_${tag}`, "PATCH", { label: "x" })).status).toBe(404)
  })
})

describe("consent detail and suppression on the contact (HAL-3422)", () => {
  it("keeps when, how and since when each subscription stands", async () => {
    const c = await contact({ email: `t-${uid()}@example.net` })
    const topic = await json<{ id: string }>(
      await admin("/v1/topics", "POST", { name: `T ${uid()}`, doubleOptIn: false }),
    )
    await admin(`/v1/contacts/${c.id}/topics/${topic.id}`, "PUT", { state: "subscribed" })
    const got = await json<Contact>(await admin(`/v1/contacts/${c.id}`))
    const t = got.topics.find((x) => x.topicId === topic.id)
    expect(t).toMatchObject({ state: "subscribed", source: "api" })
    expect(t?.confirmedAt).toBe(t?.changedAt)
    expect(got.suppression).toBeNull()
  })

  it("shows why mail to a suppressed contact is held back", async () => {
    const email = `s-${uid()}@example.net`
    const c = await contact({ email })
    await admin("/v1/suppressions", "POST", { email, reason: "manual", note: "Asked by phone" })
    const got = await json<Contact>(await admin(`/v1/contacts/${c.id}`))
    expect(got.suppression).toMatchObject({
      reason: "manual",
      source: "manual",
      bulkOnly: false,
      cloudflare: { synced: false },
    })
  })
})

describe("the richer timeline (HAL-3422)", () => {
  it("shows deliveries, replies and automation runs, and filters by kind", async () => {
    const email = `tl-${uid()}@example.net`
    const c = await contact({ email })
    const now = Date.now()
    await env.DB.prepare(
      "insert into events (id, contact_id, name, data, at) values (?, ?, 'email.delivered', ?, ?), (?, ?, 'signed_up', '{}', ?)",
    )
      .bind(
        `ev1_${c.id}`,
        c.id,
        JSON.stringify({ messageId: "m_1", subject: "Welcome" }),
        now - 3000,
        `ev2_${c.id}`,
        c.id,
        now - 2000,
      )
      .run()
    await env.DB.prepare(
      "insert into inbound_messages (id, sha256, raw_key, size, envelope_from, envelope_to, from_address, subject, status, received_at) values (?, 'h', 'raw/x', 10, ?, 'sam@acme.test', ?, 'Re: Welcome', 'filed', ?)",
    )
      .bind(`inb_${c.id}`, email, email, now - 1000)
      .run()
    const kinds = async (q = "") =>
      (
        await json<{ items: Array<{ kind: string; event?: string }> }>(
          await admin(`/v1/contacts/${c.id}/timeline${q}`),
        )
      ).items
    const all = await kinds()
    expect(all.map((i) => i.kind)).toEqual(expect.arrayContaining(["reply", "event", "delivery"]))
    expect(all.find((i) => i.kind === "delivery")?.event).toBe("delivered")
    expect((await kinds("?kind=delivery")).map((i) => i.kind)).toEqual(["delivery"])
    expect((await kinds("?kind=reply,event")).map((i) => i.kind).sort()).toEqual(["event", "reply"])
    expect((await admin(`/v1/contacts/${c.id}/timeline?kind=nope`)).status).toBe(400)
  })
})

describe("bulk by filter (HAL-3422)", () => {
  it("acts on up to 1,000 matching contacts at once", async () => {
    const tag = uid()
    for (const n of [1, 2, 3]) await contact({ email: `bk${n}-${tag}@example.net`, fields: { cohort: tag } })
    const topic = await json<{ id: string }>(
      await admin("/v1/topics", "POST", { name: `B ${tag}`, doubleOptIn: false }),
    )
    const res = await json<{ mode: string; updated: number }>(
      await admin("/v1/contacts/bulk", "POST", {
        filter: { field: `cohort:eq:${tag}` },
        action: { action: "addTopic", topicId: topic.id, confirmed: true },
      }),
    )
    expect(res).toMatchObject({ mode: "sync", updated: 3 })
    expect((await admin("/v1/contacts/bulk", "POST", { action: { action: "delete" } })).status).toBe(400)
    expect(
      (
        await admin("/v1/contacts/bulk", "POST", {
          ids: ["x"],
          filter: { q: "x" },
          action: { action: "delete" },
        })
      ).status,
    ).toBe(400)
  })

  it("handles more ids than D1 binds in one statement (the 100-parameter limit)", async () => {
    const tag = uid()
    const ids: Array<string> = []
    const statements: Array<D1PreparedStatement> = []
    for (let i = 0; i < 150; i++) {
      const id = `c_lim_${tag}_${i}`
      ids.push(id)
      statements.push(
        env.DB.prepare(
          "insert into contacts (id, email, status, fields) values (?, ?, 'subscribed', '{}')",
        ).bind(id, `lim${i}-${tag}@example.net`),
      )
    }
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100))
    const res = await json<{ updated: number; errors: unknown[] }>(
      await admin("/v1/contacts/bulk", "POST", {
        ids,
        action: { action: "setStatus", status: "unsubscribed" },
      }),
    )
    expect(res).toMatchObject({ updated: 150, errors: [] })
    const deleted = await json<{ updated: number }>(
      await admin("/v1/contacts/bulk", "POST", { ids, action: { action: "delete" } }),
    )
    expect(deleted.updated).toBe(150)
  })

  it("hands more than 1,000 to a Workflow, a page at a time", async () => {
    const tag = uid()
    const statements: Array<D1PreparedStatement> = []
    for (let i = 0; i < 1105; i++)
      statements.push(
        env.DB.prepare(
          "insert into contacts (id, email, status, fields) values (?, ?, 'subscribed', ?)",
        ).bind(
          `c_${tag}_${String(i).padStart(5, "0")}`,
          `big${i}-${tag}@example.net`,
          JSON.stringify({ wave: tag }),
        ),
      )
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100))
    const started = await json<{ mode: string; job: { id: string; total: number; status: string } }>(
      await admin("/v1/contacts/bulk", "POST", {
        filter: { field: `wave:eq:${tag}` },
        action: { action: "setStatus", status: "unsubscribed" },
      }),
    )
    expect(started.mode).toBe("async")
    expect(started.job).toMatchObject({ total: 1105, status: "queued" })
    await using instance = await introspectWorkflowInstance(env.CONTACT_BULK_WORKFLOW, started.job.id)
    await instance.waitForStatus("complete")
    const job = await json<{ status: string; processed: number; updated: number }>(
      await admin(`/v1/contacts/bulk/${started.job.id}`),
    )
    expect(job).toMatchObject({ status: "done", processed: 1105, updated: 1105 })
    const left = await env.DB.prepare(
      "select count(*) as n from contacts where json_extract(fields, '$.wave') = ? and status = 'subscribed'",
    )
      .bind(tag)
      .first<{ n: number }>()
    expect(left?.n).toBe(0)
    expect((await admin("/v1/contacts/bulk/blk_none")).status).toBe(404)
    createExecutionContext()
  }, 60_000)
})

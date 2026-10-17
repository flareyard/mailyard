import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { ADMIN, call, json } from "../helpers.ts"

const uid = () => crypto.randomUUID().slice(0, 8)

const contact = async (body: Record<string, unknown>) => {
  const response = await call("/v1/contacts", { method: "POST", key: ADMIN, json: body })
  if (response.status !== 200) throw new Error(`contact: ${response.status} ${await response.text()}`)
  return json<{ id: string; email: string }>(response)
}

type Preview = { count: number; sample: Array<{ email: string }>; sql: string; params: Array<unknown> }
const preview = async (filter: unknown) => {
  const response = await call("/v1/segments/preview", { method: "POST", key: ADMIN, json: { filter } })
  return {
    status: response.status,
    body: (await response.json()) as Preview & { field?: string; message?: string },
  }
}

describe("segment preview", () => {
  it("counts, samples and shows parameterised SQL", async () => {
    const tag = uid()
    for (const [i, plan] of ["pro", "pro", "free"].entries()) {
      await contact({ email: `seg${i}-${tag}@example.net`, fields: { plan, seats: i * 10, tag } })
    }
    const filter = {
      type: "all",
      rules: [
        { type: "field", field: "tag", op: "eq", value: tag },
        { type: "field", field: "plan", op: "eq", value: "PRO" },
      ],
    }
    const { status, body } = await preview(filter)
    expect(status).toBe(200)
    expect(body.count).toBe(2)
    expect(body.sample.map((c) => c.email).sort()).toEqual([
      `seg0-${tag}@example.net`,
      `seg1-${tag}@example.net`,
    ])
    // Values are bound, never written into the SQL.
    expect(body.sql).not.toContain(tag)
    expect(body.sql).not.toContain("pro")
    expect(body.params).toContain(tag)
    expect(body.sql).toContain("json_extract")

    const any = await preview({
      type: "any",
      rules: [
        { type: "field", field: "seats", op: "gte", value: 20 },
        { type: "field", field: "email", op: "startsWith", value: `seg0-${tag}` },
      ],
    })
    expect(any.body.count).toBe(2)
  })

  it("takes LIKE wildcards in a value literally", async () => {
    const tag = uid()
    await contact({ email: `wild-${tag}@example.net`, fields: { note: "50%_off" } })
    await contact({ email: `tame-${tag}@example.net`, fields: { note: "50 percent off" } })
    const { body } = await preview({
      type: "all",
      rules: [
        { type: "field", field: "email", op: "endsWith", value: `${tag}@example.net` },
        { type: "field", field: "note", op: "contains", value: "%_" },
      ],
    })
    expect(body.sample.map((c) => c.email)).toEqual([`wild-${tag}@example.net`])
  })

  it("refuses malformed trees, naming the rule at fault", async () => {
    const leaf = { type: "status", in: ["subscribed"] }
    const deep = {
      type: "all",
      rules: [
        {
          type: "all",
          rules: [{ type: "all", rules: [{ type: "all", rules: [{ type: "all", rules: [leaf] }] }] }],
        },
      ],
    }
    const cases: Array<[unknown, string]> = [
      [{ type: "field", field: "bad name", op: "eq", value: 1 }, "filter"],
      [{ type: "field", field: "plan", op: "eq" }, "filter"],
      [{ type: "field", field: "plan", op: "contains", value: 3 }, "filter"],
      [{ type: "all", rules: [{ type: "status", in: [] }] }, "filter.rules[0]"],
      [deep, "filter.rules[0].rules[0].rules[0].rules[0]"],
      [{ type: "all", rules: Array.from({ length: 51 }, () => leaf) }, "filter.rules[50]"],
      [{ type: "created" }, "filter"],
      [{ type: "nonsense" }, "filter"],
    ]
    for (const [filter, field] of cases) {
      const { status, body } = await preview(filter)
      expect(status, JSON.stringify(filter).slice(0, 80)).toBe(400)
      expect(body.field).toBe(field)
    }
  })
})

describe("saved segments", () => {
  it("saves, recounts, updates and deletes, and keeps one a campaign uses", async () => {
    const tag = uid()
    await contact({ email: `saved-${tag}@example.net`, fields: { region: "west" } })
    const created = await json<{ id: string; count: number; filter: unknown }>(
      await call("/v1/segments", {
        method: "POST",
        key: ADMIN,
        json: { name: `West ${tag}`, filter: { type: "field", field: "region", op: "eq", value: "west" } },
      }),
    )
    expect(created.count).toBeGreaterThanOrEqual(1)
    await contact({ email: `saved2-${tag}@example.net`, fields: { region: "west" } })
    const recounted = await json<{ count: number }>(await call(`/v1/segments/${created.id}`, { key: ADMIN }))
    expect(recounted.count).toBe(created.count + 1)

    const updated = await json<{ name: string; count: number }>(
      await call(`/v1/segments/${created.id}`, {
        method: "PATCH",
        key: ADMIN,
        json: { name: `Nobody ${tag}`, filter: { type: "any", rules: [] } },
      }),
    )
    expect(updated).toMatchObject({ name: `Nobody ${tag}`, count: 0 })

    const list = await json<{ segments: Array<{ id: string }> }>(await call("/v1/segments", { key: ADMIN }))
    expect(list.segments.some((s) => s.id === created.id)).toBe(true)

    await env.DB.prepare(
      "insert into campaigns (id, name, segment_id, from_address, subject) values (?, 'Uses it', ?, 'a@b.co', 'Hi')",
    )
      .bind(`cmp_${tag}`, created.id)
      .run()
    expect((await call(`/v1/segments/${created.id}`, { method: "DELETE", key: ADMIN })).status).toBe(409)
    await env.DB.prepare("delete from campaigns where id = ?").bind(`cmp_${tag}`).run()
    expect((await call(`/v1/segments/${created.id}`, { method: "DELETE", key: ADMIN })).status).toBe(200)
    expect((await call(`/v1/segments/${created.id}`, { key: ADMIN })).status).toBe(404)
  })

  it("indexes a custom field once a saved segment filters on it, and the planner uses it", async () => {
    await call("/v1/segments", {
      method: "POST",
      key: ADMIN,
      json: { name: `Tier ${uid()}`, filter: { type: "field", field: "tier", op: "eq", value: 3 } },
    })
    const index = await env.DB.prepare(
      "select name from sqlite_master where type = 'index' and name = 'contacts_field_tier'",
    ).first()
    expect(index).toEqual({ name: "contacts_field_tier" })
    const stored = await env.DB.prepare(
      "select compiled_sql, compiled_params from segments where name like 'Tier %' limit 1",
    ).first<{
      compiled_sql: string
      compiled_params: string
    }>()
    const plan = await env.DB.prepare(
      `explain query plan select id from contacts where ${stored?.compiled_sql}`,
    )
      .bind(...(JSON.parse(stored?.compiled_params ?? "[]") as Array<unknown>))
      .all<{ detail: string }>()
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("contacts_field_tier")
  })
})

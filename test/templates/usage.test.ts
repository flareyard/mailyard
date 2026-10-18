import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import { ADMIN, call, createKey, json } from "../helpers.ts"

/** HAL-3415: template usage, test sends, and who saved the draft when. */
let sender = { key: "", id: "" }
beforeAll(async () => {
  const k = await createKey("secret")
  sender = { key: k.key, id: k.apiKey.id }
})

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

type Usage = { sends30d: number; usedBy: Array<{ type: string; id: string; name: string }> }
type Latest = { version: number; updatedAt: number; updatedBy: string | null }

const template = async (name = `u-${uid()}`) =>
  json<{ id: string; latest: Latest }>(
    await admin("/v1/templates", "POST", {
      name,
      kind: "html",
      subject: "Order {{ order ?? 'update' }}",
      source: "<p>Hi {{ name ?? 'there' }}, order {{ order ?? '?' }}</p>",
      publish: true,
    }),
  )

const usageOf = async (id: string) =>
  (
    await json<{ templates: Array<{ id: string; usage?: Usage }> }>(
      await admin("/v1/templates?include=usage"),
    )
  ).templates.find((t) => t.id === id)?.usage

describe("template usage (HAL-3415)", () => {
  it("counts sends in the last 30 days and lists the keys, campaigns and automations using it", async () => {
    const t = await template()
    for (const to of ["a@example.net", "b@example.net"])
      expect(
        (
          await call("/v1/send", {
            method: "POST",
            key: sender.key,
            json: { to: `${uid()}-${to}`, template: t.id, from: "hello@mailyard.test" },
          })
        ).status,
      ).toBe(200)
    // An old day outside the window, as the rollup would hold it.
    await env.DB.prepare(
      "insert into template_daily (template_id, day, api_key_id, sends) values (?, '2020-01-01', '', 9)",
    )
      .bind(t.id)
      .run()
    // A campaign that names it (written directly: creating one through the API needs a sending domain).
    const campaign = { id: `cmp_${uid()}` }
    await env.DB.prepare(
      "insert into campaigns (id, name, from_address, subject, template_id, status, created_at, updated_at) values (?, ?, 'news@mailyard.test', 'News', ?, 'draft', ?, ?)",
    )
      .bind(campaign.id, `C ${campaign.id}`, t.id, Date.now(), Date.now())
      .run()
    const automation = await json<{ id: string }>(
      await admin("/v1/automations", "POST", {
        name: `A ${uid()}`,
        graph: {
          nodes: [
            { id: "t", type: "trigger", config: { kind: "event", event: "ordered" } },
            { id: "s", type: "send", config: { templateId: t.id, version: "published" } },
            { id: "x", type: "exit", config: {} },
          ],
          edges: [
            { from: "t", to: "s" },
            { from: "s", to: "x" },
          ],
        },
      }),
    )
    const usage = await usageOf(t.id)
    expect(usage?.sends30d).toBe(2)
    expect(usage?.usedBy).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "apiKey", id: sender.id }),
        expect.objectContaining({ type: "campaign", id: campaign.id }),
        expect.objectContaining({ type: "automation", id: automation.id }),
      ]),
    )
    // Without include, no usage is computed.
    const plain = await json<{ templates: Array<{ id: string; usage?: Usage }> }>(
      await admin("/v1/templates"),
    )
    expect(plain.templates.find((x) => x.id === t.id)?.usage).toBeUndefined()
  })

  it("reads the rollup by its primary key", async () => {
    const plan = await env.DB.prepare(
      "explain query plan select template_id, api_key_id, sum(sends) from template_daily where template_id in (?, ?) and day >= ? group by template_id, api_key_id",
    )
      .bind("a", "b", "2026-01-01")
      .all<{ detail: string }>()
    expect(plan.results.map((r) => r.detail).join(" | ")).toMatch(
      /SEARCH template_daily USING (COVERING )?INDEX sqlite_autoindex_template_daily_1/,
    )
  })
})

describe("draft saves (HAL-3415)", () => {
  it("say when the latest version was saved and by which key", async () => {
    const t = await template()
    expect(t.latest.updatedBy).toBe("root")
    const editor = await createKey("secret", ["read", "admin"])
    const before = Date.now()
    const saved = await json<{ latest: Latest }>(
      await call(`/v1/templates/${t.id}/draft`, {
        method: "PUT",
        key: editor.key,
        json: { subject: "New {{ order ?? 'x' }}", source: "<p>v2</p>" },
      }),
    )
    expect(saved.latest).toMatchObject({ version: 2, updatedBy: editor.apiKey.id })
    expect(saved.latest.updatedAt).toBeGreaterThanOrEqual(before)
  })
})

describe("POST /v1/templates/{id}/test (HAL-3415)", () => {
  it("sends the draft, marked [Test], on the test stream, outside the template's numbers", async () => {
    const t = await template()
    await admin(`/v1/templates/${t.id}/draft`, "PUT", {
      subject: "Draft for {{ order }}",
      source: "<p>Draft {{ order }}</p>",
    })
    const res = await call(`/v1/templates/${t.id}/test`, {
      method: "POST",
      key: sender.key,
      json: { to: ["qa@example.net"], data: { order: "A-1" }, from: "QA <qa@mailyard.test>" },
    })
    expect(res.status).toBe(200)
    const body = await json<{ version: number; sent: Array<{ email: string; messageId: string }> }>(res)
    expect(body.version).toBe(2)
    const row = await env.DB.prepare(
      "select stream, subject, template_version from messages_out where id = ?",
    )
      .bind(body.sent[0]?.messageId)
      .first<{ stream: string; subject: string; template_version: number }>()
    expect(row).toEqual({ stream: "test", subject: "[Test] Draft for A-1", template_version: 2 })
    expect((await usageOf(t.id))?.sends30d).toBe(0)
  })

  it("refuses more than five addresses, a bad address, no sender, and a read-only key", async () => {
    const t = await template()
    const test = (key: string, body: unknown) =>
      call(`/v1/templates/${t.id}/test`, { method: "POST", key, json: body })
    const from = "qa@mailyard.test"
    expect((await test(sender.key, { to: [], from })).status).toBe(400)
    expect(
      (await test(sender.key, { to: ["1@x.co", "2@x.co", "3@x.co", "4@x.co", "5@x.co", "6@x.co"], from }))
        .status,
    ).toBe(400)
    expect((await test(sender.key, { to: ["nope"], from })).status).toBe(400)
    const reader = await createKey("secret", ["read"])
    expect((await test(reader.key, { to: ["qa@example.net"], from })).status).toBe(403)
    expect(
      (
        await call("/v1/templates/tpl_none/test", {
          method: "POST",
          key: sender.key,
          json: { to: ["qa@example.net"], from },
        })
      ).status,
    ).toBe(404)
  })
})

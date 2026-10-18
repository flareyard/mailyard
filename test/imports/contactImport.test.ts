import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { importChunk, startImport } from "../../src/imports/contactImport.ts"
import { runtimeFor } from "../../src/workers/inbound.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"

const uid = () => crypto.randomUUID().slice(0, 8)

type Import = {
  id: string
  status: string
  rows: number
  created: number
  updated: number
  skipped: number
  invalid: number
  duplicates: number
  suppressed: number
  errors: Array<{ line: number; message: string }>
  error: string | null
  headers: Array<string> | null
}

const upload = async (body: string | Uint8Array, filename = "contacts.csv", key = ADMIN) =>
  call(`/v1/uploads?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    key,
    body,
    headers: { "content-type": "text/csv" },
  })

const uploadId = async (body: string | Uint8Array) => {
  const res = await upload(body)
  if (res.status !== 201) throw new Error(`upload: ${res.status} ${await res.text()}`)
  return (await json<{ id: string }>(res)).id
}

const startImportOf = async (payload: Record<string, unknown>) =>
  call("/v1/imports/contacts", { method: "POST", key: ADMIN, json: payload })

/** Starts an import and waits for its Workflow to finish. */
const runImport = async (payload: Record<string, unknown>, timeoutMs = 120_000) => {
  const res = await startImportOf(payload)
  if (res.status !== 200) throw new Error(`import: ${res.status} ${await res.text()}`)
  const { id } = await json<{ id: string }>(res)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = await json<Import>(await call(`/v1/imports/${id}`, { key: ADMIN }))
    if (view.status === "completed" || view.status === "failed") return view
    if (Date.now() > deadline) throw new Error(`import ${id} still ${view.status}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

const topic = async () =>
  (
    await json<{ id: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name: `T ${uid()}`, doubleOptIn: false },
      }),
    )
  ).id

const contact = (email: string) =>
  env.DB.prepare("select id, name, status, fields from contacts where email = ?").bind(email).first<{
    id: string
    name: string | null
    status: string
    fields: string
  }>()

describe("POST /v1/uploads", () => {
  it("stores a file and refuses what it shouldn't take", async () => {
    const ok = await upload("email\na@b.co\n")
    expect(ok.status).toBe(201)
    expect(await json(ok)).toMatchObject({ filename: "contacts.csv", size: 13, mimeType: "text/csv" })
    expect((await upload("")).status).toBe(400)
    expect((await upload("x", "a/b.csv")).status).toBe(400)
    const big = await call("/v1/uploads?filename=big.csv", {
      method: "POST",
      key: ADMIN,
      body: "x",
      headers: { "content-length": String(51 * 1024 * 1024) },
    })
    expect(big.status).toBe(413)
    const reader = (await createKey("secret", ["read"])).key
    expect((await upload("email\n", "c.csv", reader)).status).toBe(403)
    expect((await call("/v1/uploads?filename=c.csv", { method: "POST", body: "email\n" })).status).toBe(401)
  })
})

describe("contact CSV import", () => {
  it("maps columns, merges duplicates, respects consent and suppression, and counts every row", async () => {
    const t = await topic()
    const n = uid()
    const kept = `kept-${n}@example.net`
    const left = `left-${n}@example.net`
    const blocked = `blocked-${n}@example.net`
    // An existing subscriber, someone who unsubscribed, and a suppressed address.
    await call("/v1/contacts", {
      method: "POST",
      key: ADMIN,
      json: { email: kept, name: "Old Name", fields: { plan: "free", city: "Lagos" }, status: "subscribed" },
    })
    await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: left, status: "unsubscribed" } })
    await env.DB.prepare(
      "insert into suppressions (email, reason, source, at) values (?, 'hard_bounce', 'events', ?)",
    )
      .bind(blocked, Date.now())
      .run()

    const csv = [
      "﻿Email,Full name,Plan,Ignored,Status",
      `NEW-${n}@Example.net,"Doe, Jane",pro,x,`,
      `${kept},,team,x,`,
      `${left},Back,pro,x,subscribed`,
      `${blocked},Bounced,pro,x,`,
      "not-an-email,Nope,,x,",
      `new-${n}@example.net,"Jane ""JD"" Doe",,x,`,
      `quiet-${n}@example.net,Quiet,,x,unsubscribed`,
      `bad-${n}@example.net,Bad,,x,maybe`,
      "",
      `"multi-${n}@example.net","Line one`,
      `line two",,x,`,
    ].join("\r\n")
    const result = await runImport({
      uploadId: await uploadId(csv),
      mapping: {
        Email: "email",
        "Full name": "name",
        Plan: "fields.plan",
        Ignored: "ignore",
        Status: "status",
      },
      topicIds: [t],
    })
    expect(result).toMatchObject({
      status: "completed",
      rows: 9,
      created: 4,
      updated: 2,
      skipped: 0,
      invalid: 2,
      duplicates: 1,
      suppressed: 1,
      error: null,
    })
    expect(result.rows).toBe(
      result.created + result.updated + result.skipped + result.invalid + result.duplicates,
    )
    expect(result.headers).toEqual(["Email", "Full name", "Plan", "Ignored", "Status"])
    expect(result.errors).toEqual([
      {
        line: 6,
        message: "Not an email address: not-an-email",
        column: "Email",
        value: "not-an-email",
        code: "invalid_email",
      },
      {
        line: 9,
        message: 'Status must be subscribed or unsubscribed, not "maybe".',
        column: "Status",
        value: "maybe",
        code: "invalid_value",
      },
    ])

    // The file's duplicate merged into one contact; the later row's name wins, fields combine.
    const created = await contact(`new-${n}@example.net`)
    expect(created).toMatchObject({ name: 'Jane "JD" Doe', status: "subscribed" })
    expect(JSON.parse(created?.fields ?? "{}")).toEqual({ plan: "pro" })
    // An existing contact's fields merge, an empty cell changes nothing, the name stays.
    const merged = await contact(kept)
    expect(merged).toMatchObject({ name: "Old Name", status: "subscribed" })
    expect(JSON.parse(merged?.fields ?? "{}")).toEqual({ plan: "team", city: "Lagos" })
    // Someone who unsubscribed is not resubscribed; a suppressed address joins as suppressed.
    expect((await contact(left))?.status).toBe("unsubscribed")
    expect((await contact(blocked))?.status).toBe("suppressed")
    expect((await contact(`quiet-${n}@example.net`))?.status).toBe("unsubscribed")
    expect((await contact(`multi-${n}@example.net`))?.name).toBe("Line one\r\nline two")

    // Topic memberships for subscribers only, each with its consent record.
    const members = await env.DB.prepare(
      "select c.email from subscriptions s join contacts c on c.id = s.contact_id where s.topic_id = ? order by c.email",
    )
      .bind(t)
      .all<{ email: string }>()
    expect(members.results.map((r) => r.email).sort()).toEqual(
      [kept, `multi-${n}@example.net`, `new-${n}@example.net`].sort(),
    )
    const changes = await env.DB.prepare(
      "select count(*) as n from subscription_changes where topic_id = ? and source = 'import' and \"to\" = 'subscribed'",
    )
      .bind(t)
      .first<{ n: number }>()
    expect(changes?.n).toBe(3)
  })

  it("skips existing contacts when asked, and checks the request", async () => {
    const n = uid()
    const existing = `skip-${n}@example.net`
    await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: existing, name: "Keep" } })
    const id = await uploadId(`email,name\n${existing},Changed\nfresh-${n}@example.net,Fresh\n`)
    const result = await runImport({
      uploadId: id,
      mapping: { email: "email", name: "name" },
      onConflict: "skip",
    })
    expect(result).toMatchObject({ rows: 2, created: 1, skipped: 1, updated: 0 })
    expect((await contact(existing))?.name).toBe("Keep")
    expect((await contact(`fresh-${n}@example.net`))?.status).toBe("subscribed")

    expect((await startImportOf({ uploadId: id, mapping: { name: "name" } })).status).toBe(400)
    expect(
      (await startImportOf({ uploadId: id, mapping: { email: "email", name: "fields.bad-name" } })).status,
    ).toBe(400)
    expect(
      (await startImportOf({ uploadId: id, mapping: { email: "email" }, topicIds: ["top_nope"] })).status,
    ).toBe(400)
    expect((await startImportOf({ uploadId: "upl_nope", mapping: { email: "email" } })).status).toBe(404)
    expect((await call("/v1/imports/imp_nope", { key: ADMIN })).status).toBe(404)
    // A column the file doesn't have fails the import with a reason.
    const missing = await runImport({ uploadId: id, mapping: { email: "email", Phone: "fields.phone" } })
    expect(missing).toMatchObject({
      status: "failed",
      error: "The mapping names columns the file doesn't have: Phone.",
    })
    // An unclosed quote at the end of the file fails it too, naming the line.
    const broken = await runImport({
      uploadId: await uploadId('email\n"open@x.co\n'),
      mapping: { email: "email" },
    })
    expect(broken).toMatchObject({ status: "failed", error: "Line 2: a quoted field is never closed." })
    const list = await json<{ imports: Array<{ id: string }> }>(
      await call("/v1/imports?limit=2", { key: ADMIN }),
    )
    expect(list.imports).toHaveLength(2)
  })

  it("commits a step once: running the same step again changes nothing", async () => {
    const n = uid()
    const id = await uploadId(`email\nonce-${n}@example.net\ntwice-${n}@example.net\n`)
    // Created directly so no Workflow races this test.
    const res = await env.DB.prepare(
      "insert into contact_imports (id, upload_id, mapping, topic_ids, on_conflict, default_status, created_by) values (?, ?, ?, '[]', 'update', 'subscribed', 'test') returning id",
    )
      .bind(`imp_${n}`, id, JSON.stringify({ email: "email" }))
      .first<{ id: string }>()
    const importId = res?.id ?? ""
    const runtime = runtimeFor(env)
    const start = await runtime.runPromise(startImport(importId))
    const first = await runtime.runPromise(importChunk(importId, start.offset))
    const again = await runtime.runPromise(importChunk(importId, start.offset))
    expect(first).toMatchObject({ done: true, failed: false })
    expect(again.offset).toBe(first.offset)
    const row = await env.DB.prepare("select rows, created from contact_imports where id = ?")
      .bind(importId)
      .first<{ rows: number; created: number }>()
    expect(row).toEqual({ rows: 2, created: 2 })
  })

  it("imports 50,000 rows in steps, accounts for every one, and a re-run creates nothing new", async () => {
    const n = uid()
    const lines = ["email,first,score"]
    for (let i = 0; i < 50_000; i++) lines.push(`bulk${i}-${n}@example.net,"Name ${i}",${i % 100}`)
    // A few of the file's own duplicates and invalid rows, spread across steps.
    lines.push(`bulk7-${n}@example.net,Again,1`, "nope", `bulk49999-${n}@example.net,Last,2`)
    const csv = `${lines.join("\r\n")}\r\n`
    const id = await uploadId(csv)
    const mapping = { email: "email", first: "name", score: "fields.score" }
    const first = await runImport({ uploadId: id, mapping }, 240_000)
    expect(first).toMatchObject({ status: "completed", rows: 50_003, invalid: 1 })
    expect(first.rows).toBe(first.created + first.updated + first.skipped + first.invalid + first.duplicates)
    expect(first.created).toBe(50_000)
    const count = await env.DB.prepare("select count(*) as n from contacts where email like ?")
      .bind(`bulk%-${n}@example.net`)
      .first<{ n: number }>()
    expect(count?.n).toBe(50_000)

    const second = await runImport({ uploadId: id, mapping }, 240_000)
    expect(second).toMatchObject({ status: "completed", rows: 50_003, created: 0, invalid: 1 })
    expect(second.rows).toBe(
      second.created + second.updated + second.skipped + second.invalid + second.duplicates,
    )
    const after = await env.DB.prepare("select count(*) as n from contacts where email like ?")
      .bind(`bulk%-${n}@example.net`)
      .first<{ n: number }>()
    expect(after?.n).toBe(50_000)
  }, 600_000)
})

describe("import extras (HAL-3371)", () => {
  type Extra = Import & {
    fileName: string | null
    fileSize: number | null
    bytesRead: number
    size: number | null
    processed: number
    ratePerMinute: number | null
    etaAt: number | null
    errorsTotal: number
    errors: Array<{
      line: number
      message: string
      column: string | null
      value: string | null
      code: string | null
    }>
    consent: {
      attested: true
      statement: string | null
      attestedBy: string
      attestedAt: number | null
    } | null
  }

  it("names its file, codes each error, keeps every error, joins names, reads typed fields, and records consent", async () => {
    const tag = uid()
    const points = `points_${tag}`
    const vip = `vip_${tag}`
    await env.DB.batch([
      env.DB.prepare("insert into contact_fields (key, type, created_at) values (?, 'number', ?)").bind(
        points,
        Date.now(),
      ),
      env.DB.prepare("insert into contact_fields (key, type, created_at) values (?, 'boolean', ?)").bind(
        vip,
        Date.now(),
      ),
    ])
    const t = await topic()
    const good = [`ada-${tag}@example.net,Ada,Lovelace,1200,yes`, `alan-${tag}@example.net,Alan,,7,no`]
    const bad = [
      `not-an-email,X,Y,1,yes`,
      `,No,Email,1,yes`,
      `grace-${tag}@example.net,Grace,Hopper,lots,yes`,
      ...Array.from({ length: 120 }, (_, i) => `broken${i}-${tag}`),
    ]
    const csv = `Email,First,Last,Points,VIP\n${[...good, ...bad].join("\n")}\n`
    const view = (await runImport({
      uploadId: await uploadId(csv),
      mapping: {
        Email: "email",
        First: "name.first",
        Last: "name.last",
        Points: `fields.${points}`,
        VIP: `fields.${vip}`,
      },
      topicIds: [t],
      consent: { attested: true, statement: "They signed up at the 2026 meetup." },
    })) as Extra
    expect(view).toMatchObject({
      status: "completed",
      fileName: "contacts.csv",
      fileSize: csv.length,
      size: csv.length,
      bytesRead: csv.length,
      processed: 125,
      created: 2,
      invalid: 123,
      errorsTotal: 123,
      ratePerMinute: null,
      etaAt: null,
      consent: { attested: true, statement: "They signed up at the 2026 meetup.", attestedBy: "root" },
    })
    // The first 100 are on the import, each with where and why.
    expect(view.errors).toHaveLength(100)
    expect(view.errors.slice(0, 3)).toEqual([
      {
        line: 4,
        message: "Not an email address: not-an-email",
        column: "Email",
        value: "not-an-email",
        code: "invalid_email",
      },
      { line: 5, message: "No email.", column: "Email", value: null, code: "missing_email" },
      expect.objectContaining({ line: 6, column: "Points", value: "lots", code: "invalid_value" }),
    ])
    // All 123 in the CSV, in file order.
    const res = await call(`/v1/imports/${view.id}/errors.csv`, { key: ADMIN })
    expect(res.status).toBe(200)
    const lines = (await res.text()).replace(/^﻿/, "").trim().split("\r\n")
    expect(lines[0]).toBe("line,column,value,code,message")
    expect(lines).toHaveLength(124)
    expect(lines[1]).toBe("4,Email,not-an-email,invalid_email,Not an email address: not-an-email")
    expect(lines.at(-1)).toMatch(new RegExp(`^126,Email,broken119-${tag},invalid_email,`))

    // Names joined; typed fields stored as their type; an empty last name leaves just the first.
    const ada = await contact(`ada-${tag}@example.net`)
    expect(ada?.name).toBe("Ada Lovelace")
    expect(JSON.parse(ada?.fields ?? "{}")).toMatchObject({ [points]: 1200, [vip]: true })
    expect((await contact(`alan-${tag}@example.net`))?.name).toBe("Alan")
    // Each subscription it made carries the attestation.
    const change = await env.DB.prepare(
      "select evidence from subscription_changes where contact_id = ? and topic_id = ?",
    )
      .bind(ada?.id, t)
      .first<{ evidence: string }>()
    expect(JSON.parse(change?.evidence ?? "{}")).toMatchObject({
      importId: view.id,
      attestedBy: "root",
      statement: "They signed up at the 2026 meetup.",
    })
  })

  it("refuses a mixed name mapping and an unattested consent", async () => {
    const id = await uploadId("email,n,f\na@b.co,x,y\n")
    const mixed = await startImportOf({
      uploadId: id,
      mapping: { email: "email", n: "name", f: "name.first" },
    })
    expect(mixed.status).toBe(400)
    const unattested = await startImportOf({
      uploadId: id,
      mapping: { email: "email" },
      consent: { attested: false },
    })
    expect(await json(unattested)).toMatchObject({ field: "consent.attested" })
  })

  it("cancels: the import stops, what it wrote stays, and a finished one can't be cancelled", async () => {
    const tag = uid()
    const rows = Array.from({ length: 12_000 }, (_, i) => `c${i}-${tag}@example.net`)
    const started = await startImportOf({
      uploadId: await uploadId(`email\n${rows.join("\n")}\n`),
      mapping: { email: "email" },
    })
    const { id } = await json<{ id: string }>(started)
    const cancelled = await call(`/v1/imports/${id}/cancel`, { method: "POST", key: ADMIN })
    expect(cancelled.status).toBe(200)
    expect(await json(cancelled)).toMatchObject({ status: "cancelled" })
    // A step that runs after the cancel writes nothing.
    const before = await json<Import>(await call(`/v1/imports/${id}`, { key: ADMIN }))
    const chunk = await runtimeFor(env).runPromise(importChunk(id, 0))
    expect(chunk).toMatchObject({ done: true })
    await new Promise((r) => setTimeout(r, 500))
    const after = await json<Import>(await call(`/v1/imports/${id}`, { key: ADMIN }))
    expect(after.status).toBe("cancelled")
    expect(after.rows).toBe(before.rows)
    const again = await call(`/v1/imports/${id}/cancel`, { method: "POST", key: ADMIN })
    expect(again.status).toBe(400)
    const reader = (await createKey("secret", ["read"])).key
    expect((await call(`/v1/imports/${id}/cancel`, { method: "POST", key: reader })).status).toBe(403)
  })
})

describe("export extras (HAL-3371)", () => {
  it("counts without writing on a dry run, and shows progress and who started it", async () => {
    const tag = uid()
    for (const i of [1, 2, 3])
      await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: `x${i}-${tag}@example.net` } })
    const before = await env.DB.prepare("select count(*) as n from exports").first<{ n: number }>()
    const dry = await call("/v1/exports?dryRun=1", {
      method: "POST",
      key: ADMIN,
      json: { kind: "contacts", filter: { q: tag } },
    })
    expect(await json(dry)).toEqual({ dryRun: true, rows: 3 })
    expect(await env.DB.prepare("select count(*) as n from exports").first<{ n: number }>()).toEqual(before)
    const real = await json<{ processed: number; total: number; createdBy: string; rows: number }>(
      await call("/v1/exports", {
        method: "POST",
        key: ADMIN,
        json: { kind: "contacts", filter: { q: tag } },
      }),
    )
    expect(real).toMatchObject({ rows: 3, processed: 3, total: 3, createdBy: "root" })
  })
})

import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Env } from "../../src/Bindings.ts"
import {
  beginLargeExport,
  csvCell,
  finishLargeExport,
  writeExportPart,
} from "../../src/exports/contactExport.ts"
import { parseCsv } from "../../src/imports/csv.ts"
import { runtimeFor } from "../../src/workers/inbound.ts"
import { ADMIN, call, json } from "../helpers.ts"

const uid = () => crypto.randomUUID().slice(0, 8)
const DAY = 86_400_000

/** Contacts tagged with `batch`, so a test only ever sees its own. */
const seed = async (
  batch: string,
  rows: ReadonlyArray<{
    name?: string
    fields: Record<string, unknown>
    events?: ReadonlyArray<[string, number]>
  }>,
) => {
  const ids: Array<string> = []
  for (const [i, r] of rows.entries()) {
    const id = `ct_${batch}_${i}`
    await env.DB.prepare(
      "insert into contacts (id, email, name, fields, status) values (?, ?, ?, ?, 'subscribed')",
    )
      .bind(id, `f${i}-${batch}@example.net`, r.name ?? null, JSON.stringify({ batch, ...r.fields }))
      .run()
    for (const [name, daysAgo] of r.events ?? [])
      await env.DB.prepare("insert into events (id, contact_id, name, data, at) values (?, ?, ?, null, ?)")
        .bind(`ev_${uid()}${uid()}`, id, name, Date.now() - daysAgo * DAY)
        .run()
    ids.push(id)
  }
  return ids
}

const listIds = async (query: string) => {
  const res = await call(`/v1/contacts?limit=200&${query}`, { key: ADMIN })
  if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`)
  return (await json<{ contacts: Array<{ id: string }>; count: number }>(res)).contacts
    .map((c) => c.id)
    .sort()
}

const previewCount = async (rules: ReadonlyArray<unknown>) =>
  (
    await json<{ count: number }>(
      await call("/v1/segments/preview", {
        method: "POST",
        key: ADMIN,
        json: { filter: { type: "all", rules } },
      }),
    )
  ).count

describe("contacts list: segment, field and event filters", () => {
  it("each filter returns the same set as the segment preview of the same rule", async () => {
    const batch = uid()
    const ids = await seed(batch, [
      { name: "Ada", fields: { plan: "pro", score: 90 }, events: [["purchase", 2]] },
      { name: "Bo", fields: { plan: "free", score: 10 }, events: [["purchase", 40]] },
      { name: "Cy", fields: { plan: "pro team", score: 55 } },
      { name: "Di", fields: { score: 70 }, events: [["signup", 1]] },
    ])
    const mine = { type: "field", field: "batch", op: "eq", value: batch }
    const cases: ReadonlyArray<[string, ReadonlyArray<unknown>, ReadonlyArray<string>]> = [
      ["field=plan:eq:pro", [{ type: "field", field: "plan", op: "eq", value: "pro" }], [ids[0] ?? ""]],
      [
        "field=plan:contains:pro",
        [{ type: "field", field: "plan", op: "contains", value: "pro" }],
        [ids[0] ?? "", ids[2] ?? ""],
      ],
      [
        "field=score:gt:50",
        [{ type: "field", field: "score", op: "gt", value: 50 }],
        [ids[0] ?? "", ids[2] ?? "", ids[3] ?? ""],
      ],
      ["field=plan:missing", [{ type: "field", field: "plan", op: "missing" }], [ids[3] ?? ""]],
      ["event=purchase", [{ type: "event", name: "purchase" }], [ids[0] ?? "", ids[1] ?? ""]],
      ["event=purchase:30", [{ type: "event", name: "purchase", withinDays: 30 }], [ids[0] ?? ""]],
      ["event=!purchase", [{ type: "event", name: "purchase", did: false }], [ids[2] ?? "", ids[3] ?? ""]],
      [
        "field=plan:contains:pro&event=purchase",
        [
          { type: "field", field: "plan", op: "contains", value: "pro" },
          { type: "event", name: "purchase" },
        ],
        [ids[0] ?? ""],
      ],
    ]
    for (const [query, rules, expected] of cases) {
      const got = await listIds(`${query}&field=${encodeURIComponent(`batch:eq:${batch}`)}`)
      expect(got, query).toEqual([...expected].sort())
      expect(await previewCount([mine, ...rules]), query).toBe(expected.length)
    }

    // A saved segment, combined with the list's own filters.
    const segment = await json<{ id: string }>(
      await call("/v1/segments", {
        method: "POST",
        key: ADMIN,
        json: {
          name: `S ${batch}`,
          filter: { type: "all", rules: [mine, { type: "field", field: "score", op: "gte", value: 55 }] },
        },
      }),
    )
    expect(await listIds(`segmentId=${segment.id}`)).toEqual(
      [ids[0] ?? "", ids[2] ?? "", ids[3] ?? ""].sort(),
    )
    expect(await listIds(`segmentId=${segment.id}&q=ada`)).toEqual([ids[0] ?? ""])
  })

  it("says what's wrong with a filter", async () => {
    expect((await call("/v1/contacts?field=plan", { key: ADMIN })).status).toBe(400)
    expect((await call("/v1/contacts?field=plan:like:x", { key: ADMIN })).status).toBe(400)
    expect((await call("/v1/contacts?field=plan:eq", { key: ADMIN })).status).toBe(400)
    expect((await call("/v1/contacts?event=:5", { key: ADMIN })).status).toBe(400)
    expect((await call("/v1/contacts?segmentId=seg_nope", { key: ADMIN })).status).toBe(404)
  })
})

type Export = {
  id: string
  status: string
  rows: number
  url: string | null
  filename: string
  error: string | null
}

const download = async (url: string | null) => {
  if (!url) throw new Error("no url")
  const res = await call(new URL(url).pathname)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/csv")
  expect(res.headers.get("content-disposition")).toContain("attachment")
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(await res.arrayBuffer())
}
const rowsOf = (text: string) =>
  parseCsv(text.replace(/^﻿/, ""), { maxRecords: 1e9, final: true }).records.map((r) => r.fields)

describe("POST /v1/exports", () => {
  it("writes the filtered list as a CSV a spreadsheet reads correctly", async () => {
    const batch = uid()
    await seed(batch, [
      { name: 'Doe, "JD"', fields: { plan: "pro", note: "line one\nline two" } },
      { name: "=HYPERLINK(1)", fields: { plan: "pro", note: "+1 555" } },
      { name: "Free", fields: { plan: "free" } },
    ])
    const res = await call("/v1/exports", {
      method: "POST",
      key: ADMIN,
      json: {
        kind: "contacts",
        filter: { field: [`batch:eq:${batch}`, "plan:eq:pro"] },
        fields: ["plan", "note"],
      },
    })
    expect(res.status).toBe(200)
    const view = await json<Export>(res)
    expect(view).toMatchObject({ status: "completed", rows: 2 })
    const text = await download(view.url)
    expect(text.startsWith("﻿")).toBe(true)
    expect(text).toContain("\r\n")
    const rows = rowsOf(text)
    expect(rows[0]).toEqual([
      "id",
      "email",
      "name",
      "status",
      "engagement",
      "topics",
      "created_at",
      "last_activity_at",
      "last_opened_at",
      "last_clicked_at",
      "plan",
      "note",
    ])
    const byName = new Map(rows.slice(1).map((r) => [r[2], r]))
    expect(byName.get('Doe, "JD"')?.[11]).toBe("line one\nline two")
    // A formula-looking cell is shown, not run.
    expect(byName.get("'=HYPERLINK(1)")?.[11]).toBe("'+1 555")
    expect(rows).toHaveLength(3)
    // The link is signed; tampering with it fails.
    const tampered = `${new URL(view.url ?? "").pathname.slice(0, -3)}AAA`
    expect((await call(tampered)).status).toBe(403)
    // And it can be fetched again later.
    const again = await json<Export>(await call(`/v1/exports/${view.id}`, { key: ADMIN }))
    expect(again.url).not.toBeNull()
  })

  it("checks the request", async () => {
    expect(
      (
        await call("/v1/exports", {
          method: "POST",
          key: ADMIN,
          json: { kind: "contacts", fields: ["bad-name"] },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call("/v1/exports", {
          method: "POST",
          key: ADMIN,
          json: { kind: "contacts", filter: { segmentId: "seg_nope" } },
        })
      ).status,
    ).toBe(404)
    expect((await call("/v1/exports/exp_nope", { key: ADMIN })).status).toBe(404)
  })

  it("escapes cells the way RFC 4180 and spreadsheets need", () => {
    expect(csvCell("plain")).toBe("plain")
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell("@cmd")).toBe("'@cmd")
    expect(csvCell("-2+3")).toBe("'-2+3")
    expect(csvCell(" padded")).toBe('" padded"')
    expect(csvCell(null)).toBe("")
    expect(csvCell(42)).toBe("42")
  })

  it("writes a large export in multipart parts that join into one file", async () => {
    const batch = uid()
    const n = 3_000
    // About 2 KB a row, so the file is over 6 MiB: two real parts at R2's 5 MiB minimum.
    const pad = "x".repeat(2_000)
    for (let start = 0; start < n; start += 500) {
      const values = Array.from({ length: Math.min(500, n - start) }, (_, k) => {
        const i = start + k
        return {
          id: `ct_${batch}_${String(i).padStart(5, "0")}`,
          email: `big${i}-${batch}@example.net`,
          fields: JSON.stringify({ batch, n: i, pad }),
        }
      })
      await env.DB.prepare(
        "insert into contacts (id, email, fields, status) select json_extract(value, '$.id'), json_extract(value, '$.email'), json_extract(value, '$.fields'), 'subscribed' from json_each(?)",
      )
        .bind(JSON.stringify(values))
        .run()
    }
    const id = `exp_${batch}`
    await env.DB.prepare(
      "insert into exports (id, kind, filter, fields, key, filename, created_by) values (?, 'contacts', ?, '[\"n\",\"pad\"]', ?, 'big.csv', 'test')",
    )
      .bind(id, JSON.stringify({ field: `batch:eq:${batch}` }), `exports/${id}.csv`)
      .run()
    const runtime = runtimeFor({ ...env, MAILYARD_EXPORT_PART_BYTES: String(5 * 1024 * 1024) } as Env)
    await runtime.runPromise(beginLargeExport(id))
    let parts = 0
    for (let part = 1; part < 50; part++) {
      parts = part
      const r = await runtime.runPromise(writeExportPart(id, part))
      // A retried step changes nothing.
      await runtime.runPromise(writeExportPart(id, part))
      if (r.done) break
    }
    expect(parts).toBe(2)
    await runtime.runPromise(finishLargeExport(id))
    const view = await json<Export>(await call(`/v1/exports/${id}`, { key: ADMIN }))
    expect(view).toMatchObject({ status: "completed", rows: n })
    // A large export finishes after its request: the alerts drawer says it's ready.
    expect(
      await env.DB.prepare("select kind, severity, subject from alerts where key = ? and resolved_at is null")
        .bind(`export_ready:${id}`)
        .first(),
    ).toMatchObject({ kind: "export_ready", severity: "info" })
    const rows = rowsOf(await download(view.url))
    expect(rows).toHaveLength(n + 1)
    expect(new Set(rows.slice(1).map((r) => r[0])).size).toBe(n)
    expect(rows.slice(1).map((r) => Number(r[10]))).toEqual(Array.from({ length: n }, (_, i) => i))
    expect(rows[1]?.[11]).toBe(pad)
  }, 120_000)

  it("hands an export past 10,000 rows to the Workflow, which completes it", async () => {
    const batch = uid()
    const n = 10_050
    for (let start = 0; start < n; start += 2_500) {
      const values = Array.from({ length: Math.min(2_500, n - start) }, (_, k) => {
        const i = start + k
        return {
          id: `ct_${batch}_${String(i).padStart(5, "0")}`,
          email: `wf${i}-${batch}@example.net`,
          fields: JSON.stringify({ batch }),
        }
      })
      await env.DB.prepare(
        "insert into contacts (id, email, fields, status) select json_extract(value, '$.id'), json_extract(value, '$.email'), json_extract(value, '$.fields'), 'subscribed' from json_each(?)",
      )
        .bind(JSON.stringify(values))
        .run()
    }
    const res = await call("/v1/exports", {
      method: "POST",
      key: ADMIN,
      json: { kind: "contacts", filter: { field: `batch:eq:${batch}` } },
    })
    const started = await json<Export>(res)
    expect(started).toMatchObject({ status: "running", url: null })
    let view = started
    for (let i = 0; i < 300 && view.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 300))
      view = await json<Export>(await call(`/v1/exports/${started.id}`, { key: ADMIN }))
    }
    expect(view).toMatchObject({ status: "completed", rows: n, error: null })
    expect(rowsOf(await download(view.url))).toHaveLength(n + 1)
  }, 180_000)
})

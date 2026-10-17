import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { beforeAll, describe, expect, it } from "vitest"
import type { Env } from "../src/Bindings.ts"
import { sendBulkMessage } from "../src/domain/outbox.ts"
import {
  addSuppression,
  getSuppression,
  listSuppressions,
  pushSuppression,
  removeSuppression,
  syncWithCloudflare,
  updateSuppression,
} from "../src/domain/suppressions.ts"
import { importChunk, reasonOf, startImport } from "../src/imports/suppressionImport.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

const uid = () => crypto.randomUUID().slice(0, 8)
const addr = (tag = "s") => `${tag}-${uid()}@example.net`

type Suppression = {
  email: string
  reason: string
  source: string
  note: string | null
  bulkOnly: boolean
  streams: Array<string>
  cloudflare: string
  messageId: string | null
}
type List = {
  suppressions: Array<Suppression>
  counts: Record<string, number>
  cloudflare: { readable: boolean; writable: boolean; checkedAt: number | null }
  nextCursor: string | null
}

const contactWith = async (email: string, status = "subscribed") => {
  const id = `con_${uid()}${uid()}`
  await env.DB.prepare("insert into contacts (id, email, status) values (?, ?, ?)")
    .bind(id, email, status)
    .run()
  return id
}
const contactStatus = async (email: string) =>
  (
    await env.DB.prepare("select status from contacts where email = ?")
      .bind(email)
      .first<{ status: string }>()
  )?.status
const row = (email: string) =>
  env.DB.prepare("select * from suppressions where email = ?").bind(email).first<Record<string, unknown>>()
const enc = encodeURIComponent

const add = (payload: Record<string, unknown>, key = ADMIN) =>
  call("/v1/suppressions", { method: "POST", key, json: payload })

describe("the suppressions API", () => {
  let readKey = ""
  beforeAll(async () => {
    readKey = (await createKey("secret", ["read"])).key
  })

  it("adds an address by hand, blocks its contact, and lists it", async () => {
    const email = addr("manual")
    await contactWith(email, "subscribed")
    const res = await add({ email: `  ${email.toUpperCase()} `, note: "Asked by phone" })
    expect(res.status).toBe(200)
    const body = await json<{ suppression: Suppression; created: boolean; cloudflare: unknown }>(res)
    expect(body).toMatchObject({
      created: true,
      cloudflare: null,
      suppression: {
        email,
        reason: "manual",
        source: "manual",
        note: "Asked by phone",
        bulkOnly: false,
        streams: ["all"],
        cloudflare: "unchecked",
      },
    })
    expect(await contactStatus(email)).toBe("suppressed")
    expect((await row(email))?.contact_status_before).toBe("subscribed")

    // Adding it again keeps it; a new note is taken.
    const again = await json<{ suppression: Suppression; created: boolean }>(
      await add({ email, reason: "hard_bounce", note: "Second note" }),
    )
    expect(again).toMatchObject({ created: false, suppression: { reason: "manual", note: "Second note" } })

    const list = await json<List>(await call(`/v1/suppressions?q=${enc(email)}`, { key: readKey }))
    expect(list.suppressions.map((s) => s.email)).toEqual([email])
    expect(list.counts.total).toBeGreaterThanOrEqual(1)
    expect(list.counts.manual).toBeGreaterThanOrEqual(1)
    expect(list.cloudflare).toMatchObject({ readable: false, writable: false, checkedAt: null })

    const detail = await json<{
      contact: { status: string } | null
      contactStatusBefore: string
      cloudflareEntries: null
    }>(await call(`/v1/suppressions/${enc(email)}`, { key: readKey }))
    expect(detail).toMatchObject({
      contact: { status: "suppressed" },
      contactStatusBefore: "subscribed",
      cloudflareEntries: null,
    })
  })

  it("refuses bad input and callers without admin", async () => {
    expect((await add({ email: "not-an-address" })).status).toBe(400)
    expect((await add({ email: addr() }, readKey)).status).toBe(403)
    expect((await call(`/v1/suppressions/${enc(addr())}`, { key: ADMIN })).status).toBe(404)
    expect((await call("/v1/suppressions?cursor=nope", { key: ADMIN })).status).toBe(400)
  })

  it("pages newest first with a cursor, and filters by reason and source", async () => {
    const tag = uid()
    const emails = [0, 1, 2, 3, 4].map((i) => `page-${tag}-${i}@example.net`)
    for (const [i, email] of emails.entries())
      await env.DB.prepare("insert into suppressions (email, reason, source, at) values (?, ?, 'events', ?)")
        .bind(email, i % 2 ? "complaint" : "hard_bounce", 1_000_000 + i)
        .run()
    const seen: Array<string> = []
    let cursor: string | null = null
    do {
      const page: List = await json<List>(
        await call(`/v1/suppressions?q=page-${tag}&limit=2${cursor ? `&cursor=${enc(cursor)}` : ""}`, {
          key: ADMIN,
        }),
      )
      expect(page.suppressions.length).toBeLessThanOrEqual(2)
      seen.push(...page.suppressions.map((s) => s.email))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual([...emails].reverse())
    const complaints = await json<List>(
      await call(`/v1/suppressions?q=page-${tag}&reason=complaint&source=events`, { key: ADMIN }),
    )
    expect(complaints.suppressions.map((s) => s.email).sort()).toEqual([emails[1], emails[3]].sort())
  })

  it("removes a suppression only with confirm, and restores the contact", async () => {
    const email = addr("remove")
    await contactWith(email, "unconfirmed")
    await add({ email })
    expect(await contactStatus(email)).toBe("suppressed")
    const unconfirmed = await call(`/v1/suppressions/${enc(email)}`, {
      method: "DELETE",
      key: ADMIN,
      json: {},
    })
    expect(unconfirmed.status).toBe(400)
    expect(await json(unconfirmed)).toMatchObject({ field: "confirm" })

    const res = await call(`/v1/suppressions/${enc(email)}`, {
      method: "DELETE",
      key: ADMIN,
      json: { confirm: true },
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      email,
      removed: true,
      contactStatus: "unconfirmed",
      cloudflare: { state: "not-connected" },
    })
    expect(await row(email)).toBeNull()
    expect(await contactStatus(email)).toBe("unconfirmed")
    const audit = await env.DB.prepare("select action from audit where target = ? order by at")
      .bind(email)
      .all()
    expect(audit.results.map((r) => r.action)).toEqual(["suppression.add", "suppression.remove"])
  })

  it("never clears a complaint for bulk mail, but bulk-only lets transactional mail through", async () => {
    const email = addr("complaint")
    await contactWith(email, "complained")
    await env.DB.prepare(
      "insert into suppressions (email, reason, source, message_id, at) values (?, 'complaint', 'events', 'msg_x', ?)",
    )
      .bind(email, Date.now())
      .run()
    const refused = await call(`/v1/suppressions/${enc(email)}`, {
      method: "DELETE",
      key: ADMIN,
      json: { confirm: true },
    })
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ _tag: "Conflict", reason: "complaint" })

    // Before narrowing, a password reset is refused too.
    const sendTo = () =>
      call("/v1/send", {
        method: "POST",
        key: ADMIN,
        json: { to: email, subject: "Reset", body: "<p>Code</p>", from: "hello@mailyard.test" },
      }).then((r) => json<{ data: { emails: Array<{ status: string }> } }>(r))
    expect((await sendTo()).data.emails[0]?.status).toBe("rejected")

    const patched = await call(`/v1/suppressions/${enc(email)}`, {
      method: "PATCH",
      key: ADMIN,
      json: { bulkOnly: true },
    })
    expect(patched.status).toBe(200)
    expect(await json(patched)).toMatchObject({
      suppression: {
        bulkOnly: true,
        streams: ["campaign", "automation"],
        cloudflare: "not-applicable",
        messageId: "msg_x",
      },
      cloudflare: { state: "not-connected" },
    })
    expect((await sendTo()).data.emails[0]?.status).toBe("sent")

    // Bulk mail is still refused.
    const bulk = await runtimeFor(env).runPromise(
      sendBulkMessage({
        stream: "campaign",
        message: {
          from: { email: "news@mailyard.test" },
          to: [{ email }],
          subject: "News",
          html: "<p>Hi</p>",
        },
        contactId: null,
        campaignId: null,
        idempotencyKey: `bulk-${uid()}`,
      }),
    )
    expect(bulk.status).toBe("rejected")
    // Still not removable once narrowed.
    expect(
      (
        await call(`/v1/suppressions/${enc(email)}`, {
          method: "DELETE",
          key: ADMIN,
          json: { confirm: true },
        })
      ).status,
    ).toBe(409)
  })

  it("treats an unsubscribe as bulk-only and never pushes it", async () => {
    const email = addr("unsub")
    await contactWith(email, "subscribed")
    const body = await json<{ suppression: Suppression }>(await add({ email, reason: "unsubscribe" }))
    expect(body.suppression).toMatchObject({ bulkOnly: true, cloudflare: "not-applicable" })
    expect(await contactStatus(email)).toBe("unsubscribed")
    const push = await call(`/v1/suppressions/${enc(email)}/push`, { method: "POST", key: ADMIN })
    expect(push.status).toBe(409)
    expect(await json(push)).toMatchObject({ reason: "not-applicable" })
    const widen = await call(`/v1/suppressions/${enc(email)}`, {
      method: "PATCH",
      key: ADMIN,
      json: { bulkOnly: false },
    })
    expect(widen.status).toBe(400)
  })

  it("says when Cloudflare's list can't be changed", async () => {
    const email = addr("push")
    await add({ email })
    const res = await call(`/v1/suppressions/${enc(email)}/push`, { method: "POST", key: ADMIN })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ _tag: "CloudflareNotConnected" })
    const sync = await json<{ connected: boolean }>(
      await call("/v1/suppressions/sync", { method: "POST", key: ADMIN }),
    )
    expect(sync.connected).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Against a fake of Cloudflare's suppression API, shaped as measured on 2026-10-17.
// ---------------------------------------------------------------------------------------------

type Entry = {
  id: string
  email: string
  reason: string
  expires_at: string | null
  read_only: boolean
  scope: { type: string; value?: string }
}
const cloudflare = { entries: new Map<string, Entry>(), calls: [] as Array<string>, refuseCreate: false }
const ACCOUNT = "acct-test"
const BASE = `/client/v4/accounts/${ACCOUNT}/email/sending/suppressions`

const installCloudflareFake = () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname !== "api.cloudflare.com" || !url.pathname.startsWith(BASE)) return realFetch(input, init)
    if (request.headers.get("authorization") !== "Bearer cf-token")
      return Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 })
    const rest = url.pathname.slice(BASE.length)
    cloudflare.calls.push(`${request.method} ${rest || "/"}`)
    if (request.method === "GET" && !rest) {
      const email = url.searchParams.get("email")
      const all = [...cloudflare.entries.values()].filter((e) => !email || e.email === email)
      const per = Number(url.searchParams.get("per_page") ?? 100)
      const from = Number(url.searchParams.get("cursor") ?? 0)
      const page = all.slice(from, from + per)
      return Response.json({
        success: true,
        result: page,
        result_info: {
          count: page.length,
          per_page: per,
          next_cursor: from + per < all.length ? String(from + per) : null,
        },
      })
    }
    if (request.method === "POST" && !rest) {
      if (cloudflare.refuseCreate)
        return Response.json({ success: false, errors: [{ message: "Invalid email" }] }, { status: 400 })
      const body = (await request.json()) as { email: string }
      const id = crypto.randomUUID()
      cloudflare.entries.set(id, {
        id,
        email: body.email,
        reason: "manual",
        expires_at: null,
        read_only: false,
        scope: { type: "account" },
      })
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { id, scope: { type: "account" } },
      })
    }
    if (request.method === "POST" && rest === "/bulk") {
      const body = (await request.json()) as { items: Array<{ email: string }> }
      const items = body.items.map((item, index) => {
        const id = crypto.randomUUID()
        cloudflare.entries.set(id, {
          id,
          email: item.email,
          reason: "manual",
          expires_at: null,
          read_only: false,
          scope: { type: "account" },
        })
        return { index, email: item.email, status: "processed", id }
      })
      return Response.json({ success: true, result: { items, deduplicated: 0, invalid: 0, errors: 0 } })
    }
    if (request.method === "DELETE") {
      const id = rest.slice(1)
      const entry = cloudflare.entries.get(id)
      if (!entry)
        return Response.json({ success: false, errors: [{ message: "Not found" }] }, { status: 404 })
      if (entry.read_only)
        return Response.json(
          { success: false, errors: [{ message: "This suppression is read-only." }] },
          { status: 403 },
        )
      cloudflare.entries.delete(id)
      return Response.json({ success: true, result: null })
    }
    return Response.json({ success: false }, { status: 405 })
  }) as typeof fetch
}

const cfEntry = (email: string, extra: Partial<Entry> = {}) => {
  const id = crypto.randomUUID()
  cloudflare.entries.set(id, {
    id,
    email,
    reason: "hard_bounce",
    expires_at: null,
    read_only: false,
    scope: { type: "sending_domain", value: "mailyard.test" },
    ...extra,
  })
  return id
}

describe("with Cloudflare's list connected", () => {
  installCloudflareFake()
  const connected = {
    ...env,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_EMAIL_WRITE_TOKEN: "cf-token",
  } as Env
  // biome-ignore lint/suspicious/noExplicitAny: the app's services, provided by the runtime.
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    runtimeFor(connected).runPromise(effect as never) as Promise<A>

  it("pushes an address, and finds one Cloudflare already holds", async () => {
    const email = addr("cfpush")
    await run(addSuppression({ email }, "test"))
    const pushed = await run(pushSuppression(email, "test"))
    expect(pushed.cloudflare.state).toBe("pushed")
    expect(pushed.suppression.cloudflare).toBe("in-sync")
    expect([...cloudflare.entries.values()].some((e) => e.email === email)).toBe(true)
    // Again: Cloudflare already has it, so nothing new is created.
    const before = cloudflare.entries.size
    expect((await run(pushSuppression(email, "test"))).cloudflare.state).toBe("already-listed")
    expect(cloudflare.entries.size).toBe(before)

    // add with push does both at once.
    const other = addr("cfadd")
    const added = await run(addSuppression({ email: other, push: true }, "test"))
    expect(added.cloudflare).toMatchObject({ state: "pushed" })
    expect(added.suppression.cloudflare).toBe("in-sync")
  })

  it("reports Cloudflare refusing a push", async () => {
    const email = addr("cfrefuse")
    await run(addSuppression({ email }, "test"))
    cloudflare.refuseCreate = true
    try {
      const error = await run(Effect.flip(pushSuppression(email, "test")))
      expect(error).toMatchObject({
        _tag: "CloudflareUnavailable",
        reason: "refused",
        status: 400,
        message: "Invalid email",
      })
    } finally {
      cloudflare.refuseCreate = false
    }
  })

  it("removes Cloudflare's entries with the suppression, except read-only ones", async () => {
    const email = addr("cfremove")
    await contactWith(email, "bounced")
    await env.DB.prepare(
      "insert into suppressions (email, reason, source, at) values (?, 'hard_bounce', 'events', ?)",
    )
      .bind(email, Date.now())
      .run()
    cfEntry(email)
    cfEntry(email, { scope: { type: "account" }, reason: "manual" })
    const done = await run(removeSuppression(email, { confirm: true }, "test"))
    expect(done.cloudflare.state).toBe("removed")
    // Rows from before HAL-3372 have no prior status: a bounced contact goes back to subscribed.
    expect(done.contactStatus).toBe("subscribed")
    expect([...cloudflare.entries.values()].filter((e) => e.email === email)).toEqual([])

    const locked = addr("cflocked")
    await run(addSuppression({ email: locked }, "test"))
    cfEntry(locked, { read_only: true })
    expect((await run(removeSuppression(locked, { confirm: true }, "test"))).cloudflare.state).toBe(
      "read-only",
    )
  })

  it("syncs: marks rows in step or missing, adopts permanent entries, leaves temporary ones", async () => {
    const inSync = addr("sync-in")
    const missing = addr("sync-missing")
    const adopted = addr("sync-adopt")
    const temporary = addr("sync-temp")
    await run(addSuppression({ email: inSync }, "test"))
    await run(addSuppression({ email: missing }, "test"))
    cfEntry(inSync)
    cfEntry(adopted, { reason: "complaint", scope: { type: "account" } })
    cfEntry(temporary, { reason: "soft_bounce", expires_at: "2099-01-01T00:00:00Z" })
    await contactWith(adopted, "subscribed")

    const report = await run(syncWithCloudflare())
    expect(report).toMatchObject({ connected: true, complete: true, error: null })
    expect((report as { adopted: number }).adopted).toBeGreaterThanOrEqual(1)

    expect((await run(getSuppression(inSync))).cloudflare).toBe("in-sync")
    expect((await run(getSuppression(missing))).cloudflare).toBe("missing")
    const adoptedRow = await run(getSuppression(adopted))
    expect(adoptedRow).toMatchObject({ reason: "complaint", source: "cloudflare", cloudflare: "in-sync" })
    expect(adoptedRow.cloudflareEntries?.[0]).toMatchObject({
      reason: "complaint",
      scope: "account",
      readOnly: false,
    })
    expect(await contactStatus(adopted)).toBe("complained")
    expect(await row(temporary)).toBeNull()

    // The list shows when it last synced.
    const list = await run(listSuppressions({ q: "sync-", cloudflare: "missing" }))
    expect(list.suppressions.map((s) => s.email)).toContain(missing)
    expect(list.cloudflare).toMatchObject({ readable: true, writable: true })
    expect(list.cloudflare.checkedAt).not.toBeNull()
  })

  it("narrowing to bulk-only takes the address off Cloudflare's list", async () => {
    const email = addr("cfnarrow")
    await run(addSuppression({ email, push: true }, "test"))
    const narrowed = await run(updateSuppression(email, { bulkOnly: true }, "test"))
    expect(narrowed.cloudflare?.state).toBe("removed")
    expect(narrowed.suppression.cloudflare).toBe("not-applicable")
  })

  it("imports a suppression CSV in steps, mapping other providers' reasons, and pushes", async () => {
    const tag = uid()
    const existing = `imp-${tag}-existing@example.net`
    await run(addSuppression({ email: existing, reason: "complaint" }, "test"))
    const contact = `imp-${tag}-contact@example.net`
    await contactWith(contact, "subscribed")
    const csv = [
      "Address,Why,Comment",
      `imp-${tag}-a@example.net,bounced,from Plunk`,
      `imp-${tag}-b@example.net,spam,`,
      `${contact},unsubscribed,`,
      `${existing},bounced,`,
      `IMP-${tag}-A@example.net,complaint,dup`,
      "not-an-address,bounced,",
      `imp-${tag}-c@example.net,mystery,`,
      `imp-${tag}-d@example.net,,`,
    ].join("\n")
    const up = await call("/v1/uploads?filename=suppressions.csv", {
      method: "POST",
      key: ADMIN,
      body: csv,
      headers: { "content-type": "text/csv" },
    })
    const uploadId = (await json<{ id: string }>(up)).id
    const id = `sim_${uid()}${uid()}`
    await env.DB.prepare(
      "insert into suppression_imports (id, upload_id, reason, email_column, reason_column, note_column, push, created_by) values (?, ?, 'manual', ?, 'Why', 'Comment', 1, 'test')",
    )
      .bind(id, uploadId, "Address")
      .run()
    const start = await run(startImport(id))
    expect(start.failed).toBe(false)
    const first = await run(importChunk(id, start.offset))
    // A retried step changes nothing.
    await run(importChunk(id, start.offset))
    expect(first.done).toBe(true)
    const view = await env.DB.prepare("select * from suppression_imports where id = ?")
      .bind(id)
      .first<Record<string, number | string>>()
    expect(view).toMatchObject({ rows: 8, added: 4, existing: 1, invalid: 2, duplicates: 1, pushed: 3 })
    expect(String(view?.errors)).toContain("Unknown reason")

    expect((await row(`imp-${tag}-a@example.net`))?.reason).toBe("complaint")
    expect((await row(`imp-${tag}-b@example.net`))?.reason).toBe("complaint")
    expect((await row(`imp-${tag}-d@example.net`))?.reason).toBe("manual")
    expect((await row(existing))?.reason).toBe("complaint")
    expect(await row(contact)).toMatchObject({
      reason: "unsubscribe",
      bulk_only: 1,
      contact_status_before: "subscribed",
    })
    expect(await contactStatus(contact)).toBe("unsubscribed")
    expect((await row(`imp-${tag}-a@example.net`))?.cloudflare_id).toBeTruthy()
  })
})

describe("the suppression import API", () => {
  it("starts an import through its Workflow and reads it back", async () => {
    const tag = uid()
    const up = await call("/v1/uploads?filename=s.csv", {
      method: "POST",
      key: ADMIN,
      body: `email\nwf-${tag}-1@example.net\nwf-${tag}-2@example.net\n`,
      headers: { "content-type": "text/csv" },
    })
    const uploadId = (await json<{ id: string }>(up)).id
    expect(
      (await call("/v1/suppressions/import", { method: "POST", key: ADMIN, json: { uploadId, push: true } }))
        .status,
    ).toBe(400)
    const res = await call("/v1/suppressions/import", {
      method: "POST",
      key: ADMIN,
      json: { uploadId, reason: "hard_bounce", note: "Old provider" },
    })
    expect(res.status).toBe(200)
    const { id } = await json<{ id: string }>(res)
    const deadline = Date.now() + 60_000
    let view: { status: string; added: number } = { status: "queued", added: 0 }
    while (view.status !== "completed" && view.status !== "failed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      view = await json(await call(`/v1/suppressions/imports/${id}`, { key: ADMIN }))
    }
    expect(view).toMatchObject({ status: "completed", added: 2 })
    expect(await row(`wf-${tag}-1@example.net`)).toMatchObject({
      reason: "hard_bounce",
      source: "import",
      note: "Old provider",
    })
    const list = await json<{ imports: Array<{ id: string }> }>(
      await call("/v1/suppressions/imports", { key: ADMIN }),
    )
    expect(list.imports.some((i) => i.id === id)).toBe(true)
    expect(
      (await call("/v1/suppressions/import", { method: "POST", key: ADMIN, json: { uploadId: "upl_nope" } }))
        .status,
    ).toBe(404)
  })

  it("maps other providers' words for a reason", () => {
    expect(reasonOf("Bounced")).toBe("hard_bounce")
    expect(reasonOf("SPAM")).toBe("complaint")
    expect(reasonOf("opt-out")).toBe("unsubscribe")
    expect(reasonOf("hard  bounce")).toBe("hard_bounce")
    expect(reasonOf("whatever")).toBeUndefined()
  })
})

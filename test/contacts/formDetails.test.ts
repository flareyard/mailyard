import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Env } from "../../src/Bindings.ts"
import { getForm } from "../../src/domain/forms.ts"
import { runtimeFor } from "../../src/workers/inbound.ts"
import { ADMIN, call, json } from "../helpers.ts"

/** HAL-3424: field definitions, visitor-picked topics, submission stats, Turnstile settings, the iframe. */
const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

const topic = async (name: string) =>
  (await json<{ id: string }>(await admin("/v1/topics", "POST", { name, doubleOptIn: false }))).id

type Form = {
  id: string
  fields: Array<string>
  fieldDefs: Array<{ key: string; label: string; type: string; required: boolean; options?: Array<string> }>
  topicChoice: string
  turnstile: { enabled: boolean; siteKey: string | null; configured: boolean }
}

const submit = (formId: string, body: Record<string, unknown>) =>
  call(`/v1/forms/${formId}/submit`, { method: "POST", json: body, headers: { accept: "application/json" } })

describe("form field definitions (HAL-3424)", () => {
  it("asks each field as defined, and checks it on submit", async () => {
    const t = await topic(`Defs ${uid()}`)
    const form = await json<Form>(
      await admin("/v1/forms", "POST", {
        name: "Join",
        topicIds: [t],
        fieldDefs: [
          { key: "first_name", required: true },
          { key: "seats", type: "number" },
          { key: "plan", type: "select", options: ["Free", "Pro"], required: true },
          { key: "terms", type: "checkbox", label: "I agree to the terms", required: true },
          { key: "birthday", type: "date" },
        ],
      }),
    )
    expect(form.fields).toEqual(["first_name", "seats", "plan", "terms", "birthday"])
    expect(form.fieldDefs[0]).toEqual({
      key: "first_name",
      label: "First name",
      type: "text",
      required: true,
    })
    expect(form.fieldDefs[2]).toMatchObject({ type: "select", options: ["Free", "Pro"] })

    const page = await (await call(`/f/${form.id}`)).text()
    expect(page).toContain('name="first_name" type="text"')
    expect(page).toContain("<select")
    expect(page).toContain('name="terms" type="checkbox"')
    expect(page).toContain('type="date"')

    const email = `defs-${uid()}@example.net`
    const missing = await submit(form.id, { email, plan: "Pro", terms: "true" })
    expect(missing.status).toBe(400)
    expect(await json<{ field: string }>(missing)).toMatchObject({ field: "first_name" })
    const badSelect = await submit(form.id, { email, first_name: "Ada", plan: "Gold", terms: "true" })
    expect(await json<{ field: string }>(badSelect)).toMatchObject({ field: "plan" })
    const noTerms = await submit(form.id, { email, first_name: "Ada", plan: "Pro" })
    expect(await json<{ field: string }>(noTerms)).toMatchObject({ field: "terms" })
    const badNumber = await submit(form.id, {
      email,
      first_name: "Ada",
      plan: "Pro",
      terms: "on",
      seats: "many",
    })
    expect(await json<{ field: string }>(badNumber)).toMatchObject({ field: "seats" })

    const ok = await submit(form.id, { email, first_name: "Ada", plan: "Pro", terms: "on", seats: "3" })
    expect(ok.status).toBe(200)
    const contact = await env.DB.prepare("select fields from contacts where email = ?")
      .bind(email)
      .first<{ fields: string }>()
    expect(JSON.parse(contact?.fields ?? "{}")).toMatchObject({
      first_name: "Ada",
      plan: "Pro",
      terms: true,
      seats: 3,
    })
  })

  it("keeps forms with plain field lists working as optional text", async () => {
    const t = await topic(`Plain ${uid()}`)
    const form = await json<Form>(
      await admin("/v1/forms", "POST", { name: "Plain", topicIds: [t], fields: ["company"] }),
    )
    expect(form.fieldDefs).toEqual([{ key: "company", label: "Company", type: "text", required: false }])
    expect((await submit(form.id, { email: `plain-${uid()}@example.net` })).status).toBe(200)
  })
})

describe("visitor-picked topics (HAL-3424)", () => {
  it("joins only the topics ticked, and needs at least one", async () => {
    const a = await topic(`News ${uid()}`)
    const b = await topic(`Offers ${uid()}`)
    const form = await json<Form>(
      await admin("/v1/forms", "POST", { name: "Pick", topicIds: [a, b], topicChoice: "pick" }),
    )
    expect(form.topicChoice).toBe("pick")
    const page = await (await call(`/f/${form.id}`)).text()
    expect(page).toContain(`name="topics" type="checkbox" value="${a}"`)

    const email = `pick-${uid()}@example.net`
    const none = await submit(form.id, { email })
    expect(await json<{ field: string }>(none)).toMatchObject({ field: "topics" })
    // A topic the form doesn't offer is ignored.
    expect((await submit(form.id, { email, topics: [b, "tp_other"] })).status).toBe(200)
    const subs = await env.DB.prepare(
      "select s.topic_id from subscriptions s join contacts c on c.id = s.contact_id where c.email = ?",
    )
      .bind(email)
      .all<{ topic_id: string }>()
    expect(subs.results.map((r) => r.topic_id)).toEqual([b])

    // As a browser posts it: a repeated form field.
    const browser = new URLSearchParams()
    browser.set("email", `pick2-${uid()}@example.net`)
    browser.append("topics", a)
    browser.append("topics", b)
    const res = await call(`/v1/forms/${form.id}/submit`, {
      method: "POST",
      body: browser,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    })
    expect(res.status).toBe(200)
  })
})

describe("form stats, Turnstile settings and the iframe (HAL-3424)", () => {
  it("counts submissions by outcome per day", async () => {
    const t = await topic(`Stats ${uid()}`)
    const form = await json<Form>(
      await admin("/v1/forms", "POST", {
        name: "Stats",
        topicIds: [t],
        fieldDefs: [{ key: "first_name", required: true }],
      }),
    )
    await submit(form.id, { email: `s1-${uid()}@example.net`, first_name: "A" })
    await submit(form.id, { email: `s2-${uid()}@example.net`, first_name: "B" })
    await submit(form.id, { email: `s3-${uid()}@example.net` })
    await submit(form.id, { email: "not-an-address" })
    const stats = await json<{
      submissions: number
      subscribed: number
      refused: number
      days: Array<{ day: string; submissions: number }>
    }>(await admin(`/v1/forms/${form.id}/stats?range=7d`))
    expect(stats).toMatchObject({ submissions: 4, subscribed: 2, refused: 2 })
    expect(stats.days).toHaveLength(7)
    expect(stats.days.at(-1)?.submissions).toBe(4)
    expect((await admin("/v1/forms/frm_none/stats")).status).toBe(404)
  })

  it("says whether Turnstile is on and whether the deploy can check it", async () => {
    const t = await topic(`TS ${uid()}`)
    const form = await json<Form>(
      await admin("/v1/forms", "POST", { name: "TS", topicIds: [t], turnstileSiteKey: "0x4AAAAAAAtestkey" }),
    )
    expect(form.turnstile).toEqual({ enabled: true, siteKey: "0x4AAAAAAAtestkey", configured: false })
    const withSecret = await runtimeFor({ ...env, TURNSTILE_SECRET: "s" } as Env).runPromise(getForm(form.id))
    expect(withSecret.turnstile.configured).toBe(true)
  })

  it("gives an iframe snippet beside the fetch one", async () => {
    const t = await topic(`Embed ${uid()}`)
    const form = await json<Form>(
      await admin("/v1/forms", "POST", { name: "Embed", topicIds: [t], topicChoice: "pick" }),
    )
    const embed = await json<{ pageUrl: string; html: string; iframe: string }>(
      await admin(`/v1/forms/${form.id}/embed`),
    )
    expect(embed.iframe).toContain(`<iframe src="${embed.pageUrl}"`)
    expect(embed.html).toContain(`name="topics" type="checkbox" value="${t}"`)
  })
})

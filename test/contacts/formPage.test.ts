import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Env } from "../../src/Bindings.ts"
import { labelOf } from "../../src/forms/page.ts"
import worker from "../../src/workers/api.ts"
import { ADMIN, call, json } from "../helpers.ts"

const uid = () => crypto.randomUUID().slice(0, 8)

const topic = async (name: string, description: string | null) =>
  (
    await json<{ id: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name, description, doubleOptIn: false },
      }),
    )
  ).id

const form = async (extra: Record<string, unknown> = {}) => {
  const t1 = await topic(`Weekly notes ${uid()}`, "One email every Friday.")
  const t2 = await topic(`Launches ${uid()}`, null)
  const res = await call("/v1/forms", {
    method: "POST",
    key: ADMIN,
    json: {
      name: "Join the list",
      topicIds: [t1, t2],
      fields: ["first_name", "company", "favourite_colour"],
      description: "Short, useful, <b>never</b> spam.",
      ...extra,
    },
  })
  if (res.status !== 200) throw new Error(`form: ${await res.text()}`)
  return json<{ id: string; turnstileSiteKey: string | null }>(res)
}

/** The Worker with extra bindings, as a deploy with TURNSTILE_SECRET set would run it. */
const withSecret = async (request: Request) => {
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    request as Parameters<typeof worker.fetch>[0],
    { ...env, TURNSTILE_SECRET: "test-secret" } as Env,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}

describe("GET /f/:formId", () => {
  it("serves an accessible signup page with the form's fields and topics", async () => {
    const f = await form()
    const res = await call(`/f/${f.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const csp = res.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("form-action 'self'")
    const html = await res.text()
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(html).toContain('<html lang="en">')
    expect(html).toContain(`action="/v1/forms/${f.id}/submit"`)
    // Every input has a label tied to it, and autofill hints where the name says what it holds.
    expect(html).toMatch(
      /<label for="f-email">Email<\/label>\s*<input id="f-email" name="email" type="email" autocomplete="email" required/,
    )
    expect(html).toContain('<label for="f-first_name">First name <span class="opt">(optional)</span></label>')
    expect(html).toContain('autocomplete="given-name"')
    expect(html).toContain('autocomplete="organization"')
    expect(html).toContain("Favourite colour")
    // Topics with their descriptions; the description is escaped, not rendered.
    expect(html).toContain("You'll get all of these")
    expect(html).toContain("<span>One email every Friday.</span>")
    expect(html).toContain("Short, useful, &lt;b&gt;never&lt;/b&gt; spam.")
    // 16px inputs (no iOS zoom), 44px targets, a hidden honeypot, and no Turnstile without a site key.
    expect(html).toContain("font-size:16px")
    expect(html).toContain("min-height:44px")
    expect(html).toContain('name="_hp"')
    expect(html).not.toContain("challenges.cloudflare.com")

    expect((await call(`/f/${f.id}`, { method: "HEAD" })).status).toBe(200)
    expect((await call("/f/frm_nope")).status).toBe(404)
    await call(`/v1/forms/${f.id}`, { method: "PATCH", key: ADMIN, json: { archived: true } })
    expect((await call(`/f/${f.id}`)).status).toBe(404)
  })

  it("posts from the page without JavaScript and lands on a result page", async () => {
    const f = await form()
    const res = await call(`/v1/forms/${f.id}/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({
        email: `page-${uid()}@example.net`,
        first_name: "Ada",
        _hp: "",
      }).toString(),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("You're subscribed")
  })

  it("labels custom fields readably", () => {
    expect(labelOf("first_name")).toBe("First name")
    expect(labelOf("favouriteColour")).toBe("Favourite colour")
    expect(labelOf("plan")).toBe("Plan")
  })
})

describe("GET /v1/forms/:id/embed", () => {
  it("returns the page's address and a snippet that posts to submit, with Turnstile when set", async () => {
    const plain = await form()
    const a = await json<{ pageUrl: string; html: string }>(
      await call(`/v1/forms/${plain.id}/embed`, { key: ADMIN }),
    )
    expect(a.pageUrl).toBe(`https://mailyard.test/f/${plain.id}`)
    expect(a.html).toContain(`action="https://mailyard.test/v1/forms/${plain.id}/submit"`)
    expect(a.html).toContain('name="email" type="email" autocomplete="email" required')
    expect(a.html).toContain('name="company"')
    expect(a.html).toContain("fetch(form.action")
    expect(a.html).not.toContain("cf-turnstile")

    const guarded = await form({ turnstileSiteKey: "0x4AAAAAAAtestkey" })
    const b = await json<{ html: string }>(await call(`/v1/forms/${guarded.id}/embed`, { key: ADMIN }))
    expect(b.html).toContain('data-sitekey="0x4AAAAAAAtestkey"')
    expect(b.html).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js")
    const page = await (await call(`/f/${guarded.id}`)).text()
    expect(page).toContain('class="cf-turnstile" data-sitekey="0x4AAAAAAAtestkey"')

    expect((await call("/v1/forms/frm_nope/embed", { key: ADMIN })).status).toBe(404)
    expect(
      (
        await call("/v1/forms", {
          method: "POST",
          key: ADMIN,
          json: { name: "x", topicIds: [], turnstileSiteKey: "no spaces!" },
        })
      ).status,
    ).toBe(400)
    // The submit endpoint answers a browser's preflight from any site.
    const preflight = await call(`/v1/forms/${plain.id}/submit`, { method: "OPTIONS" })
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
  })
})

describe("Turnstile on submit", () => {
  const siteverify = (pass: ReadonlySet<string>) => {
    const realFetch = globalThis.fetch
    const seen: Array<URLSearchParams> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url !== "https://challenges.cloudflare.com/turnstile/v0/siteverify")
        return realFetch(input, init)
      const body = new URLSearchParams(await request.text())
      seen.push(body)
      const ok = pass.has(body.get("response") ?? "")
      return Response.json({ success: ok, "error-codes": ok ? [] : ["invalid-input-response"] })
    }) as typeof fetch
    return { seen, restore: () => (globalThis.fetch = realFetch) }
  }
  const submit = (formId: string, body: Record<string, unknown>) =>
    withSecret(
      new Request(`https://mailyard.test/v1/forms/${formId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify(body),
      }),
    )
  const exists = async (email: string) =>
    (await env.DB.prepare("select 1 as x from contacts where email = ?").bind(email).first()) !== null

  it("verifies the token before writing, and refuses a failed, missing or unverifiable one", async () => {
    const f = await form({ turnstileSiteKey: "0x4AAAAAAAtestkey" })
    const mock = siteverify(new Set(["good-token"]))
    try {
      const good = `ts-good-${uid()}@example.net`
      const passed = await submit(f.id, { email: good, "cf-turnstile-response": "good-token" })
      expect(passed.status).toBe(200)
      expect(await exists(good)).toBe(true)
      expect(mock.seen[0]?.get("secret")).toBe("test-secret")
      expect(mock.seen[0]?.get("remoteip")).toBe("203.0.113.9")

      const bad = `ts-bad-${uid()}@example.net`
      const refused = await submit(f.id, { email: bad, "cf-turnstile-response": "forged" })
      expect(refused.status).toBe(400)
      expect(await json(refused)).toMatchObject({ error: "challenge" })
      expect(await exists(bad)).toBe(false)

      const none = `ts-none-${uid()}@example.net`
      expect((await submit(f.id, { email: none })).status).toBe(400)
      expect(await exists(none)).toBe(false)
      // The token is never kept as a custom field.
      const row = await env.DB.prepare("select fields from contacts where email = ?")
        .bind(good)
        .first<{ fields: string }>()
      expect(JSON.parse(row?.fields ?? "{}")).not.toHaveProperty("cf-turnstile-response")
    } finally {
      mock.restore()
    }
    // Cloudflare unreachable: refused, not let through.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      new Request(input, init).url.startsWith("https://challenges.cloudflare.com")
        ? Promise.reject(new Error("down"))
        : realFetch(input, init)) as typeof fetch
    try {
      expect(
        (await submit(f.id, { email: `ts-down-${uid()}@example.net`, "cf-turnstile-response": "good-token" }))
          .status,
      ).toBe(400)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("doesn't call Turnstile for a form without a site key", async () => {
    const f = await form()
    const mock = siteverify(new Set())
    try {
      expect((await submit(f.id, { email: `ts-off-${uid()}@example.net` })).status).toBe(200)
      expect(mock.seen).toHaveLength(0)
    } finally {
      mock.restore()
    }
  })
})

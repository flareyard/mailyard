import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { signConsent } from "../../src/domain/consent.ts"
import { unsubscribeHeaders } from "../../src/domain/unsubscribe.ts"
import { runtimeFor } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"
import { sendTracked } from "../tracking/sendTracked.ts"

/** HAL-3377: the pages people reach from an email, in the sender's look or Flareyard's. */
installDohFixture()

// Link checks reach the network; here every outside host answers 200 (DNS goes on to its fixture).
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = new URL(new Request(input, init).url).hostname
  return host === "cloudflare-dns.com" ? realFetch(input, init) : new Response(null, { status: 200 })
}) as typeof fetch

const uid = () => crypto.randomUUID().slice(0, 8)
const run = <A>(effect: Parameters<ReturnType<typeof runtimeFor>["runPromise"]>[0]) =>
  runtimeFor(env).runPromise(effect) as Promise<A>

const setup = async () => {
  const contact = await json<{ id: string; email: string }>(
    await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: `p-${uid()}@example.net` } }),
  )
  const topics: Array<{ id: string; name: string }> = []
  for (const name of [`News ${uid()}`, `Offers ${uid()}`]) {
    const topic = await json<{ id: string; name: string }>(
      await call("/v1/topics", { method: "POST", key: ADMIN, json: { name, doubleOptIn: false } }),
    )
    await call(`/v1/contacts/${contact.id}/topics/${topic.id}`, {
      method: "PUT",
      key: ADMIN,
      json: { state: "subscribed" },
    })
    topics.push(topic)
  }
  return { contact, topics }
}

const prefsPath = async (contactId: string, topicId: string | null) => {
  const { url } = await run<{ url: string }>(
    unsubscribeHeaders({
      contactId,
      topicId,
      campaignId: null,
      origin: "https://mailyard.test",
      mailDomain: "news.mailyard.test",
    }),
  )
  return new URL(url).pathname
}

const post = (path: string, fields: Record<string, string>) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: new URLSearchParams(fields).toString(),
  })

const setCompliance = (body: Record<string, unknown>) =>
  call("/v1/settings/compliance", {
    method: "PUT",
    key: ADMIN,
    json: { postalAddress: null, linkAllowlist: [], seedAddresses: [], ...body },
  })

describe("the preference page (/u)", () => {
  it("wears Flareyard's look by default, light and dark, with the compliance footer", async () => {
    await env.DB.prepare("delete from settings where key = 'brand'").run()
    await setCompliance({ postalAddress: "1 Yard Lane, Lagos", privacyUrl: "https://example.org/privacy" })
    const { contact, topics } = await setup()
    const res = await call(await prefsPath(contact.id, topics[0]?.id ?? null))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("family=Funnel+Display")
    expect(html).toContain('"Funnel Display"')
    expect(html).toContain("--accent:#171717")
    expect(html).toMatch(/@media \(prefers-color-scheme:dark\)\{:root\{--bg:#000000/)
    // The list the email came from: tagged, and named in the line above the form.
    expect(html).toMatch(new RegExp(`${topics[0]?.name}<span class="tag">From this email</span>`))
    expect(html).toContain(`This email came from <strong>${topics[0]?.name}</strong>`)
    expect(html).toContain(
      '<footer><span>1 Yard Lane, Lagos</span><a href="https://example.org/privacy">Privacy</a></footer>',
    )
    expect(res.headers.get("content-security-policy")).toContain("https://fonts.googleapis.com")
  })

  it("uses the sender's brand when one is set", async () => {
    await call("/v1/settings/brand", {
      method: "PUT",
      key: ADMIN,
      json: {
        name: "Yard Co",
        siteUrl: "https://yard.example",
        tagline: "Hi",
        colors: { indigo: "#0a7d55" },
        fontsHref: "https://fonts.googleapis.com/css2?family=Inter",
        fonts: { display: "Inter, sans-serif", body: "Inter, sans-serif" },
      },
    })
    const { contact } = await setup()
    const html = await (await call(await prefsPath(contact.id, null))).text()
    expect(html).toContain("Email preferences · Yard Co")
    expect(html).toContain("--accent:#0a7d55")
    expect(html).toContain("--font-body:Inter, sans-serif")
    expect(html).toContain("family=Inter")
    expect(html).not.toContain("Funnel")
    await env.DB.prepare("delete from settings where key = 'brand'").run()
  })

  it("says when someone's unsubscribed from everything, and lets them undo it for a day", async () => {
    const { contact, topics } = await setup()
    const path = await prefsPath(contact.id, null)
    const done = await (await post(path, { action: "all" })).text()
    expect(done).toContain('class="notice success"')
    expect(done).toContain('value="resubscribe"')
    // Reloaded later, the page still says so, and still offers the undo.
    const later = await (await call(path)).text()
    expect(later).toContain("You're unsubscribed from everything")
    expect(later).toContain('value="resubscribe"')

    const back = await (await post(path, { action: "resubscribe" })).text()
    expect(back).toContain("Welcome back")
    const state = await json<{ status: string; topics: Array<{ topicId: string; state: string }> }>(
      await call(`/v1/contacts/${contact.id}`, { key: ADMIN }),
    )
    expect(state.status).toBe("subscribed")
    for (const t of topics) expect(state.topics.find((x) => x.topicId === t.id)?.state).toBe("subscribed")
    // Nothing more to undo once it's undone.
    expect(await (await call(path)).text()).not.toContain('value="resubscribe"')

    // Past the window, the undo is gone and asking for it says to choose topics instead.
    await post(path, { action: "all" })
    await env.DB.prepare(
      "update events set at = at - 90000000 where contact_id = ? and name = 'email.unsubscribed'",
    )
      .bind(contact.id)
      .run()
    expect(await (await call(path)).text()).not.toContain('value="resubscribe"')
    const late = await (await post(path, { action: "resubscribe" })).text()
    expect(late).toContain('class="notice warning"')
  })

  it("offers a fresh link on a bad one, and answers the same whether or not the address is known", async () => {
    const bad = await call("/u/v1.nope.nope")
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('action="/p/request"')

    const { contact, topics } = await setup()
    // The link mail comes from the sender of a list they're on (the test env has no DEFAULT_FROM).
    const domain = `prefs-${uid()}.test`
    setDns(goodDomain(domain))
    await call("/v1/domains", {
      method: "POST",
      key: ADMIN,
      json: { name: domain, sending: true, receiving: false },
    })
    await call(`/v1/topics/${topics[0]?.id}`, {
      method: "PATCH",
      key: ADMIN,
      json: { sender: `News <news@${domain}>` },
    })
    const known = await post("/p/request", { email: contact.email.toUpperCase() })
    const unknown = await post("/p/request", { email: `nobody-${uid()}@example.net` })
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    const strip = (s: string) => s.replace(/<title>.*<\/title>/, "")
    expect(strip(await known.text())).toBe(strip(await unknown.text()))
    const sent = () =>
      env.DB.prepare("select count(*) as n from messages_out where recipient = ? and subject = ?")
        .bind(contact.email, "Your email preferences link")
        .first<{ n: number }>()
    expect((await sent())?.n).toBe(1)
    // A second ask within the hour sends nothing more.
    await post("/p/request", { email: contact.email })
    expect((await sent())?.n).toBe(1)
  })
})

describe("confirm and signup result pages", () => {
  it("brands the confirmation page and follows the form's redirect, without JavaScript", async () => {
    const { contact, topics } = await setup()
    const topicId = topics[0]?.id ?? ""
    const form = await json<{ id: string }>(
      await call("/v1/forms", {
        method: "POST",
        key: ADMIN,
        json: { name: "Join", topicIds: [topicId], redirectUrl: "https://example.org/thanks" },
      }),
    )
    const token = await run<string>(
      signConsent({ kind: "confirm", contactId: contact.id, topicId, formId: form.id, issuedAt: Date.now() }),
    )
    const res = await call(`/c/${encodeURIComponent(token)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("refresh")).toBe("3;url=https://example.org/thanks")
    const html = await res.text()
    expect(html).toContain('<meta http-equiv="refresh" content="3;url=https://example.org/thanks">')
    expect(html).toContain('class="glyph success i-check"')
    expect(html).toContain('href="https://example.org/thanks">Continue</a>')
    // A token from before forms carried their id: still confirms, no redirect.
    const plain = await run<string>(
      signConsent({ kind: "confirm", contactId: contact.id, topicId, issuedAt: Date.now() }),
    )
    const old = await call(`/c/${encodeURIComponent(plain)}`)
    expect(old.status).toBe(200)
    expect(old.headers.get("refresh")).toBeNull()
  })

  it("brands the page a signup lands on", async () => {
    const { topics } = await setup()
    const form = await json<{ id: string }>(
      await call("/v1/forms", {
        method: "POST",
        key: ADMIN,
        json: { name: "Join", topicIds: [topics[0]?.id] },
      }),
    )
    const res = await post(`/v1/forms/${form.id}/submit`, { email: `s-${uid()}@example.net` })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("You're subscribed")
    expect(html).toContain('class="glyph success i-check"')
    expect(html).toContain("Funnel")
  })
})

describe("view in browser (/v)", () => {
  it("links each campaign mail to its own copy, served without the open pixel", async () => {
    const { messages } = await sendTracked(1)
    const m = messages[0]
    if (!m) throw new Error("no message")
    const stored = (await (await env.STORE.get(m.rendered_key))?.json()) as { html: string; text: string }
    const href = /href="(https:\/\/mailyard\.test\/v\/[^"]+)"[^>]*>View this email in your browser/.exec(
      stored.html,
    )?.[1]
    // The tracker leaves it alone, like the unsubscribe link.
    expect(href).toBeTruthy()
    expect(stored.text).toContain("View in your browser: https://mailyard.test/v/")
    const res = await call(new URL(href ?? "").pathname)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'")
    const html = await res.text()
    expect(stored.html).toMatch(/\/t\/o\/[^"]+\.gif/)
    expect(html).not.toMatch(/\/t\/o\//)
    // Everything else is the copy they got: tracked links included.
    expect(html).toContain("/t/c/")
    expect((await call("/v/v1.bad.token")).status).toBe(400)
  }, 90_000)
})

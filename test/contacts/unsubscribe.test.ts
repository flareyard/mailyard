import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { unsubscribeHeaders } from "../../src/domain/unsubscribe.ts"
import { handleEmail, runtimeFor } from "../../src/workers/inbound.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"
import { simpleMessage } from "../inbound/messages.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)

const setup = async () => {
  const contact = await json<{ id: string; email: string }>(
    await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: `u-${uid()}@example.net` } }),
  )
  const topics: Array<{ id: string; name: string }> = []
  for (const name of [`News ${uid()}`, `Offers ${uid()}`]) {
    const topic = await json<{ id: string; name: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name, doubleOptIn: false, description: `About ${name}` },
      }),
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

const headersFor = (contactId: string, topicId: string | null, campaignId: string | null = null) =>
  runtimeFor(env).runPromise(
    unsubscribeHeaders({
      contactId,
      topicId,
      campaignId,
      origin: "https://mailyard.test",
      mailDomain: "news.mailyard.test",
      listName: "News",
    }),
  )

const states = async (contactId: string) =>
  await json<{ status: string; topics: Array<{ topicId: string; state: string }> }>(
    await call(`/v1/contacts/${contactId}`, { key: ADMIN }),
  )

const oneClick = (url: string) =>
  call(new URL(url).pathname, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  })

describe("List-Unsubscribe", () => {
  it("builds RFC 8058 headers with an https link, a mailto and a List-Id", async () => {
    const { contact, topics } = await setup()
    const { headers, url, mailto } = await headersFor(contact.id, topics[0]?.id ?? null, "cmp_x")
    expect(headers["List-Unsubscribe"]).toBe(`<${url}>, <${mailto}>`)
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    expect(headers["List-Id"]).toMatch(/^News <top_[A-Za-z0-9_-]+\.news\.mailyard\.test>$/)
    expect(url.startsWith("https://mailyard.test/u/v1.")).toBe(true)
    expect(mailto.startsWith("mailto:unsubscribe@news.mailyard.test?subject=unsubscribe%3Av1.")).toBe(true)
  })

  it("one-click unsubscribes from the topic the mail was for, and records it for the campaign", async () => {
    const { contact, topics } = await setup()
    const { url } = await headersFor(contact.id, topics[0]?.id ?? null, "cmp_report")
    const response = await oneClick(url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("")
    const after = await states(contact.id)
    expect(after.topics.find((t) => t.topicId === topics[0]?.id)?.state).toBe("unsubscribed")
    expect(after.topics.find((t) => t.topicId === topics[1]?.id)?.state).toBe("subscribed")
    const event = await env.DB.prepare(
      "select data from events where contact_id = ? and name = 'email.unsubscribed'",
    )
      .bind(contact.id)
      .first<{ data: string }>()
    expect(JSON.parse(event?.data ?? "{}")).toMatchObject({ campaignId: "cmp_report", how: "one-click" })
    // A second click changes nothing and still succeeds: providers retry.
    expect((await oneClick(url)).status).toBe(200)
  })

  it("one-click with no topic unsubscribes from everything", async () => {
    const { contact } = await setup()
    const { url } = await headersFor(contact.id, null)
    expect((await oneClick(url)).status).toBe(200)
    const after = await states(contact.id)
    expect(after.status).toBe("unsubscribed")
    expect(after.topics.every((t) => t.state === "unsubscribed")).toBe(true)
  })

  it("refuses a tampered token, and a confirmation token used as an unsubscribe one", async () => {
    const { contact, topics } = await setup()
    const { url } = await headersFor(contact.id, topics[0]?.id ?? null)
    const path = new URL(url).pathname
    expect((await call(`${path.slice(0, -3)}abc`)).status).toBe(400)
    expect(
      (
        await call(`${path.slice(0, -3)}abc`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        })
      ).status,
    ).toBe(400)
    // The same token on the confirmation route isn't accepted either.
    expect((await call(path.replace("/u/", "/c/"))).status).toBe(400)
  })

  it("honours the mailto, and still rejects other mail to that address", async () => {
    const domain = `unsub-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const { contact, topics } = await setup()
    const { mailto } = await headersFor(contact.id, topics[1]?.id ?? null)
    const subject = decodeURIComponent(new URL(mailto).searchParams.get("subject") ?? "")
    const send = (s: string) => {
      const raw = simpleMessage({ to: `unsubscribe@${domain}`, subject: s })
      let rejected: string | null = null
      return handleEmail(
        {
          from: contact.email,
          to: `unsubscribe@${domain}`,
          headers: new Headers(),
          raw: new Blob([raw]).stream(),
          rawSize: raw.byteLength,
          setReject: (r: string) => {
            rejected = r
          },
        } as unknown as ForwardableEmailMessage,
        env,
      ).then((o) => ({ outcome: o?.outcome, rejected }))
    }
    expect(await send(subject)).toMatchObject({ outcome: "consumed", rejected: null })
    expect((await states(contact.id)).topics.find((t) => t.topicId === topics[1]?.id)?.state).toBe(
      "unsubscribed",
    )
    const other = await send("Hello, is anyone there?")
    expect(other.outcome).toBe("rejected")
  })
})

describe("preference page", () => {
  it("shows the person's lists, saves their choices, and unsubscribes from everything", async () => {
    const { contact, topics } = await setup()
    const { url } = await headersFor(contact.id, topics[1]?.id ?? null)
    const path = new URL(url).pathname
    const page = await call(path)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain("Your email preferences")
    expect(html).toContain(topics[0]?.name ?? "")
    expect(html).toContain(`About ${topics[1]?.name}`)
    // The address is partly masked, so a forwarded link doesn't show it whole.
    expect(html).not.toContain(contact.email)
    expect(html).toContain(`${contact.email.slice(0, 2)}•`)
    expect(page.headers.get("cache-control")).toBe("no-store")

    const keepFirst = new URLSearchParams([
      ["action", "save"],
      ["topic", topics[0]?.id ?? ""],
    ])
    const saved = await call(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: keepFirst.toString(),
    })
    expect(await saved.text()).toContain("Your choices are saved.")
    let after = await states(contact.id)
    expect(after.topics.find((t) => t.topicId === topics[0]?.id)?.state).toBe("subscribed")
    expect(after.topics.find((t) => t.topicId === topics[1]?.id)?.state).toBe("unsubscribed")

    const all = await call(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=all",
    })
    expect(await all.text()).toContain("unsubscribed from everything")
    after = await states(contact.id)
    expect(after.status).toBe("unsubscribed")
    expect(after.topics.every((t) => t.state === "unsubscribed")).toBe(true)
  })

  it("hands an app a preference link for its own footers", async () => {
    const { contact } = await setup()
    const { url } = await json<{ url: string }>(
      await call(`/v1/contacts/${contact.id}/preferences-link`, { key: ADMIN }),
    )
    expect(new URL(url).pathname.startsWith("/u/")).toBe(true)
    expect((await call(new URL(url).pathname)).status).toBe(200)
    expect((await call("/v1/contacts/missing/preferences-link", { key: ADMIN })).status).toBe(404)
  })
})

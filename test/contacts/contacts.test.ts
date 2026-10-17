import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { ADMIN, call, createKey, json } from "../helpers.ts"

type Contact = {
  id: string
  email: string
  name: string | null
  status: string
  fields: Record<string, unknown>
  topics: Array<{ topicId: string; name: string; state: string }>
  engagement: string
}
type Page = { contacts: Array<Contact>; total: number; count: number; nextCursor: string | null }
type Topic = { id: string; name: string; doubleOptIn: boolean; subscribers: number }

const uid = () => crypto.randomUUID().slice(0, 8)

const createContact = async (body: Record<string, unknown>) => {
  const response = await call("/v1/contacts", { method: "POST", key: ADMIN, json: body })
  if (response.status !== 200) throw new Error(`create contact: ${response.status} ${await response.text()}`)
  return json<Contact>(response)
}

const createTopic = async (name: string, doubleOptIn: boolean) => {
  const response = await call("/v1/topics", {
    method: "POST",
    key: ADMIN,
    json: { name, doubleOptIn, sender: "Lists <lists@mailyard.test>" },
  })
  if (response.status !== 200) throw new Error(`create topic: ${response.status} ${await response.text()}`)
  return json<Topic>(response)
}

/** The rendered copy of the newest message to `to`, as the in-memory sender stored it. */
const lastMessageTo = async (to: string) => {
  const row = await env.DB.prepare(
    "select id, subject, rendered_key, status from messages_out where recipient = ? order by created_at desc limit 1",
  )
    .bind(to)
    .first<{ id: string; subject: string; rendered_key: string | null; status: string }>()
  if (!row?.rendered_key) return null
  const rendered = (await (await env.STORE.get(row.rendered_key))?.json()) as { html: string }
  return { ...row, html: rendered.html }
}

const confirmLink = (html: string) => {
  const match = /href="(https?:\/\/[^"]+\/c\/[^"]+)"/.exec(html)
  if (!match?.[1]) throw new Error("no confirmation link")
  return match[1].replaceAll("&amp;", "&")
}

describe("contacts API", () => {
  it("creates, reads, updates and refuses duplicates and bad input", async () => {
    const email = `ada-${uid()}@Example.net`
    const created = await createContact({
      email,
      name: "Ada",
      fields: { plan: "pro", seats: 3 },
      status: "subscribed",
    })
    expect(created).toMatchObject({
      email: email.toLowerCase(),
      name: "Ada",
      status: "subscribed",
      engagement: "dormant",
    })

    const duplicate = await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email } })
    expect(duplicate.status).toBe(409)
    const bad = await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: "not-an-email" } })
    expect(bad.status).toBe(400)
    const badField = await call("/v1/contacts", {
      method: "POST",
      key: ADMIN,
      json: { email: `x-${uid()}@example.net`, fields: { "bad key": 1 } },
    })
    expect(badField.status).toBe(400)

    const patched = await json<Contact>(
      await call(`/v1/contacts/${created.id}`, {
        method: "PATCH",
        key: ADMIN,
        json: { fields: { seats: null, team: "core" }, name: "Ada L." },
      }),
    )
    expect(patched.fields).toEqual({ plan: "pro", team: "core" })
    expect(patched.name).toBe("Ada L.")

    const got = await json<Contact>(await call(`/v1/contacts/${created.id}`, { key: ADMIN }))
    expect(got.id).toBe(created.id)
    expect((await call("/v1/contacts/nope", { key: ADMIN })).status).toBe(404)
  })

  it("keeps a suppressed address suppressed and refuses to resubscribe it", async () => {
    const email = `bounced-${uid()}@example.net`
    await env.DB.prepare(
      "insert into suppressions (email, reason, source, at) values (?, 'hard_bounce', 'events', ?)",
    )
      .bind(email, Date.now())
      .run()
    const created = await createContact({ email, status: "subscribed" })
    expect(created.status).toBe("suppressed")
    const response = await call(`/v1/contacts/${created.id}`, {
      method: "PATCH",
      key: ADMIN,
      json: { status: "subscribed" },
    })
    expect(response.status).toBe(400)
  })

  it("filters, sorts and pages with totals", async () => {
    const tag = uid()
    const topic = await createTopic(`List ${tag}`, false)
    const made: Array<Contact> = []
    for (let i = 0; i < 5; i++) {
      made.push(
        await createContact({
          email: `p${i}-${tag}@example.net`,
          name: `Person ${i} ${tag}`,
          status: i % 2 ? "subscribed" : "unsubscribed",
        }),
      )
    }
    for (const c of made.slice(0, 3)) {
      await call(`/v1/contacts/${c.id}/topics/${topic.id}`, {
        method: "PUT",
        key: ADMIN,
        json: { state: "subscribed" },
      })
    }
    const byQuery = await json<Page>(await call(`/v1/contacts?q=${tag}&sort=email`, { key: ADMIN }))
    expect(byQuery.count).toBe(5)
    expect(byQuery.total).toBeGreaterThanOrEqual(5)
    expect(byQuery.contacts.map((c) => c.email)).toEqual(made.map((c) => c.email).sort())

    const byTopic = await json<Page>(await call(`/v1/contacts?topicId=${topic.id}`, { key: ADMIN }))
    expect(byTopic.count).toBe(3)
    expect(
      byTopic.contacts.every((c) => c.topics.some((t) => t.topicId === topic.id && t.state === "subscribed")),
    ).toBe(true)

    // Subscribing to a topic makes the contact subscribed overall.
    const subscribed = await json<Page>(await call(`/v1/contacts?q=${tag}&status=subscribed`, { key: ADMIN }))
    expect(subscribed.count).toBe(4)

    // Two at a time, ascending by email: three pages, no repeats, nothing missed.
    const seen: Array<string> = []
    let cursor: string | null = null
    do {
      const pageResponse = await call(
        `/v1/contacts?q=${tag}&sort=email&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { key: ADMIN },
      )
      const page: Page = await json<Page>(pageResponse)
      seen.push(...page.contacts.map((c) => c.email))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual(made.map((c) => c.email).sort())

    expect((await call("/v1/contacts?cursor=garbage", { key: ADMIN })).status).toBe(400)
  })

  it("rates engagement from tracked events, not from sends", async () => {
    const email = `engaged-${uid()}@example.net`
    await call("/v1/track", { method: "POST", key: ADMIN, json: { event: "opened-app", email } })
    const page = await json<Page>(await call(`/v1/contacts?q=${email}&engagement=active`, { key: ADMIN }))
    expect(page.contacts.map((c) => c.email)).toEqual([email])
    const dormant = await createContact({ email: `quiet-${uid()}@example.net` })
    expect(dormant.engagement).toBe("dormant")
  })

  it("needs the admin scope to change contacts", async () => {
    const { key } = await createKey("secret", ["read"])
    expect((await call("/v1/contacts", { key })).status).toBe(200)
    const denied = await call("/v1/contacts", {
      method: "POST",
      key,
      json: { email: `r-${uid()}@example.net` },
    })
    expect(denied.status).toBe(403)
  })
})

describe("topics and double opt-in", () => {
  it("subscribes straight away when consent is vouched for or the topic is single opt-in", async () => {
    const contact = await createContact({ email: `single-${uid()}@example.net` })
    const single = await createTopic(`Single ${uid()}`, false)
    const result = await json<{ state: string; confirmationSent: boolean; contact: Contact }>(
      await call(`/v1/contacts/${contact.id}/topics/${single.id}`, {
        method: "PUT",
        key: ADMIN,
        json: { state: "subscribed" },
      }),
    )
    expect(result).toMatchObject({ state: "subscribed", confirmationSent: false })
    expect(result.contact.status).toBe("subscribed")

    const double = await createTopic(`Double ${uid()}`, true)
    const vouched = await json<{ state: string; confirmationSent: boolean }>(
      await call(`/v1/contacts/${contact.id}/topics/${double.id}`, {
        method: "PUT",
        key: ADMIN,
        json: { state: "subscribed", confirmed: true },
      }),
    )
    expect(vouched).toEqual(expect.objectContaining({ state: "subscribed", confirmationSent: false }))

    const topics = await json<{ topics: Array<Topic> }>(await call("/v1/topics", { key: ADMIN }))
    expect(topics.topics.find((t) => t.id === single.id)?.subscribers).toBe(1)
  })

  it("holds a double opt-in subscription until the emailed link is followed", async () => {
    const email = `doi-${uid()}@example.net`
    const contact = await createContact({ email })
    const topic = await createTopic(`Newsletter ${uid()}`, true)
    const result = await json<{ state: string; confirmationSent: boolean }>(
      await call(`/v1/contacts/${contact.id}/topics/${topic.id}`, {
        method: "PUT",
        key: ADMIN,
        json: { state: "subscribed" },
      }),
    )
    expect(result).toMatchObject({ state: "unconfirmed", confirmationSent: true })

    const message = await lastMessageTo(email)
    expect(message?.subject).toBe(`Confirm your subscription to ${topic.name}`)
    expect(message?.status).toBe("sent")
    const link = new URL(confirmLink(message?.html ?? ""))
    expect(link.pathname.startsWith("/c/")).toBe(true)

    const page = await call(`${link.pathname}`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("You're subscribed")
    const after = await json<Contact>(await call(`/v1/contacts/${contact.id}`, { key: ADMIN }))
    expect(after.topics).toEqual([{ topicId: topic.id, name: topic.name, state: "subscribed" }])
    expect(after.status).toBe("subscribed")
    // Following the link again changes nothing and still says yes.
    expect((await call(link.pathname)).status).toBe(200)

    // A tampered token is refused.
    const tampered = `${link.pathname.slice(0, -2)}xx`
    expect((await call(tampered)).status).toBe(400)
  })

  it("says why when a double opt-in topic has no one to send its confirmation from", async () => {
    const contact = await createContact({ email: `nofrom-${uid()}@example.net` })
    const topic = await json<Topic>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name: `No sender ${uid()}`, doubleOptIn: true },
      }),
    )
    const response = await call(`/v1/contacts/${contact.id}/topics/${topic.id}`, {
      method: "PUT",
      key: ADMIN,
      json: { state: "subscribed" },
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ field: "from" })
    const bad = await call("/v1/topics", {
      method: "POST",
      key: ADMIN,
      json: { name: "Bad", sender: "nobody" },
    })
    expect(bad.status).toBe(400)
  })

  it("refuses an expired confirmation link", async () => {
    const contact = await createContact({ email: `late-${uid()}@example.net` })
    const topic = await createTopic(`Late ${uid()}`, true)
    const b64url = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "")
    const payload = {
      kind: "confirm",
      contactId: contact.id,
      topicId: topic.id,
      issuedAt: Date.now() - 15 * 86_400_000,
    }
    const body = `v1.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-unsubscribe-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))))
    const response = await call(`/c/${body}.${sig}`)
    expect(response.status).toBe(410)
  })

  it("archives a topic, after which nobody can join it", async () => {
    const topic = await createTopic(`Old ${uid()}`, false)
    const archived = await json<Topic & { archived: boolean }>(
      await call(`/v1/topics/${topic.id}`, { method: "PATCH", key: ADMIN, json: { archived: true } }),
    )
    expect(archived.archived).toBe(true)
    const contact = await createContact({ email: `arch-${uid()}@example.net` })
    const response = await call(`/v1/contacts/${contact.id}/topics/${topic.id}`, {
      method: "PUT",
      key: ADMIN,
      json: { state: "subscribed" },
    })
    expect(response.status).toBe(400)
  })
})

describe("timeline", () => {
  it("merges events, mail and subscription changes, newest first, paged", async () => {
    const email = `timeline-${uid()}@example.net`
    const topic = await createTopic(`Updates ${uid()}`, false)
    await call("/v1/track", { method: "POST", key: ADMIN, json: { event: "signed-up", email } })
    const contactId =
      (await json<Page>(await call(`/v1/contacts?q=${email}`, { key: ADMIN }))).contacts[0]?.id ?? ""
    await call(`/v1/contacts/${contactId}/topics/${topic.id}`, {
      method: "PUT",
      key: ADMIN,
      json: { state: "subscribed" },
    })
    await call("/v1/send", {
      method: "POST",
      key: ADMIN,
      json: {
        to: email,
        from: { email: "shop@mailyard.test", name: "Shop" },
        subject: "Welcome",
        body: "<p>Hi</p>",
      },
    })
    await call(`/v1/contacts/${contactId}/topics/${topic.id}`, {
      method: "PUT",
      key: ADMIN,
      json: { state: "unsubscribed" },
    })

    type Item = {
      kind: string
      at: number
      name?: string
      subject?: string
      to?: string
      from?: string | null
    }
    const all = await json<{ items: Array<Item>; nextCursor: string | null }>(
      await call(`/v1/contacts/${contactId}/timeline`, { key: ADMIN }),
    )
    expect(all.items.map((i) => i.kind).sort()).toEqual(["event", "message", "subscription", "subscription"])
    expect(all.items.find((i) => i.kind === "message")?.subject).toBe("Welcome")
    const changes = all.items.filter((i) => i.kind === "subscription")
    expect(changes.map((c) => c.to)).toEqual(["unsubscribed", "subscribed"])
    for (let i = 1; i < all.items.length; i++) {
      expect((all.items[i - 1]?.at ?? 0) >= (all.items[i]?.at ?? 0)).toBe(true)
    }

    const first = await json<{ items: Array<Item>; nextCursor: string | null }>(
      await call(`/v1/contacts/${contactId}/timeline?limit=3`, { key: ADMIN }),
    )
    expect(first.items).toHaveLength(3)
    const second = await json<{ items: Array<Item>; nextCursor: string | null }>(
      await call(
        `/v1/contacts/${contactId}/timeline?limit=3&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        {
          key: ADMIN,
        },
      ),
    )
    expect([...first.items, ...second.items]).toEqual(all.items)
    expect(second.nextCursor).toBeNull()
  })
})

describe("bulk actions", () => {
  it("applies one action per contact, reporting the ones it skipped", async () => {
    const topic = await createTopic(`Bulk ${uid()}`, false)
    const a = await createContact({ email: `bulk-a-${uid()}@example.net` })
    const b = await createContact({ email: `bulk-b-${uid()}@example.net` })
    type Bulk = { updated: number; skipped: number; errors: Array<{ id: string; message: string }> }
    const added = await json<Bulk>(
      await call("/v1/contacts/bulk", {
        method: "POST",
        key: ADMIN,
        json: { ids: [a.id, b.id, "missing"], action: { action: "addTopic", topicId: topic.id } },
      }),
    )
    expect(added).toEqual({
      updated: 2,
      skipped: 1,
      errors: [{ id: "missing", message: "No such contact." }],
    })
    const removed = await json<Bulk>(
      await call("/v1/contacts/bulk", {
        method: "POST",
        key: ADMIN,
        json: { ids: [a.id], action: { action: "removeTopic", topicId: topic.id } },
      }),
    )
    expect(removed.updated).toBe(1)
    const status = await json<Bulk>(
      await call("/v1/contacts/bulk", {
        method: "POST",
        key: ADMIN,
        json: { ids: [a.id, b.id], action: { action: "setStatus", status: "unsubscribed" } },
      }),
    )
    expect(status.updated).toBe(2)
    const deleted = await json<Bulk>(
      await call("/v1/contacts/bulk", {
        method: "POST",
        key: ADMIN,
        json: { ids: [a.id], action: { action: "delete" } },
      }),
    )
    expect(deleted).toMatchObject({ updated: 1, skipped: 0 })
    expect((await call(`/v1/contacts/${a.id}`, { key: ADMIN })).status).toBe(404)

    const tooMany = await call("/v1/contacts/bulk", {
      method: "POST",
      key: ADMIN,
      json: { ids: Array.from({ length: 1001 }, (_, i) => `c${i}`), action: { action: "delete" } },
    })
    expect(tooMany.status).toBe(400)
  })
})

describe("signup forms", () => {
  const makeForm = async (doubleOptIn: boolean, extra: Record<string, unknown> = {}) => {
    const topic = await createTopic(`Form topic ${uid()}`, doubleOptIn)
    const response = await call("/v1/forms", {
      method: "POST",
      key: ADMIN,
      json: { name: `Signup ${uid()}`, topicIds: [topic.id], fields: ["company"], ...extra },
    })
    if (response.status !== 200) throw new Error(`create form: ${response.status} ${await response.text()}`)
    return { form: await json<{ id: string }>(response), topic }
  }

  it("subscribes through a double opt-in form, keeping only the form's own fields", async () => {
    const { form, topic } = await makeForm(true)
    const email = `form-${uid()}@example.net`
    const response = await call(`/v1/forms/${form.id}/submit`, {
      method: "POST",
      json: { email, name: "Grace", company: "Navy", role: "admiral" },
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ status: "confirm" })
    const contact = (await json<Page>(await call(`/v1/contacts?q=${email}`, { key: ADMIN }))).contacts[0]
    expect(contact).toMatchObject({ name: "Grace", status: "unconfirmed", fields: { company: "Navy" } })
    expect(contact?.topics).toEqual([{ topicId: topic.id, name: topic.name, state: "unconfirmed" }])
    const message = await lastMessageTo(email)
    await call(new URL(confirmLink(message?.html ?? "")).pathname)
    const confirmed = await json<Contact>(await call(`/v1/contacts/${contact?.id}`, { key: ADMIN }))
    expect(confirmed.status).toBe("subscribed")
  })

  it("redirects a browser post, ignores bots and refuses a bad address", async () => {
    const { form } = await makeForm(false, { redirectUrl: "https://example.net/thanks" })
    const browser = await call(`/v1/forms/${form.id}/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ email: `browser-${uid()}@example.net` }).toString(),
      redirect: "manual",
    })
    expect(browser.status).toBe(303)
    expect(browser.headers.get("location")).toBe("https://example.net/thanks")

    const botEmail = `bot-${uid()}@example.net`
    const bot = await call(`/v1/forms/${form.id}/submit`, {
      method: "POST",
      json: { email: botEmail, website: "spam.example" },
    })
    expect(bot.status).toBe(200)
    expect((await json<Page>(await call(`/v1/contacts?q=${botEmail}`, { key: ADMIN }))).count).toBe(0)

    const bad = await call(`/v1/forms/${form.id}/submit`, { method: "POST", json: { email: "nope" } })
    expect(bad.status).toBe(400)
    expect(
      (await call("/v1/forms/frm_missing/submit", { method: "POST", json: { email: "a@b.co" } })).status,
    ).toBe(404)

    await call(`/v1/forms/${form.id}`, { method: "PATCH", key: ADMIN, json: { archived: true } })
    expect(
      (
        await call(`/v1/forms/${form.id}/submit`, {
          method: "POST",
          json: { email: `x-${uid()}@example.net` },
        })
      ).status,
    ).toBe(404)
  })

  it("rate-limits submissions per IP and form", async () => {
    const { form } = await makeForm(false)
    const statuses: Array<number> = []
    for (let i = 0; i < 12; i++) {
      const response = await call(`/v1/forms/${form.id}/submit`, {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.9" },
        json: { email: `burst-${i}-${uid()}@example.net` },
      })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
  })

  it("validates forms when they are made", async () => {
    const noTopic = await call("/v1/forms", {
      method: "POST",
      key: ADMIN,
      json: { name: "Empty", topicIds: [] },
    })
    expect(noTopic.status).toBe(400)
    const unknown = await call("/v1/forms", {
      method: "POST",
      key: ADMIN,
      json: { name: "X", topicIds: ["top_missing"] },
    })
    expect(unknown.status).toBe(400)
    const insecure = await call("/v1/forms", {
      method: "POST",
      key: ADMIN,
      json: {
        name: "X",
        topicIds: [(await createTopic(`T ${uid()}`, false)).id],
        redirectUrl: "http://example.net",
      },
    })
    expect(insecure.status).toBe(400)
  })
})

describe("export and erasure", () => {
  it("exports everything held about a contact, then erases it but keeps the suppression", async () => {
    const email = `gdpr-${uid()}@example.net`
    await call("/v1/track", {
      method: "POST",
      key: ADMIN,
      json: { event: "logged-in", email, data: { from: "web" } },
    })
    await call("/v1/send", {
      method: "POST",
      key: ADMIN,
      json: {
        to: email,
        from: { email: "shop@mailyard.test", name: "Shop" },
        subject: "Your receipt",
        body: "<p>£12</p>",
      },
    })
    const contactId =
      (await json<Page>(await call(`/v1/contacts?q=${email}`, { key: ADMIN }))).contacts[0]?.id ?? ""
    await env.DB.prepare(
      "insert into suppressions (email, reason, source, at) values (?, 'complaint', 'events', ?)",
    )
      .bind(email, Date.now())
      .run()

    const exported = await json<{
      contact: { email: string }
      events: Array<{ name: string }>
      messages: Array<{ subject: string }>
      suppression: { reason: string } | null
    }>(await call(`/v1/contacts/${contactId}/export`, { key: ADMIN }))
    expect(exported.contact.email).toBe(email)
    expect(exported.events.map((e) => e.name)).toEqual(["logged-in"])
    expect(exported.messages.map((m) => m.subject)).toEqual(["Your receipt"])
    expect(exported.suppression?.reason).toBe("complaint")

    const rendered = await env.DB.prepare("select rendered_key from messages_out where recipient = ?")
      .bind(email)
      .first<{ rendered_key: string }>()
    const erased = await json<{ erased: boolean; messagesScrubbed: number }>(
      await call(`/v1/contacts/${contactId}/erase`, { method: "POST", key: ADMIN }),
    )
    expect(erased).toMatchObject({ erased: true, messagesScrubbed: 1 })
    expect((await call(`/v1/contacts/${contactId}`, { key: ADMIN })).status).toBe(404)
    expect(
      await env.DB.prepare("select count(*) as n from messages_out where recipient = ?").bind(email).first(),
    ).toEqual({ n: 0 })
    expect(
      await env.DB.prepare(
        "select subject from messages_out where recipient like 'erased:%' and subject = '(erased)' limit 1",
      ).first(),
    ).toEqual({ subject: "(erased)" })
    expect(await env.STORE.get(rendered?.rendered_key ?? "")).toBeNull()
    expect(
      await env.DB.prepare("select reason from suppressions where email = ?").bind(email).first(),
    ).toEqual({ reason: "complaint" })
    const audit = await env.DB.prepare(
      "select after from audit where action = 'contact.erase' and target = ?",
    )
      .bind(contactId)
      .first<{ after: string }>()
    expect(audit?.after).not.toContain(email)
  })
})

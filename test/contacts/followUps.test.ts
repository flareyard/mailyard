import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { handleEmail } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

/** HAL-3426: usedBy for date triggers and waits, replies that open their thread, consent evidence. */
installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

type Evidence = {
  ip?: string
  userAgent?: string
  page?: string
  formId?: string
  formVersion?: string
}
type Item = {
  kind: string
  topicId?: string
  from?: string | null
  to?: string
  source?: string
  method?: string
  evidence?: Evidence | null
  mailboxId?: string | null
  threadId?: string | null
  messageId?: string | null
}
const timeline = async (contactId: string, kind: string) =>
  (await json<{ items: Item[] }>(await admin(`/v1/contacts/${contactId}/timeline?kind=${kind}`))).items

const topic = async (doubleOptIn: boolean) =>
  (
    await json<{ id: string }>(
      await admin("/v1/topics", "POST", {
        name: `Notes ${uid()}`,
        doubleOptIn,
        sender: "Lists <lists@mailyard.test>",
      }),
    )
  ).id

const form = async (topicIds: string[]) =>
  (
    await json<{ id: string }>(
      await admin("/v1/forms", "POST", { name: `Join ${uid()}`, topicIds, fields: ["first_name"] }),
    )
  ).id

/** A visitor's browser submitting the form from a page on someone's site. */
const submit = (formId: string, email: string) =>
  call(`/v1/forms/${formId}/submit`, {
    method: "POST",
    headers: {
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "Mozilla/5.0 (Evidence Test)",
      referer: "https://shop.example/landing?utm=x&token=nope",
      "content-type": "application/json",
      origin: "https://shop.example",
    },
    body: JSON.stringify({ email, first_name: "Ada" }),
  })

const contactByEmail = (email: string) =>
  env.DB.prepare("select id from contacts where email = ?").bind(email).first<{ id: string }>()

const confirmLink = async (email: string) => {
  const row = await env.DB.prepare(
    "select rendered_key from messages_out where recipient = ? order by created_at desc limit 1",
  )
    .bind(email)
    .first<{ rendered_key: string }>()
  const rendered = (await (await env.STORE.get(row?.rendered_key ?? ""))?.json()) as
    | { html?: string }
    | undefined
  const html = rendered?.html ?? ""
  const match = /href="(https?:\/\/[^"]+\/c\/[^"]+)"/.exec(html)
  if (!match?.[1]) throw new Error("no confirmation link")
  return new URL(match[1].replaceAll("&amp;", "&"))
}

describe("usedBy counts date triggers and wait-until fields (HAL-3426)", () => {
  it("names the automation that reads a field through its trigger or a wait", async () => {
    const tag = uid()
    const signed = `signed_up_${tag}`
    const renews = `renews_${tag}`
    await admin("/v1/contacts", "POST", {
      email: `f-${tag}@example.net`,
      fields: { [signed]: "2026-01-01", [renews]: "2027-01-01" },
    })
    const created = await json<{ id: string }>(
      await admin("/v1/automations", "POST", {
        name: `Anniversary ${tag}`,
        graph: {
          nodes: [
            {
              id: "t",
              type: "trigger",
              config: { kind: "date", field: signed, offsetDays: 0, hour: 9, repeat: "yearly" },
            },
            {
              id: "w",
              type: "wait_until",
              config: { kind: "field", field: renews, offsetDays: -7, hour: 9 },
            },
            { id: "x", type: "exit", config: {} },
          ],
          edges: [
            { from: "t", to: "w" },
            { from: "w", to: "x" },
          ],
        },
        settings: {
          fromAddress: "Team <team@mailyard.test>",
          topicId: null,
          reentry: { mode: "never" },
          cadence: null,
          stopEvents: [],
        },
      }),
    )
    const fields = await json<{
      fields: Array<{ key: string; usedBy: Array<{ type: string; id: string }> }>
    }>(await admin("/v1/contact-fields"))
    for (const key of [signed, renews])
      expect(fields.fields.find((f) => f.key === key)?.usedBy).toEqual([
        expect.objectContaining({ type: "automation", id: created.id }),
      ])
  })
})

describe("a reply on the timeline opens its thread (HAL-3426)", () => {
  it("carries the mailbox, thread and filed message", async () => {
    const domain = `fu-${uid()}.test`
    setDns(goodDomain(domain))
    await admin("/v1/domains", "POST", { name: domain })
    const box = await json<{ id: string; address: string }>(
      await admin("/v1/mailboxes", "POST", { address: `help@${domain}`, kind: "user" }),
    )
    const from = `reply-${uid()}@example.org`
    const person = await json<{ id: string }>(await admin("/v1/contacts", "POST", { email: from }))
    const raw = `From: Ada <${from}>\r\nTo: ${box.address}\r\nSubject: Re: Welcome\r\nMessage-ID: <${uid()}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n\r\nThanks!\r\n`
    const bytes = new TextEncoder().encode(raw)
    await handleEmail(
      {
        from,
        to: box.address,
        headers: new Headers(),
        raw: new Blob([bytes]).stream(),
        rawSize: bytes.byteLength,
        canBeForwarded: true,
        setReject: () => {},
        forward: async () => {},
        reply: async () => {},
      } as unknown as ForwardableEmailMessage,
      env,
    )
    const [reply] = await timeline(person.id, "reply")
    expect(reply).toMatchObject({ kind: "reply", mailboxId: box.id })
    expect(reply?.threadId).toEqual(expect.any(String))
    // The thread really is that message's conversation.
    const thread = await admin(`/v1/mailboxes/${box.id}/threads/${reply?.threadId}`)
    expect(thread.status).toBe(200)
    const message = await admin(`/v1/mailboxes/${box.id}/messages/${reply?.messageId}`)
    expect(message.status).toBe(200)
  })
})

describe("consent evidence (HAL-3426)", () => {
  it("keeps the signup's and the confirmation's IP, browser, page and form version", async () => {
    const t = await topic(true)
    const f = await form([t])
    const email = `doi-${uid()}@example.net`
    const res = await submit(f, email)
    expect(res.status).toBe(200)
    const c = await contactByEmail(email)
    const link = await confirmLink(email)
    const confirmed = await call(link.pathname, {
      headers: { "cf-connecting-ip": "198.51.100.9", "user-agent": "MailApp/2.0" },
    })
    expect(confirmed.status).toBe(200)

    const subs = await timeline(c?.id ?? "", "subscription")
    const signup = subs.find((s) => s.to === "unconfirmed")
    expect(signup?.evidence).toMatchObject({
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (Evidence Test)",
      // The page they signed up on, without its query string.
      page: "https://shop.example/landing",
      formId: f,
      formVersion: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    const [consent] = await timeline(c?.id ?? "", "consent")
    expect(consent).toMatchObject({
      kind: "consent",
      topicId: t,
      method: "double_opt_in",
      source: "confirmation link",
      evidence: { ip: "198.51.100.9", userAgent: "MailApp/2.0", formId: f },
    })
    // The confirmation link's token is a working link: it's never kept.
    expect(consent?.evidence?.page).toMatch(/\/c$/)
    expect(JSON.stringify(consent)).not.toContain(link.pathname.slice(3))
  })

  it("records a single opt-in form signup as consent, and the same form gives the same version", async () => {
    const t = await topic(false)
    const f = await form([t])
    const a = `so-a-${uid()}@example.net`
    const b = `so-b-${uid()}@example.net`
    await submit(f, a)
    await submit(f, b)
    const [ca] = await timeline((await contactByEmail(a))?.id ?? "", "consent")
    const [cb] = await timeline((await contactByEmail(b))?.id ?? "", "consent")
    expect(ca).toMatchObject({
      method: "form",
      source: `form:${f}`,
      evidence: { ip: "203.0.113.7", formId: f },
    })
    expect(ca?.evidence?.formVersion).toBe(cb?.evidence?.formVersion)
    // Changing what the form shows changes its version.
    await admin(`/v1/forms/${f}`, "PATCH", { name: "Join us, now with more" })
    const c = `so-c-${uid()}@example.net`
    await submit(f, c)
    const [cc] = await timeline((await contactByEmail(c))?.id ?? "", "consent")
    expect(cc?.evidence?.formVersion).not.toBe(ca?.evidence?.formVersion)
  })

  it("says nothing it doesn't know: an API subscription has no evidence and isn't consent", async () => {
    const t = await topic(false)
    const person = await json<{ id: string }>(
      await admin("/v1/contacts", "POST", { email: `api-${uid()}@example.net` }),
    )
    await admin(`/v1/contacts/${person.id}/topics/${t}`, "PUT", { state: "subscribed" })
    expect((await timeline(person.id, "subscription"))[0]?.evidence).toBeNull()
    expect(await timeline(person.id, "consent")).toEqual([])
  })
})

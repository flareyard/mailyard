import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"

installDohFixture()

/** Link checks reach the network; in these tests every host answers from this table instead. */
const LINKS: Record<string, number | "timeout"> = {
  "ok.links.test": 200,
  "moved.links.test": 301,
  "gone.links.test": 404,
  "nohead.links.test": 405,
  "slow.links.test": "timeout",
}
beforeAll(() => {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const host = new URL(request.url).hostname
    // Only DNS-over-HTTPS goes on (to its own fixture); every other host answers here, 200 unless listed.
    if (host === "cloudflare-dns.com") return real(input, init)
    const answer = LINKS[host] ?? 200
    if (answer === "timeout") throw new DOMException("The operation timed out.", "TimeoutError")
    if (answer === 405 && request.method === "GET") return new Response(null, { status: 206 })
    return new Response(null, { status: answer })
  }) as typeof fetch
})

const uid = () => crypto.randomUUID().slice(0, 8)

const sendingDomain = async () => {
  const name = `news-${uid()}.test`
  setDns(goodDomain(name))
  const response = await call("/v1/domains", {
    method: "POST",
    key: ADMIN,
    json: { name, sending: true, receiving: false },
  })
  if (response.status !== 200) throw new Error(`domain: ${await response.text()}`)
  return name
}

type Campaign = { id: string; status: string; subject: string; templateVersion: number | null }
const createCampaign = async (body: Record<string, unknown>) => {
  const response = await call("/v1/campaigns", { method: "POST", key: ADMIN, json: body })
  return {
    status: response.status,
    body: (await response.json()) as Campaign & { field?: string; message?: string },
  }
}

describe("campaigns: drafts", () => {
  it("creates, edits and deletes a draft, validating every field against the rest", async () => {
    const domain = await sendingDomain()
    const base = {
      name: "Spring",
      fromAddress: `News <news@${domain}>`,
      subject: "Hello",
      bodyHtml: "<p>Hi {{name}}</p>",
    }
    const created = await createCampaign(base)
    expect(created.status).toBe(200)
    expect(created.body.status).toBe("draft")

    const bad: Array<[Record<string, unknown>, string]> = [
      [{ ...base, fromAddress: "news@unknown-domain.test" }, "fromAddress"],
      [{ ...base, subject: "" }, "subject"],
      [{ ...base, templateId: "tpl_x" }, "bodyHtml"],
      [{ ...base, segmentId: "seg_missing" }, "segmentId"],
      [{ ...base, ab: { percent: 20, waitHours: 4, metric: "clicks" } }, "subjectB"],
      [{ ...base, subjectB: "Other", ab: { percent: 80, waitHours: 4, metric: "clicks" } }, "ab.percent"],
      [
        { ...base, subjectB: "Other", trackOpens: false, ab: { percent: 20, waitHours: 4, metric: "opens" } },
        "ab.metric",
      ],
    ]
    for (const [body, field] of bad) {
      const r = await createCampaign(body)
      expect(r.status, field).toBe(400)
      expect(r.body.field).toBe(field)
    }

    const edited = await json<Campaign>(
      await call(`/v1/campaigns/${created.body.id}`, {
        method: "PATCH",
        key: ADMIN,
        json: { subject: "Hello again" },
      }),
    )
    expect(edited.subject).toBe("Hello again")
    const list = await json<{ campaigns: Array<{ id: string }> }>(
      await call("/v1/campaigns?status=draft", { key: ADMIN }),
    )
    expect(list.campaigns.some((c) => c.id === created.body.id)).toBe(true)

    // A campaign past draft is locked: its content is what it sent.
    await env.DB.prepare("update campaigns set status = 'sending' where id = ?").bind(created.body.id).run()
    expect(
      (
        await call(`/v1/campaigns/${created.body.id}`, {
          method: "PATCH",
          key: ADMIN,
          json: { subject: "x" },
        })
      ).status,
    ).toBe(409)
    expect((await call(`/v1/campaigns/${created.body.id}`, { method: "DELETE", key: ADMIN })).status).toBe(
      409,
    )
    await env.DB.prepare("update campaigns set status = 'draft' where id = ?").bind(created.body.id).run()
    expect((await call(`/v1/campaigns/${created.body.id}`, { method: "DELETE", key: ADMIN })).status).toBe(
      200,
    )
  })

  it("needs the admin scope to change a campaign", async () => {
    const { key } = await createKey("secret", ["read"])
    expect((await call("/v1/campaigns", { key })).status).toBe(200)
    expect(
      (
        await call("/v1/campaigns", {
          method: "POST",
          key,
          json: { name: "x", fromAddress: "a@b.co", subject: "s" },
        })
      ).status,
    ).toBe(403)
  })
})

describe("campaigns: rendering", () => {
  it("renders for a real contact with merge fields, unsubscribe headers and a compliant footer", async () => {
    const domain = await sendingDomain()
    await call("/v1/settings/compliance", {
      method: "PUT",
      key: ADMIN,
      json: { postalAddress: "1 Yard Lane, Lagos", linkAllowlist: [], seedAddresses: [] },
    })
    const topic = await json<{ id: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name: `Weekly ${uid()}`, doubleOptIn: false },
      }),
    )
    const contact = await json<{ id: string }>(
      await call("/v1/contacts", {
        method: "POST",
        key: ADMIN,
        json: { email: `r-${uid()}@example.net`, name: "Ada", fields: { plan: "pro" } },
      }),
    )
    const { body: campaign } = await createCampaign({
      name: "Weekly",
      fromAddress: `Weekly <weekly@${domain}>`,
      subject: "Your {{plan}} week",
      subjectB: "B: your week",
      preheader: "Five things this week",
      topicId: topic.id,
      bodyHtml: "<html><body><p>Hi {{name}}</p></body></html>",
    })
    const rendered = await json<{
      subject: string
      html: string
      text: string
      headers: Record<string, string>
      footerAdded: boolean
    }>(
      await call(`/v1/campaigns/${campaign.id}/render`, {
        method: "POST",
        key: ADMIN,
        json: { contactId: contact.id },
      }),
    )
    expect(rendered.subject).toBe("Your pro week")
    expect(rendered.html).toContain("<p>Hi Ada</p>")
    expect(rendered.html).toContain("Five things this week")
    expect(rendered.footerAdded).toBe(true)
    expect(rendered.html).toContain("1 Yard Lane, Lagos")
    expect(rendered.text).toContain("Unsubscribe: https://mailyard.test/u/")
    expect(rendered.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    expect(rendered.headers["List-Unsubscribe"]).toContain(`mailto:unsubscribe@${domain}`)
    // The footer's link is a working one-click link for this contact.
    const link = /href="(https:\/\/mailyard\.test\/u\/[^"]+)"/.exec(rendered.html)?.[1] ?? ""
    expect((await call(new URL(link.replaceAll("&amp;", "&")).pathname)).status).toBe(200)
    const b = await json<{ subject: string }>(
      await call(`/v1/campaigns/${campaign.id}/render`, {
        method: "POST",
        key: ADMIN,
        json: { contactId: contact.id, variant: "b" },
      }),
    )
    expect(b.subject).toBe("B: your week")
  })

  it("leaves a template's own unsubscribe link alone", async () => {
    const domain = await sendingDomain()
    const template = await json<{ id: string }>(
      await call("/v1/templates", {
        method: "POST",
        key: ADMIN,
        json: {
          name: `Footer ${uid()}`,
          kind: "html",
          subject: "x",
          source: '<p>Hi</p><a href="{{unsubscribe_url}}">Leave</a>',
        },
      }),
    )
    await call(`/v1/templates/${template.id}/publish`, { method: "POST", key: ADMIN })
    const { body: campaign } = await createCampaign({
      name: "T",
      fromAddress: `news@${domain}`,
      subject: "With footer",
      templateId: template.id,
    })
    const rendered = await json<{ html: string; footerAdded: boolean }>(
      await call(`/v1/campaigns/${campaign.id}/render`, { method: "POST", key: ADMIN, json: {} }),
    )
    expect(rendered.footerAdded).toBe(false)
    expect(rendered.html).toMatch(/<a href="https:\/\/mailyard\.test\/u\/[^"]+">Leave<\/a>/)
  })
})

describe("campaigns: pre-flight checks", () => {
  it("passes a clean campaign and names each problem in a bad one", async () => {
    const domain = await sendingDomain()
    await call("/v1/settings/compliance", {
      method: "PUT",
      key: ADMIN,
      json: { postalAddress: "1 Yard Lane, Lagos", linkAllowlist: ["links.test"], seedAddresses: [] },
    })
    type Checks = { ready: boolean; checks: Array<{ id: string; status: string; detail: string }> }
    const status = (c: Checks, id: string) => c.checks.find((x) => x.id === id)?.status
    const { body: clean } = await createCampaign({
      name: "Clean",
      fromAddress: `Team <team@${domain}>`,
      subject: "News from the yard",
      bodyHtml: `<p>See <a href="https://ok.links.test/a">this</a> and <a href="https://nohead.links.test/">that</a> and <a href="https://moved.links.test/">moved</a> and <a href="https://www.${domain}/blog">our blog</a>.</p>`,
    })
    const good = await json<Checks>(await call(`/v1/campaigns/${clean.id}/checks`, { key: ADMIN }))
    expect(good.ready).toBe(true)
    for (const id of [
      "sender",
      "subject",
      "plain_text",
      "size",
      "shorteners",
      "link_domains",
      "links_resolve",
      "reply_to",
      "unsubscribe",
      "postal_address",
    ]) {
      expect(status(good, id), id).toBe("pass")
    }

    const { body: messy } = await createCampaign({
      name: "Messy",
      fromAddress: `noreply@${domain}`,
      subject: "BUY NOW LIMITED OFFER",
      bodyHtml: `<p><a href="https://bit.ly/x">deal</a> <a href="https://gone.links.test/">gone</a> <a href="https://elsewhere.example.org/">elsewhere</a></p>`,
    })
    const bad = await json<Checks>(await call(`/v1/campaigns/${messy.id}/checks`, { key: ADMIN }))
    expect(bad.ready).toBe(false)
    expect(status(bad, "subject")).toBe("warn")
    expect(status(bad, "shorteners")).toBe("fail")
    expect(status(bad, "links_resolve")).toBe("fail")
    expect(status(bad, "link_domains")).toBe("warn")
    expect(status(bad, "reply_to")).toBe("warn")

    const { body: slow } = await createCampaign({
      name: "Slow",
      fromAddress: `team@${domain}`,
      subject: "Slow links",
      bodyHtml: `<p><a href="https://slow.links.test/">slow</a></p>`,
    })
    expect(
      status(
        await json<Checks>(await call(`/v1/campaigns/${slow.id}/checks`, { key: ADMIN })),
        "links_resolve",
      ),
    ).toBe("warn")

    const { body: huge } = await createCampaign({
      name: "Huge",
      fromAddress: `team@${domain}`,
      subject: "Huge",
      bodyHtml: `<p>${"x".repeat(110 * 1024)}</p>`,
    })
    expect(
      status(await json<Checks>(await call(`/v1/campaigns/${huge.id}/checks`, { key: ADMIN })), "size"),
    ).toBe("fail")
  })
})

describe("campaigns: audience and test sends", () => {
  it("counts who it would reach and why the rest are left out", async () => {
    const domain = await sendingDomain()
    const tag = uid()
    const topic = await json<{ id: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name: `Aud ${tag}`, doubleOptIn: false },
      }),
    )
    const make = async (status: string, onTopic: boolean, i: number) => {
      const c = await json<{ id: string; email: string }>(
        await call("/v1/contacts", {
          method: "POST",
          key: ADMIN,
          json: { email: `a${i}-${tag}@example.net`, fields: { tag } },
        }),
      )
      if (onTopic)
        await call(`/v1/contacts/${c.id}/topics/${topic.id}`, {
          method: "PUT",
          key: ADMIN,
          json: { state: "subscribed" },
        })
      await env.DB.prepare("update contacts set status = ? where id = ?").bind(status, c.id).run()
      return c
    }
    await make("subscribed", true, 1)
    await make("subscribed", true, 2)
    await make("subscribed", false, 3)
    await make("unsubscribed", true, 4)
    await make("unconfirmed", true, 5)
    await make("bounced", true, 6)
    const suppressed = await make("subscribed", true, 7)
    await env.DB.prepare(
      "insert into suppressions (email, reason, source, at) values (?, 'complaint', 'events', ?)",
    )
      .bind(suppressed.email, Date.now())
      .run()
    const segment = await json<{ id: string }>(
      await call("/v1/segments", {
        method: "POST",
        key: ADMIN,
        json: { name: `Tag ${tag}`, filter: { type: "field", field: "tag", op: "eq", value: tag } },
      }),
    )
    const { body: campaign } = await createCampaign({
      name: "Aud",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      segmentId: segment.id,
      topicId: topic.id,
    })
    const preview = await json<{ matching: number; sendable: number; excluded: Record<string, number> }>(
      await call(`/v1/campaigns/${campaign.id}/audience/preview`, { method: "POST", key: ADMIN }),
    )
    expect(preview).toEqual({
      matching: 7,
      sendable: 2,
      excluded: { blocked: 2, unsubscribed: 1, unconfirmed: 1, notOnTopic: 1 },
    })
  })

  it("test-sends to the seed list, marked [Test], with real unsubscribe headers, outside the quota", async () => {
    const domain = await sendingDomain()
    const seeds = [`seed1-${uid()}@example.net`, `seed2-${uid()}@example.net`]
    await call("/v1/settings/compliance", {
      method: "PUT",
      key: ADMIN,
      json: { postalAddress: null, linkAllowlist: [], seedAddresses: seeds },
    })
    const { body: campaign } = await createCampaign({
      name: "Test",
      fromAddress: `news@${domain}`,
      subject: "Ready?",
      bodyHtml: "<p>Hi</p>",
    })
    const before = await json<{ sent: { campaign: number; transactional: number } }>(
      await call("/v1/sending/governor", { key: ADMIN }),
    )
    const result = await json<{ sent: Array<{ email: string; status: string; messageId: string }> }>(
      await call(`/v1/campaigns/${campaign.id}/test`, { method: "POST", key: ADMIN, json: {} }),
    )
    expect(result.sent.map((s) => s.email)).toEqual(seeds)
    expect(result.sent.every((s) => s.status === "sent")).toBe(true)
    const row = await env.DB.prepare(
      "select stream, subject, campaign_id, rendered_key from messages_out where id = ?",
    )
      .bind(result.sent[0]?.messageId)
      .first<{ stream: string; subject: string; campaign_id: string; rendered_key: string }>()
    expect(row).toMatchObject({ stream: "test", subject: "[Test] Ready?", campaign_id: campaign.id })
    const stored = (await (await env.STORE.get(row?.rendered_key ?? ""))?.json()) as {
      headers: Record<string, string>
    }
    expect(stored.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    const after = await json<{ sent: { campaign: number; transactional: number } }>(
      await call("/v1/sending/governor", { key: ADMIN }),
    )
    expect(after.sent).toEqual(before.sent)

    expect(
      (
        await call(`/v1/campaigns/${campaign.id}/test`, {
          method: "POST",
          key: ADMIN,
          json: { to: Array.from({ length: 6 }, (_, i) => `s${i}@example.net`) },
        })
      ).status,
    ).toBe(400)
  })
})

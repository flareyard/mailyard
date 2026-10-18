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
    if (host === "redirect.links.test") {
      // As fetch reports a followed redirect: the final response, with where it ended up.
      const r = new Response(null, { status: 200 })
      Object.defineProperty(r, "url", { value: "https://ok.links.test/landed" })
      return r
    }
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

describe("campaigns: fix targets, link statuses and block content (HAL-3430)", () => {
  type Fix = { label: string; target: string; field?: string; domainId?: string }
  type Checks = {
    ready: boolean
    checks: Array<{ id: string; status: string; detail: string; fix: Fix | null }>
  }
  const fixOf = (c: Checks, id: string) => c.checks.find((x) => x.id === id)?.fix

  it("says where each check is fixed", async () => {
    const domain = await sendingDomain()
    await call("/v1/settings/compliance", {
      method: "PUT",
      key: ADMIN,
      json: { postalAddress: null, linkAllowlist: [], seedAddresses: [] },
    })
    const { body: campaign } = await createCampaign({
      name: "Fixes",
      fromAddress: `noreply@${domain}`,
      subject: "Hi",
      bodyHtml: `<p>Hi {{ first_name | "there" }}, <a href="https://gone.links.test/">read</a></p>`,
    })
    const c = await json<Checks>(await call(`/v1/campaigns/${campaign.id}/checks`, { key: ADMIN }))
    // Every check carries a fix, null only where Mailyard always satisfies it.
    for (const check of c.checks) expect(check, check.id).toHaveProperty("fix")
    expect(c.checks.filter((x) => x.fix === null).map((x) => x.id)).toEqual(["unsubscribe"])
    const domainRow = await env.DB.prepare("select id from domains where name = ?")
      .bind(domain)
      .first<{ id: string }>()
    expect(fixOf(c, "subject")).toEqual({ label: "Edit the subject", target: "content", field: "subject" })
    expect(fixOf(c, "links_resolve")).toMatchObject({ target: "content", field: "bodyHtml" })
    expect(fixOf(c, "reply_to")).toMatchObject({ target: "content", field: "replyTo" })
    expect(fixOf(c, "postal_address")).toMatchObject({
      target: "settings.compliance",
      field: "postalAddress",
    })
    expect(fixOf(c, "link_domains")).toMatchObject({ target: "settings.compliance", field: "linkAllowlist" })
    expect(fixOf(c, "tracking")).toMatchObject({ target: "settings.compliance", field: "trackingOrigin" })
    expect(fixOf(c, "sender")).toMatchObject({ target: "content", field: "fromAddress" })
    // A placeholder the renderer doesn't know goes out as typed: flagged, with the syntax that works.
    const merge = c.checks.find((x) => x.id === "merge_fields")
    expect(merge).toMatchObject({ status: "warn" })
    expect(merge?.detail).toContain('{{ first_name | "there" }}')
    expect(merge?.detail).toContain('{{ name ?? "there" }}')

    // A sending domain that fails its records points at that domain.
    await env.DB.prepare("update domains set sending_enabled = 0 where id = ?").bind(domainRow?.id).run()
    const off = await json<Checks>(await call(`/v1/campaigns/${campaign.id}/checks`, { key: ADMIN }))
    expect(fixOf(off, "sender")).toEqual({
      label: "Turn on sending",
      target: "domains",
      domainId: domainRow?.id,
    })
  })

  it("lists each link with what the check found, and follows the rest on request", async () => {
    const domain = await sendingDomain()
    const tag = uid()
    const { body: campaign } = await createCampaign({
      name: "Links",
      fromAddress: `team@${domain}`,
      subject: "Links",
      bodyHtml: `<p><a href="https://ok.links.test/${tag}">ok</a> <a href="https://gone.links.test/${tag}">gone</a> <a href="https://redirect.links.test/${tag}">moved</a> <a href="https://slow.links.test/${tag}">slow</a></p>`,
    })
    type Link = {
      url: string
      status: number | null
      error: string | null
      redirectsTo: string | null
      checkedAt: number | null
    }
    const render = async (body: Record<string, unknown> = {}) =>
      json<{ links: Array<Link> }>(
        await call(`/v1/campaigns/${campaign.id}/render`, { method: "POST", key: ADMIN, json: body }),
      )
    // Before any check: listed, never followed.
    const before = await render()
    expect(before.links.map((l) => l.url)).toEqual([
      `https://ok.links.test/${tag}`,
      `https://gone.links.test/${tag}`,
      `https://redirect.links.test/${tag}`,
      `https://slow.links.test/${tag}`,
    ])
    expect(before.links.every((l) => l.status === null && l.checkedAt === null)).toBe(true)
    // The checks follow them and keep what they found; the render reads it back.
    await call(`/v1/campaigns/${campaign.id}/checks`, { key: ADMIN })
    const after = await render()
    expect(after.links.map((l) => [l.status, l.error, l.redirectsTo])).toEqual([
      [200, null, null],
      [404, null, null],
      [200, null, "https://ok.links.test/landed"],
      [null, "timed out", null],
    ])
    expect(after.links.every((l) => typeof l.checkedAt === "number")).toBe(true)

    // checkLinks follows what was never checked, without a checks run.
    const fresh = `https://ok.links.test/new-${tag}`
    await call(`/v1/campaigns/${campaign.id}`, {
      method: "PATCH",
      key: ADMIN,
      json: { bodyHtml: `<p><a href="${fresh}">new</a></p>` },
    })
    expect((await render()).links).toEqual([
      { url: fresh, status: null, error: null, redirectsTo: null, checkedAt: null },
    ])
    expect((await render({ checkLinks: true })).links[0]).toMatchObject({ url: fresh, status: 200 })
  })

  it("keeps block content and renders it through the template kit, merge-field fallbacks included", async () => {
    const domain = await sendingDomain()
    const doc = {
      preheader: "Spring is here",
      label: "News",
      blocks: [
        { type: "heading", text: 'Hello {{ name ?? "there" }}' },
        { type: "paragraph", text: "Our {{ season }} sale starts now." },
        { type: "button", label: "Shop", url: "https://ok.links.test/shop" },
      ],
      footer: {
        reason: "You signed up at the yard.",
        links: [{ label: "Unsubscribe", url: "{{ unsubscribe_url }}" }],
      },
    }
    const { status, body: campaign } = await createCampaign({
      name: "Blocks",
      fromAddress: `team@${domain}`,
      subject: "Spring",
      bodyBlocks: doc,
    })
    expect(status).toBe(200)
    expect((campaign as unknown as { bodyBlocks: unknown }).bodyBlocks).toEqual(doc)
    const contact = await json<{ id: string }>(
      await call("/v1/contacts", {
        method: "POST",
        key: ADMIN,
        json: { email: `blocks-${uid()}@example.net`, fields: { season: "spring" } },
      }),
    )
    const r = await json<{ html: string; text: string; footerAdded: boolean; links: Array<{ url: string }> }>(
      await call(`/v1/campaigns/${campaign.id}/render`, {
        method: "POST",
        key: ADMIN,
        json: { contactId: contact.id },
      }),
    )
    // No name on the contact: the fallback. The kit lays it out, and its own footer links to unsubscribe.
    expect(r.html).toContain("Hello there")
    expect(r.html).toContain("Our spring sale starts now.")
    expect(r.text).toContain("Our spring sale starts now.")
    expect(r.footerAdded).toBe(false)
    // The kit's font stylesheet is loaded, not clicked: not a link (HAL-3432).
    expect(r.html).toContain("fonts.googleapis.com")
    expect(r.links.map((l) => l.url)).toContain("https://ok.links.test/shop")
    expect(r.links.some((l) => l.url.includes("fonts.googleapis.com"))).toBe(false)
    const checks = await json<Checks>(await call(`/v1/campaigns/${campaign.id}/checks`, { key: ADMIN }))
    expect(checks.checks.find((x) => x.id === "link_domains")?.detail ?? "").not.toContain("googleapis")

    const refused = async (body: Record<string, unknown>) => {
      const res = await createCampaign({ name: "B", fromAddress: `team@${domain}`, subject: "S", ...body })
      return { status: res.status, field: res.body.field }
    }
    expect(await refused({ bodyBlocks: doc, bodyHtml: "<p>x</p>" })).toEqual({
      status: 400,
      field: "bodyBlocks",
    })
    // A section error names the block it's in, so the editor can mark it (HAL-3433).
    const sectionError = await call("/v1/campaigns", {
      method: "POST",
      key: ADMIN,
      json: {
        name: "B",
        fromAddress: `team@${domain}`,
        subject: "S",
        bodyBlocks: { ...doc, blocks: [...doc.blocks, { type: "note", text: "{{#if vip}}unclosed" }] },
      },
    })
    expect(sectionError.status).toBe(400)
    const section = await json<{ field: string; message: string }>(sectionError)
    expect(section.field).toBe("bodyBlocks.blocks[3].text")
    expect(section.message).toMatch(/^In blocks\[3\]\.text: Line 1: \{\{#if vip\}\}/)
    // In the footer, or in the subject, it says so too.
    expect(await refused({ bodyBlocks: { ...doc, footer: { reason: "{{/if}}" } } })).toEqual({
      status: 400,
      field: "bodyBlocks.footer.reason",
    })
    expect(await refused({ subject: "{{#each x}}", bodyBlocks: doc })).toEqual({
      status: 400,
      field: "subject",
    })
    // Not a block document at all: the schema refuses it.
    const malformed = await call("/v1/campaigns", {
      method: "POST",
      key: ADMIN,
      json: { name: "B", fromAddress: `team@${domain}`, subject: "S", bodyBlocks: { blocks: "nope" } },
    })
    expect(malformed.status).toBe(400)
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
      excluded: {
        blocked: 2,
        unsubscribed: 1,
        unconfirmed: 1,
        notOnTopic: 1,
        bySegment: [],
        recentlySent: 0,
      },
    })
  })

  it("leaves out excluded segments and the recently mailed, each counted once (HAL-3429)", async () => {
    const domain = await sendingDomain()
    const tag = uid()
    const make = async (i: number, fields: Record<string, unknown> = {}) => {
      const c = await json<{ id: string; email: string }>(
        await call("/v1/contacts", {
          method: "POST",
          key: ADMIN,
          json: { email: `x${i}-${tag}@example.net`, fields: { tag, ...fields } },
        }),
      )
      await env.DB.prepare("update contacts set status = 'subscribed' where id = ?").bind(c.id).run()
      return c
    }
    const plain = await make(1)
    const second = await make(2)
    await make(3, { vip: true })
    await make(4, { staff: true })
    // In both excluded segments: counted under the first.
    await make(5, { vip: true, staff: true })
    const mailed = await make(6)
    const unsubscribed = await make(7, { vip: true })
    await env.DB.prepare("update contacts set status = 'unsubscribed' where id = ?")
      .bind(unsubscribed.id)
      .run()
    const segment = async (name: string, filter: unknown) =>
      json<{ id: string }>(await call("/v1/segments", { method: "POST", key: ADMIN, json: { name, filter } }))
    const all = await segment(`All ${tag}`, { type: "field", field: "tag", op: "eq", value: tag })
    const vips = await segment(`VIP ${tag}`, { type: "field", field: "vip", op: "eq", value: true })
    const staffers = await segment(`Staff ${tag}`, { type: "field", field: "staff", op: "eq", value: true })
    // Another campaign mailed one contact two days ago, and another 40 days ago.
    const other = `cmp_other_${tag}`
    await env.DB.prepare(
      "insert into campaigns (id, name, status, from_address, subject) values (?, 'Other', 'sent', 'a@b.co', 'S')",
    )
      .bind(other)
      .run()
    const sentTo = (contactId: string, daysAgo: number, campaignId = other) =>
      env.DB.prepare(
        "insert into messages_out (id, stream, campaign_id, contact_id, recipient, sender, subject, status, created_at) values (?, 'campaign', ?, ?, 'r@x.co', 'a@b.co', 'S', 'delivered', ?)",
      )
        .bind(`msg_${uid()}`, campaignId, contactId, Date.now() - daysAgo * 86_400_000)
        .run()
    await sentTo(mailed.id, 2)
    await sentTo(plain.id, 40)

    const { body: campaign } = await createCampaign({
      name: "Ex",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      segmentId: all.id,
      exclude: { segmentIds: [vips.id, staffers.id], recentlySentDays: 7 },
    })
    expect(campaign).toMatchObject({ exclude: { segmentIds: [vips.id, staffers.id], recentlySentDays: 7 } })
    // This campaign's own mail (a test send) isn't "recently sent".
    await sentTo(second.id, 0, campaign.id as string)
    const preview = async (id: string) =>
      json<{
        matching: number
        sendable: number
        excluded: {
          bySegment: Array<{ segmentId: string; name: string; count: number }>
          recentlySent: number
        }
      }>(await call(`/v1/campaigns/${id}/audience/preview`, { method: "POST", key: ADMIN }))
    const p = await preview(campaign.id as string)
    expect(p).toMatchObject({ matching: 7, sendable: 2 })
    expect(p.excluded).toMatchObject({
      unsubscribed: 1,
      bySegment: [
        { segmentId: vips.id, name: `VIP ${tag}`, count: 2 },
        { segmentId: staffers.id, name: `Staff ${tag}`, count: 1 },
      ],
      recentlySent: 1,
    })

    // Widening the window to 60 days catches the contact mailed 40 days ago too.
    const patched = await call(`/v1/campaigns/${campaign.id}`, {
      method: "PATCH",
      key: ADMIN,
      json: { exclude: { segmentIds: [vips.id], recentlySentDays: 60 } },
    })
    expect(patched.status).toBe(200)
    expect((await preview(campaign.id as string)).excluded).toMatchObject({
      bySegment: [{ segmentId: vips.id, count: 2 }],
      recentlySent: 2,
    })
    // An exclusion that leaves nobody out is stored as none.
    const cleared = await json<{ exclude: unknown }>(
      await call(`/v1/campaigns/${campaign.id}`, {
        method: "PATCH",
        key: ADMIN,
        json: { exclude: { segmentIds: [], recentlySentDays: null } },
      }),
    )
    expect(cleared.exclude).toBeNull()

    const refused = async (exclude: unknown) => {
      const r = await call(`/v1/campaigns/${campaign.id}`, { method: "PATCH", key: ADMIN, json: { exclude } })
      return { status: r.status, field: (await json<{ field?: string }>(r)).field }
    }
    expect(await refused({ segmentIds: [all.id], recentlySentDays: null })).toEqual({
      status: 400,
      field: "exclude.segmentIds",
    })
    expect(await refused({ segmentIds: ["seg_nope"], recentlySentDays: null })).toMatchObject({ status: 400 })
    expect(await refused({ segmentIds: [], recentlySentDays: 91 })).toMatchObject({
      status: 400,
      field: "exclude.recentlySentDays",
    })
    expect(await refused({ segmentIds: [], recentlySentDays: 1.5 })).toMatchObject({ status: 400 })
    expect(
      await refused({ segmentIds: Array.from({ length: 11 }, (_, i) => `seg_${i}`), recentlySentDays: null }),
    ).toMatchObject({ status: 400, field: "exclude.segmentIds" })

    // A segment a campaign leaves out is in use: deleting it would widen the audience.
    await call(`/v1/campaigns/${campaign.id}`, {
      method: "PATCH",
      key: ADMIN,
      json: { exclude: { segmentIds: [staffers.id], recentlySentDays: null } },
    })
    const del = await call(`/v1/segments/${staffers.id}`, { method: "DELETE", key: ADMIN })
    expect(del.status).toBe(409)
    const seg = await json<{ usedBy: Array<{ id: string }> }>(
      await call(`/v1/segments/${staffers.id}`, { key: ADMIN }),
    )
    expect(seg.usedBy.map((u) => u.id)).toContain(campaign.id)
  })

  it("finds the recently mailed through messages_out(contact_id, created_at), not a scan", async () => {
    const { audienceSql } = await import("../../src/campaigns/audience.ts")
    const { runtimeFor } = await import("../../src/workers/inbound.ts")
    const a = await runtimeFor(env).runPromise(
      audienceSql({
        id: "cmp_x",
        segmentId: null,
        topicId: null,
        exclude: { segmentIds: [], recentlySentDays: 7 },
      }),
    )
    const plan = await env.DB.prepare(`explain query plan select id from contacts where ${a.where}`)
      .bind(...a.params)
      .all<{ detail: string }>()
    const details = plan.results.map((r) => r.detail)
    expect(details.join(" ")).toContain("messages_out_contact")
    expect(details.some((d) => /^SCAN m\b/.test(d))).toBe(false)
  })

  it("refuses exclusions too complex to run in one statement", async () => {
    const domain = await sendingDomain()
    const tag = uid()
    // Each segment binds 40 values; with two excluded the audience needs over 90 parameters.
    const wide = async (name: string) =>
      json<{ id: string }>(
        await call("/v1/segments", {
          method: "POST",
          key: ADMIN,
          json: {
            name,
            filter: {
              type: "field",
              field: "code",
              op: "in",
              value: Array.from({ length: 40 }, (_, i) => `${name}-${i}`),
            },
          },
        }),
      )
    const a = await wide(`a${tag}`)
    const b = await wide(`b${tag}`)
    const c = await wide(`c${tag}`)
    const r = await call("/v1/campaigns", {
      method: "POST",
      key: ADMIN,
      json: {
        name: "Too much",
        fromAddress: `news@${domain}`,
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        segmentId: a.id,
        exclude: { segmentIds: [b.id, c.id], recentlySentDays: null },
      },
    })
    expect(r.status).toBe(400)
    expect(await json<{ field: string }>(r)).toMatchObject({ field: "exclude" })
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

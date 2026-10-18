import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { goodDomain, installDohFixture, setDns } from "./dns.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
let rpcId = 0

type ToolResult = {
  isError?: boolean
  structuredContent: Record<string, unknown>
  content: Array<{ text: string }>
}

const tool = async (key: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await exports.default.fetch(
    new Request("https://mailyard.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  )
  const body = await json<{ result?: ToolResult; error?: { message: string } }>(res)
  if (!body.result) throw new Error(`no result for ${name}: ${JSON.stringify(body)}`)
  return body.result
}

describe("workspace MCP tools (HAL-3463)", () => {
  it("reads templates, renders one with data, and lists segments", async () => {
    const reader = (await createKey("secret", ["read"])).key
    const name = `Receipt ${uid()}`
    const template = await json<{ id: string }>(
      await call("/v1/templates", {
        method: "POST",
        key: ADMIN,
        json: {
          name,
          kind: "html",
          subject: "Thanks {{ name }}",
          source: "<p>Order {{ order }} for {{ name }}</p>",
        },
      }),
    )
    await call(`/v1/templates/${template.id}/publish`, { method: "POST", key: ADMIN, json: {} })
    const listed = await tool(reader, "list_templates")
    expect((listed.structuredContent.templates as Array<{ id: string }>).map((t) => t.id)).toContain(
      template.id,
    )
    const rendered = await tool(reader, "render_template", {
      template: name,
      data: { name: "Ada", order: "42" },
      version: "latest",
    })
    expect(rendered.isError).toBeFalsy()
    expect(rendered.structuredContent).toMatchObject({ subject: "Thanks Ada" })
    expect(String(rendered.structuredContent.html)).toContain("Order 42 for Ada")
    const missing = await tool(reader, "render_template", { template: `nope-${uid()}` })
    expect(missing.isError).toBe(true)

    await call("/v1/segments", {
      method: "POST",
      key: ADMIN,
      json: {
        name: `Seg ${uid()}`,
        filter: { type: "all", rules: [{ type: "field", field: "plan", op: "eq", value: "pro" }] },
      },
    })
    const segments = await tool(reader, "list_segments")
    expect((segments.structuredContent.segments as unknown[]).length).toBeGreaterThan(0)
  })

  it("reports a message's status and delivery trail, alerts, and contact search", async () => {
    const reader = (await createKey("secret", ["read"])).key
    const email = `status-${uid()}@example.net`
    const sent = await json<{ data: { emails: Array<{ email: string }> } }>(
      await call("/v1/send", {
        method: "POST",
        key: ADMIN,
        json: {
          to: email,
          subject: "Status check",
          body: "<p>Hi</p>",
          from: "hello@mailyard.test",
          name: "Grace Hopper",
        },
      }),
    )
    const messageId = sent.data.emails[0]?.email ?? ""
    const status = await tool(reader, "message_status", { messageId })
    expect(status.structuredContent.message).toMatchObject({
      id: messageId,
      recipient: email,
      subject: "Status check",
      stream: "transactional",
    })
    expect(Array.isArray(status.structuredContent.events)).toBe(true)
    expect((await tool(reader, "message_status", { messageId: "msg_nope" })).isError).toBe(true)

    const alerts = await tool(reader, "list_alerts", { status: "all" })
    expect(Array.isArray(alerts.structuredContent.alerts)).toBe(true)

    const found = await tool(reader, "search_contacts", { q: email.split("@")[0] ?? "" })
    expect((found.structuredContent.contacts as Array<{ email: string }>).map((c) => c.email)).toContain(
      email,
    )
  })

  it("previews a campaign schedule without confirm, schedules with it, and pauses the same way", async () => {
    const domain = `mcpcamp-${uid()}.test`
    setDns(goodDomain(domain))
    await call("/v1/domains", {
      method: "POST",
      key: ADMIN,
      json: { name: domain, sending: true, receiving: false },
    })
    const topic = await json<{ id: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name: `T ${uid()}`, doubleOptIn: false },
      }),
    )
    const campaign = await json<{ id: string }>(
      await call("/v1/campaigns", {
        method: "POST",
        key: ADMIN,
        json: {
          name: `MCP ${uid()}`,
          fromAddress: `news@${domain}`,
          subject: "Hi",
          bodyHtml: "<p>Hi</p>",
          topicId: topic.id,
        },
      }),
    )
    // One subscriber on the topic, so there's someone to send to.
    const subscriber = await json<{ id: string }>(
      await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: `sub-${uid()}@example.net` } }),
    )
    await call(`/v1/contacts/${subscriber.id}/topics/${topic.id}`, {
      method: "PUT",
      key: ADMIN,
      json: { state: "subscribed", confirmed: true },
    })
    const admin = (await createKey("secret", ["read", "send", "admin"])).key
    const preview = await tool(admin, "schedule_campaign", { campaignId: campaign.id })
    expect(preview.structuredContent.wouldSchedule).toMatchObject({
      campaign: { id: campaign.id, status: "draft" },
      recipients: 1,
    })
    expect(
      await env.DB.prepare("select status from campaigns where id = ?")
        .bind(campaign.id)
        .first<{ status: string }>(),
    ).toMatchObject({
      status: "draft",
    })
    const sendAt = Date.now() + 86_400_000
    const scheduled = await tool(admin, "schedule_campaign", {
      campaignId: campaign.id,
      sendAt,
      confirm: true,
    })
    expect(scheduled.isError).toBeFalsy()
    expect(
      (
        await env.DB.prepare("select status from campaigns where id = ?")
          .bind(campaign.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("scheduled")
    const pausePreview = await tool(admin, "pause_campaign", { campaignId: campaign.id })
    expect(pausePreview.structuredContent.wouldPause).toMatchObject({ status: "scheduled" })
    const paused = await tool(admin, "pause_campaign", { campaignId: campaign.id, confirm: true })
    expect(paused.isError).toBeFalsy()
    expect(
      (
        await env.DB.prepare("select status from campaigns where id = ?")
          .bind(campaign.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("paused")
    // A key without the admin scope doesn't get these tools at all.
    const sender = (await createKey("secret", ["read", "send"])).key
    const refused = await tool(sender, "schedule_campaign", { campaignId: campaign.id })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('"admin" scope')
  })

  it("adds and updates contacts, unsubscribes them, and adds them to topics", async () => {
    const admin = (await createKey("secret", ["read", "admin"])).key
    const email = `aud-${uid()}@example.net`
    const added = await tool(admin, "add_or_update_contact", { email, name: "Ada", data: { plan: "team" } })
    expect(added.structuredContent).toMatchObject({
      created: true,
      contact: { email, name: "Ada", status: "subscribed" },
    })
    const updated = await tool(admin, "add_or_update_contact", { email: email.toUpperCase(), name: "Ada L." })
    expect(updated.structuredContent).toMatchObject({ created: false, contact: { name: "Ada L." } })

    const topic = await json<{ id: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name: `Topic ${uid()}`, doubleOptIn: false },
      }),
    )
    const joined = await tool(admin, "add_to_topic", { email, topicId: topic.id })
    expect(joined.structuredContent).toMatchObject({ state: "subscribed" })
    const left = await tool(admin, "unsubscribe_contact", { email, topicId: topic.id })
    const topics = (left.structuredContent.contact as { topics: Array<{ topicId: string; state: string }> })
      .topics
    expect(topics.find((t) => t.topicId === topic.id)?.state).toBe("unsubscribed")
    const out = await tool(admin, "unsubscribe_contact", { email })
    expect(out.structuredContent).toMatchObject({ contact: { status: "unsubscribed" } })
    expect((await tool(admin, "unsubscribe_contact", { email: `nobody-${uid()}@example.net` })).isError).toBe(
      true,
    )

    // A new address added to a topic arrives unconfirmed overall, subscribed on the topic.
    const fresh = `fresh-${uid()}@example.net`
    const freshJoin = await tool(admin, "add_to_topic", { email: fresh, topicId: topic.id })
    expect(freshJoin.structuredContent).toMatchObject({ state: "subscribed" })

    // A read key can't write contacts.
    const reader = (await createKey("secret", ["read"])).key
    expect((await tool(reader, "add_or_update_contact", { email: `r-${uid()}@example.net` })).isError).toBe(
      true,
    )
  })
})

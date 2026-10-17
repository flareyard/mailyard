import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

const call = (path: string) => exports.default.fetch(new Request(`https://mailyard.test${path}`))

describe("GET /healthz", () => {
  it("answers 200 with the app, version and a reachable database", async () => {
    const response = await call("/healthz")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "ok",
      app: "mailyard",
      version: "0.1.0",
      database: "ok",
    })
  })
})

describe("D1 schema", () => {
  it("has every table from the data model after migrations", async () => {
    const { results } = await env.DB.prepare(
      "select name from sqlite_master where type = 'table' and name not like '\\_%' escape '\\' and name not like 'sqlite%' and name != 'd1_migrations' order by name",
    ).all<{ name: string }>()
    expect(results.map((r) => r.name)).toEqual([
      "alerts",
      "api_keys",
      "audit",
      "auto_replies",
      "automation_runs",
      "automations",
      "campaign_links",
      "campaigns",
      "contacts",
      "daily_stats",
      "domains",
      "events",
      "forms",
      "idempotency_keys",
      "inbound_messages",
      "mailbox_exports",
      "mailbox_imports",
      "mailbox_members",
      "mailbox_rules",
      "mailbox_senders",
      "mailboxes",
      "messages_out",
      "processed_events",
      "segments",
      "settings",
      "subscription_changes",
      "subscriptions",
      "suppressions",
      "template_versions",
      "templates",
      "topics",
      "webhook_deliveries",
      "webhook_endpoints",
    ])
  })
})

describe("GET /openapi.json", () => {
  it("publishes the API contract", async () => {
    const response = await call("/openapi.json")
    expect(response.status).toBe(200)
    const doc = (await response.json()) as { info: { title: string }; paths: Record<string, unknown> }
    expect(doc.info.title).toBe("Mailyard API")
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/healthz",
      "/v1/alerts",
      "/v1/alerts/{id}/resolve",
      "/v1/api-keys",
      "/v1/api-keys/{id}",
      "/v1/campaigns",
      "/v1/campaigns/{id}",
      "/v1/campaigns/{id}/audience/preview",
      "/v1/campaigns/{id}/cancel",
      "/v1/campaigns/{id}/checks",
      "/v1/campaigns/{id}/pace",
      "/v1/campaigns/{id}/pause",
      "/v1/campaigns/{id}/recipients",
      "/v1/campaigns/{id}/render",
      "/v1/campaigns/{id}/report",
      "/v1/campaigns/{id}/resend-non-openers",
      "/v1/campaigns/{id}/resume",
      "/v1/campaigns/{id}/schedule",
      "/v1/campaigns/{id}/test",
      "/v1/contacts",
      "/v1/contacts/bulk",
      "/v1/contacts/{id}",
      "/v1/contacts/{id}/erase",
      "/v1/contacts/{id}/export",
      "/v1/contacts/{id}/preferences-link",
      "/v1/contacts/{id}/timeline",
      "/v1/contacts/{id}/topics/{topicId}",
      "/v1/domains",
      "/v1/domains/{id}",
      "/v1/domains/{id}/recheck",
      "/v1/forms",
      "/v1/forms/{id}",
      "/v1/health",
      "/v1/identities",
      "/v1/inbound",
      "/v1/inbound/{id}",
      "/v1/inbound/{id}/reprocess",
      "/v1/mailboxes",
      "/v1/mailboxes/{id}",
      "/v1/mailboxes/{id}/drafts",
      "/v1/mailboxes/{id}/drafts/{draftId}",
      "/v1/mailboxes/{id}/drafts/{draftId}/cancel",
      "/v1/mailboxes/{id}/drafts/{draftId}/send",
      "/v1/mailboxes/{id}/exports",
      "/v1/mailboxes/{id}/exports/{exportId}",
      "/v1/mailboxes/{id}/folders",
      "/v1/mailboxes/{id}/folders/{folder}/empty",
      "/v1/mailboxes/{id}/imports",
      "/v1/mailboxes/{id}/imports/{importId}",
      "/v1/mailboxes/{id}/imports/{importId}/cancel",
      "/v1/mailboxes/{id}/labels",
      "/v1/mailboxes/{id}/labels/{labelId}",
      "/v1/mailboxes/{id}/members",
      "/v1/mailboxes/{id}/messages/{messageId}",
      "/v1/mailboxes/{id}/rules",
      "/v1/mailboxes/{id}/rules/order",
      "/v1/mailboxes/{id}/rules/test",
      "/v1/mailboxes/{id}/rules/{ruleId}",
      "/v1/mailboxes/{id}/search",
      "/v1/mailboxes/{id}/senders",
      "/v1/mailboxes/{id}/senders/{value}",
      "/v1/mailboxes/{id}/threads",
      "/v1/mailboxes/{id}/threads/bulk",
      "/v1/mailboxes/{id}/threads/{threadId}",
      "/v1/messages",
      "/v1/messages/{id}",
      "/v1/reputation",
      "/v1/segments",
      "/v1/segments/preview",
      "/v1/segments/{id}",
      "/v1/send",
      "/v1/sending/governor",
      "/v1/settings/brand",
      "/v1/settings/compliance",
      "/v1/settings/sending",
      "/v1/stats/delivery",
      "/v1/stats/providers",
      "/v1/stats/volume",
      "/v1/templates",
      "/v1/templates/preview",
      "/v1/templates/{id}",
      "/v1/templates/{id}/draft",
      "/v1/templates/{id}/publish",
      "/v1/templates/{id}/render",
      "/v1/templates/{id}/rollback",
      "/v1/topics",
      "/v1/topics/{id}",
      "/v1/track",
      "/v1/usage",
      "/v1/usage/forecast",
      "/v1/webhooks",
      "/v1/webhooks/{id}",
      "/v1/webhooks/{id}/deliveries",
      "/v1/webhooks/{id}/deliveries/{deliveryId}/replay",
      "/v1/webhooks/{id}/rotate-secret",
      "/v1/webhooks/{id}/test",
    ])
  })

  it("matches the committed contract, so any API change shows up in review", async () => {
    const doc = await (await call("/openapi.json")).json()
    expect(doc).toMatchSnapshot()
  })
})

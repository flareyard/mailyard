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
      "api_keys",
      "audit",
      "automation_runs",
      "automations",
      "campaigns",
      "contacts",
      "daily_stats",
      "domains",
      "events",
      "idempotency_keys",
      "inbound_messages",
      "mailbox_exports",
      "mailbox_members",
      "mailboxes",
      "messages_out",
      "processed_events",
      "segments",
      "settings",
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
      "/v1/api-keys",
      "/v1/api-keys/{id}",
      "/v1/domains",
      "/v1/domains/{id}",
      "/v1/domains/{id}/recheck",
      "/v1/health",
      "/v1/identities",
      "/v1/inbound",
      "/v1/inbound/{id}",
      "/v1/inbound/{id}/reprocess",
      "/v1/mailboxes",
      "/v1/mailboxes/{id}",
      "/v1/mailboxes/{id}/members",
      "/v1/messages",
      "/v1/messages/{id}",
      "/v1/reputation",
      "/v1/send",
      "/v1/settings/brand",
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

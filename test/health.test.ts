import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

const call = (path: string) => exports.default.fetch(new Request(`https://mailflare.test${path}`))

describe("GET /healthz", () => {
  it("answers 200 with the app, version and a reachable database", async () => {
    const response = await call("/healthz")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "ok",
      app: "mailflare",
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
      "mailboxes",
      "messages_out",
      "processed_events",
      "segments",
      "subscriptions",
      "suppressions",
      "templates",
      "topics",
    ])
  })
})

describe("GET /openapi.json", () => {
  it("publishes the API contract", async () => {
    const response = await call("/openapi.json")
    expect(response.status).toBe(200)
    const doc = (await response.json()) as { info: { title: string }; paths: Record<string, unknown> }
    expect(doc.info.title).toBe("Mailflare API")
    expect(Object.keys(doc.paths)).toContain("/healthz")
  })
})

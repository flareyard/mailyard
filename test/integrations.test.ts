import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { goodDomain, installDohFixture, setDns } from "./dns.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)

type Integrations = {
  mcp: {
    endpoint: string | null
    keyCount: number
    agentCount: number
    lastUsedAt: number | null
    keys: Array<{
      id: string
      name: string
      prefix: string
      scopes: string[]
      agent: { id: string; name: string; mailboxId: string; address: string | null } | null
    }> | null
  }
  webhooks: {
    count: number
    enabled: number
    paused: number
    failing: number
    deadLetters: number
    held: number
    failingEndpoints: Array<{ id: string; deadLetters: number }>
  }
  hermes: { connected: boolean; lane: string | null; mailboxes: string[]; since: number | null }
  siblings: Array<{ app: string; connected: boolean; keyId: string | null; via: string }>
}
const integrations = (key = ADMIN) => call("/v1/integrations", { key })

const mcpKey = async (name: string) => {
  const r = await call("/v1/api-keys", {
    method: "POST",
    key: ADMIN,
    json: { name, kind: "secret", scopes: ["read", "send"], purpose: "mcp" },
  })
  expect(r.status).toBe(200)
  return json<{ key: string; apiKey: { id: string } }>(r)
}

const hook = async (body: Record<string, unknown> = {}) => {
  const r = await call("/v1/webhooks", {
    method: "POST",
    key: ADMIN,
    json: { url: `https://hooks.test/${uid()}`, events: ["contact.created"], ...body },
  })
  expect(r.status).toBe(200)
  return (await json<{ endpoint: { id: string } }>(r)).endpoint.id
}

describe("GET /v1/integrations (HAL-3466)", () => {
  it("lists MCP keys with their agents, and finds Support Inbox by its key", async () => {
    const before = await json<Integrations>(await integrations())
    expect(before.hermes).toEqual({ connected: false, lane: null, mailboxes: [], since: null })
    expect(before.siblings.find((s) => s.app === "support-inbox")).toMatchObject({
      connected: false,
      via: "mcp",
    })

    const plain = await mcpKey(`Claude ${uid()}`)
    const support = await mcpKey(`Support inbox ${uid()}`)
    // An api-purpose key is not an integration.
    const api = await createKey("secret")

    const domain = `int-${uid()}.test`
    setDns(goodDomain(domain))
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const agentRes = await call("/v1/agents", {
      method: "POST",
      key: ADMIN,
      json: { name: `Bot ${uid()}`, address: `bot@${domain}` },
    })
    expect(agentRes.status).toBe(200)
    const { agent } = await json<{ agent: { id: string; key: { id: string }; mailbox: { id: string } } }>(
      agentRes,
    )

    const after = await json<Integrations>(await integrations())
    expect(after.mcp.endpoint).toMatch(/\/mcp$/)
    expect(after.mcp.keyCount).toBe(before.mcp.keyCount + 3)
    expect(after.mcp.agentCount).toBe(before.mcp.agentCount + 1)
    const ids = after.mcp.keys?.map((k) => k.id) ?? []
    expect(ids).toEqual(expect.arrayContaining([plain.apiKey.id, support.apiKey.id, agent.key.id]))
    expect(ids).not.toContain(api.apiKey.id)
    const agentKey = after.mcp.keys?.find((k) => k.id === agent.key.id)
    expect(agentKey?.agent).toMatchObject({
      id: agent.id,
      mailboxId: agent.mailbox.id,
      address: `bot@${domain}`,
    })
    expect(after.mcp.keys?.find((k) => k.id === plain.apiKey.id)).toMatchObject({
      agent: null,
      scopes: ["read", "send"],
    })
    expect(after.siblings.find((s) => s.app === "support-inbox")).toMatchObject({ connected: true })

    // A revoked key drops out.
    await call(`/v1/api-keys/${plain.apiKey.id}`, { method: "DELETE", key: ADMIN })
    const revoked = await json<Integrations>(await integrations())
    expect(revoked.mcp.keys?.map((k) => k.id)).not.toContain(plain.apiKey.id)
  })

  it("counts webhook endpoints that are paused, failing or holding deliveries", async () => {
    const before = await json<Integrations>(await integrations())
    const ok = await hook()
    const paused = await hook({ paused: true })
    const broken = await hook()
    await env.DB.prepare(
      "insert into webhook_deliveries (id, endpoint_id, event_id, event_type, payload, status, attempts, created_at) values (?, ?, ?, 'contact.created', '{}', 'dead', 8, ?)",
    )
      .bind(`whd_${uid()}${uid()}`, broken, `evt_${uid()}`, Date.now())
      .run()
    await env.DB.prepare("update webhook_endpoints set last_failure_at = ? where id = ?")
      .bind(Date.now(), broken)
      .run()

    const after = await json<Integrations>(await integrations())
    expect(after.webhooks.count).toBe(before.webhooks.count + 3)
    expect(after.webhooks.paused).toBe(before.webhooks.paused + 1)
    expect(after.webhooks.failing).toBe(before.webhooks.failing + 1)
    expect(after.webhooks.deadLetters).toBe(before.webhooks.deadLetters + 1)
    expect(after.webhooks.failingEndpoints.map((e) => e.id)).toContain(broken)
    expect(after.webhooks.failingEndpoints.map((e) => e.id)).not.toContain(ok)
    expect(after.webhooks.failingEndpoints.map((e) => e.id)).not.toContain(paused)
  })

  it("shows counts but not keys to a caller who can't manage keys", async () => {
    await mcpKey(`Reader sees ${uid()}`)
    const reader = await createKey("secret", ["read"])
    const res = await integrations(reader.key)
    expect(res.status).toBe(200)
    const body = await json<Integrations>(res)
    expect(body.mcp.keys).toBeNull()
    expect(body.mcp.keyCount).toBeGreaterThan(0)
    expect(body.siblings.every((s) => s.keyId === null)).toBe(true)

    const pub = await createKey("public")
    expect((await integrations(pub.key)).status).toBe(403)
  })
})

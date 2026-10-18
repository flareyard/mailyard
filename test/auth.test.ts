import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { ADMIN, call, createKey, json } from "./helpers.ts"

type Refusal = {
  _tag: string
  reason?: string
  revokedAt?: number
  required?: string
  scopes?: string[]
  requestId?: string
}

describe("auth refusals", () => {
  it("says why a key was refused: missing, not a key, unknown, revoked", async () => {
    const refused = async (key?: string) => {
      const res = await call("/v1/contacts", key === undefined ? {} : { key })
      expect(res.status).toBe(401)
      return json<Refusal>(res)
    }
    expect((await refused()).reason).toBe("missing")
    expect(await refused("hello")).toMatchObject({ _tag: "Unauthorized", reason: "format" })
    expect(await refused(`sk_${"x".repeat(32)}`)).toMatchObject({ reason: "unknown" })
    const { key, apiKey } = await createKey("secret")
    expect((await call(`/v1/api-keys/${apiKey.id}`, { method: "DELETE", key: ADMIN })).status).toBe(200)
    const revoked = await refused(key)
    expect(revoked.reason).toBe("revoked")
    expect(revoked.revokedAt).toBeGreaterThan(Date.now() - 60_000)
  })

  it("says why a key can't do something: a public key, or a missing scope", async () => {
    const pk = (await createKey("public")).key
    const publicRefusal = await call("/v1/contacts", { key: pk })
    expect(publicRefusal.status).toBe(403)
    expect(await json<Refusal>(publicRefusal)).toMatchObject({
      reason: "public-key",
      required: "read",
      scopes: ["track"],
    })
    const reader = (await createKey("secret", ["read"])).key
    const scopeRefusal = await call("/v1/api-keys", {
      method: "POST",
      key: reader,
      json: { name: "x", kind: "secret" },
    })
    expect(scopeRefusal.status).toBe(403)
    expect(await json<Refusal>(scopeRefusal)).toMatchObject({
      reason: "insufficient-scope",
      required: "admin",
      scopes: ["read"],
    })
  })

  it("puts a request id on every response and in every error body", async () => {
    const ok = await call("/healthz")
    expect(ok.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
    const ray = await call("/v1/contacts", { headers: { "cf-ray": "8f1e2d3c4b5a6978-LIS" } })
    expect(ray.headers.get("x-request-id")).toBe("8f1e2d3c4b5a6978-LIS")
    expect((await json<Refusal>(ray)).requestId).toBe("8f1e2d3c4b5a6978-LIS")
    // The raw routes' errors too.
    const raw = await call("/v1/uploads?filename=x.csv", { method: "POST", body: "a" })
    const body = await json<{ error: { reason: string }; requestId: string }>(raw)
    expect(body.error.reason).toBe("missing")
    expect(body.requestId).toBe(raw.headers.get("x-request-id"))
  })

  it("slows down an address that keeps failing", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 20}`
    const statuses: Array<number> = []
    for (let i = 0; i < 25; i++)
      statuses.push(
        (await call("/v1/contacts", { key: `sk_wrong${i}`, headers: { "cf-connecting-ip": ip } })).status,
      )
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(20)).toContain(429)
    const limited = await call("/v1/contacts", { key: "sk_wrong", headers: { "cf-connecting-ip": ip } })
    expect(await json(limited)).toMatchObject({ _tag: "RateLimited", retryAfter: 60 })
    // A good key from the same address still works.
    expect((await call("/v1/contacts", { key: ADMIN, headers: { "cf-connecting-ip": ip } })).status).toBe(200)
  })
})

describe("key purpose (HAL-3410)", () => {
  type Key = { id: string; kind: string; purpose: string }
  const create = (body: Record<string, unknown>) =>
    call("/v1/api-keys", { method: "POST", key: ADMIN, json: { name: "Agent", kind: "secret", ...body } })
  const list = async (query = "") =>
    (await json<{ keys: Array<Key> }>(await call(`/v1/api-keys${query}`, { key: ADMIN }))).keys

  it("defaults to api, takes mcp on create, and filters the list by it", async () => {
    const plain = await json<{ key: string; apiKey: Key }>(await create({}))
    expect(plain.apiKey.purpose).toBe("api")
    const agent = await json<{ key: string; apiKey: Key }>(await create({ purpose: "mcp", scopes: ["read"] }))
    expect(agent.apiKey.purpose).toBe("mcp")

    const agents = await list("?purpose=mcp")
    expect(agents.map((k) => k.id)).toContain(agent.apiKey.id)
    expect(agents.every((k) => k.purpose === "mcp")).toBe(true)
    const apis = await list("?purpose=api")
    expect(apis.map((k) => k.id)).toContain(plain.apiKey.id)
    expect(apis.map((k) => k.id)).not.toContain(agent.apiKey.id)
    expect((await list()).map((k) => k.id)).toEqual(
      expect.arrayContaining([plain.apiKey.id, agent.apiKey.id]),
    )
    expect((await call("/v1/api-keys?purpose=bot", { key: ADMIN })).status).toBe(400)

    // A label, not a permission: an api key still reaches /mcp, and revoking an agent's key works as any other.
    const mcp = (key: string) =>
      call("/mcp", {
        method: "POST",
        key,
        headers: { accept: "application/json, text/event-stream" },
        json: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      })
    expect((await mcp(plain.key)).status).toBe(200)
    expect((await mcp(agent.key)).status).toBe(200)
    const revoked = await call(`/v1/api-keys/${agent.apiKey.id}`, { method: "DELETE", key: ADMIN })
    expect((await json<Key>(revoked)).purpose).toBe("mcp")
  })

  it("refuses an mcp public key, and old rows read as api", async () => {
    const res = await create({ kind: "public", purpose: "mcp" })
    expect(res.status).toBe(400)
    expect(await json<{ field: string }>(res)).toMatchObject({ field: "purpose" })
    // A key written before the column existed takes the column's default.
    await env.DB.prepare(
      "insert into api_keys (id, name, kind, prefix, hash, scopes, created_at) values ('k_old', 'Old', 'secret', 'sk_old', 'h_old', '[\"read\"]', ?)",
    )
      .bind(Date.now())
      .run()
    expect((await list("?purpose=api")).find((k) => k.id === "k_old")?.purpose).toBe("api")
  })
})

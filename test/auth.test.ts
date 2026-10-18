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

describe("key usage and rotation (HAL-3414)", () => {
  type Key = { id: string; requests24h?: number; revokedAt: number | null; scopes: string[]; purpose: string }
  const keys = async (query = "?include=usage") =>
    (await json<{ keys: Array<Key> }>(await call(`/v1/api-keys${query}`, { key: ADMIN }))).keys

  it("counts each key's requests in the last 24 hours, only when asked", async () => {
    const { key, apiKey } = await createKey("secret", ["read"])
    for (let i = 0; i < 3; i++) expect((await call("/v1/contacts", { key })).status).toBe(200)
    expect((await keys()).find((k) => k.id === apiKey.id)?.requests24h).toBe(3)
    expect((await keys("")).find((k) => k.id === apiKey.id)?.requests24h).toBeUndefined()
    // An hour from yesterday's window drops out; one from 30-odd days ago is pruned by the cron.
    const hour = Math.floor(Date.now() / 3_600_000)
    await env.DB.prepare("insert into api_key_usage (key_id, hour, requests) values (?, ?, 5), (?, ?, 7)")
      .bind(apiKey.id, hour - 24, apiKey.id, hour - 31 * 24)
      .run()
    expect((await keys()).find((k) => k.id === apiKey.id)?.requests24h).toBe(3)
    const { runtimeFor } = await import("../src/workers/inbound.ts")
    const { pruneKeyUsage } = await import("../src/domain/apiKeys.ts")
    await runtimeFor(env).runPromise(pruneKeyUsage())
    const left = await env.DB.prepare("select count(*) as n from api_key_usage where key_id = ?")
      .bind(apiKey.id)
      .first<{ n: number }>()
    expect(left?.n).toBe(2)
    // Reads at most 24 rows a key, from the (key, hour) primary key.
    const plan = await env.DB.prepare(
      "explain query plan select key_id, sum(requests) from api_key_usage where key_id in (?, ?) and hour >= ? group by key_id",
    )
      .bind("a", "b", hour - 23)
      .all<{ detail: string }>()
    expect(plan.results.map((r) => r.detail).join(" | ")).toMatch(
      /SEARCH api_key_usage USING (COVERING )?INDEX sqlite_autoindex_api_key_usage_1 \(key_id=\? AND hour>\?\)/,
    )
  })

  it("rotates a key: same scopes, purpose and mailboxes; the old one works through its grace period", async () => {
    const created = await json<{ key: string; apiKey: Key }>(
      await call("/v1/api-keys", {
        method: "POST",
        key: ADMIN,
        json: { name: "Deploy", kind: "secret", scopes: ["read", "send"], purpose: "mcp" },
      }),
    )
    const domain = `rot-${crypto.randomUUID().slice(0, 6)}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const mailbox = await json<{ id: string }>(
      await call("/v1/mailboxes", {
        method: "POST",
        key: ADMIN,
        json: { address: `sam@${domain}`, kind: "user" },
      }),
    )
    const shared = await call(`/v1/mailboxes/${mailbox.id}/members`, {
      method: "PUT",
      key: ADMIN,
      json: { members: [{ apiKeyId: created.apiKey.id, role: "member" }] },
    })
    expect(shared.status).toBe(200)

    const rotated = await json<{ key: string; apiKey: Key; previous: { id: string; revokedAt: number } }>(
      await call(`/v1/api-keys/${created.apiKey.id}/rotate`, {
        method: "POST",
        key: ADMIN,
        json: { graceSeconds: 3600 },
      }),
    )
    expect(rotated.apiKey.id).not.toBe(created.apiKey.id)
    expect(rotated.apiKey).toMatchObject({ scopes: ["read", "send"], purpose: "mcp", revokedAt: null })
    expect(rotated.previous.id).toBe(created.apiKey.id)
    expect(rotated.previous.revokedAt).toBeGreaterThan(Date.now() + 3500_000)
    // Both work during the grace period.
    expect((await call("/v1/contacts", { key: created.key })).status).toBe(200)
    expect((await call("/v1/contacts", { key: rotated.key })).status).toBe(200)
    {
      const members = await env.DB.prepare(
        "select api_key_id, role from mailbox_members where mailbox_id = ?",
      )
        .bind(mailbox.id)
        .all<{ api_key_id: string; role: string }>()
      expect(members.results.map((m) => m.api_key_id).sort()).toEqual(
        [created.apiKey.id, rotated.apiKey.id].sort(),
      )
    }
    // When the grace period is over, the old key is revoked.
    await env.DB.prepare("update api_keys set revoked_at = ? where id = ?")
      .bind(Date.now() - 1, created.apiKey.id)
      .run()
    const refused = await call("/v1/contacts", { key: created.key })
    expect(refused.status).toBe(401)
    expect(await json<{ reason: string }>(refused)).toMatchObject({ reason: "revoked" })
    // A revoked key can't be rotated again, and the grace period is capped at a week.
    expect(
      (await call(`/v1/api-keys/${created.apiKey.id}/rotate`, { method: "POST", key: ADMIN, json: {} }))
        .status,
    ).toBe(404)
    expect(
      (
        await call(`/v1/api-keys/${rotated.apiKey.id}/rotate`, {
          method: "POST",
          key: ADMIN,
          json: { graceSeconds: 700_000 },
        })
      ).status,
    ).toBe(400)
  })

  it("rotates with no grace period by default: the old key stops at once", async () => {
    const { key, apiKey } = await createKey("secret", ["read"])
    const rotated = await json<{ key: string }>(
      await call(`/v1/api-keys/${apiKey.id}/rotate`, { method: "POST", key: ADMIN, json: {} }),
    )
    expect((await call("/v1/contacts", { key })).status).toBe(401)
    expect((await call("/v1/contacts", { key: rotated.key })).status).toBe(200)
  })
})

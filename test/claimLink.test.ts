import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { sha256 } from "../src/domain/crypto.ts"
import { json } from "./helpers.ts"

/**
 * HAL-3587: a self-deployed Mailyard is claimed with the one-time link `bun run deploy` prints, not
 * an admin key. The deploy script stores the token's SHA-256 under settings "claim"; this is that row.
 */
const ORIGIN = "https://mailyard.test"
const COOKIE = "__Host-mailyard_session"

const openClaim = async (token: string, updatedAt = Date.now()) =>
  env.DB.prepare(
    "insert into settings (key, value, updated_at) values ('claim', ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(JSON.stringify({ tokenHash: await sha256(token), createdAt: updatedAt }), updatedAt)
    .run()

const claim = (body: Record<string, string>) =>
  exports.default.fetch(
    new Request(`${ORIGIN}/v1/workspace/claim/link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  )

const claimRow = () =>
  env.DB.prepare("select value from settings where key = 'claim'").first<{ value: string }>()

describe("claiming a self-deployed workspace with the claim link (HAL-3587)", () => {
  it("refuses a wrong token or a typo without spending the link, then claims as owner and signs in, once", async () => {
    const token = `claim-${crypto.randomUUID()}`
    await openClaim(token)
    const who = { workspaceName: "Acme", name: "Ada Lovelace", email: "ada@acme.test" }

    const wrong = await claim({ ...who, claimToken: "not-it" })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ field: "claimToken" })
    const typo = await claim({ ...who, email: "not-an-email", claimToken: token })
    expect(typo.status).toBe(400)
    expect(await claimRow()).not.toBeNull()

    const ok = await claim({ ...who, claimToken: token })
    expect(ok.status).toBe(200)
    const me = await json<{
      user: { email: string }
      role: string
      workspace: { name: string; claimed: boolean }
    }>(ok)
    expect(me).toMatchObject({
      user: { email: "ada@acme.test" },
      role: "owner",
      workspace: { name: "Acme", claimed: true },
    })
    expect(ok.headers.get("set-cookie")).toContain(`${COOKIE}=`)
    // The link is spent, and the workspace can't be claimed again, with it or a new one.
    expect(await claimRow()).toBeNull()
    const again = await claim({ ...who, claimToken: token })
    expect(again.status).toBe(409)
    const refusal = await again.json()
    expect(refusal).toMatchObject({ reason: "already-claimed" })
    expect(refusal).not.toHaveProperty("claimedBy")
    expect(refusal).not.toHaveProperty("claimedAt")
    await openClaim("another-token")
    expect((await claim({ ...who, claimToken: "another-token" })).status).toBe(409)
    const audit = await env.DB.prepare("select action from audit where action = 'workspace.claim'").all()
    expect(audit.results.length).toBeGreaterThanOrEqual(1)
  })

  it("refuses a claim posted from another site", async () => {
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/v1/workspace/claim/link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ claimToken: "x", workspaceName: "W", name: "N", email: "n@x.test" }),
      }),
    )
    expect(res.status).toBe(403)
  })
})

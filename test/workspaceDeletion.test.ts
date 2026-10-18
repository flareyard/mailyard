import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { sendTransactional } from "../src/domain/outbox.ts"
import { forgetDeletionCache } from "../src/domain/workspaceDeletion.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

const run = <A>(effect: unknown) => runtimeFor(env).runPromise(effect as never) as Promise<A>

type Deletion = { requestedAt: number; requestedBy: string; deletesAt: number; exportId: string }

const workspaceName = async () =>
  (await json<{ workspace: { name: string } }>(await call("/v1/me", { key: ADMIN }))).workspace.name

const del = (confirm: string, key = ADMIN) =>
  call("/v1/workspace", { method: "DELETE", key, json: { confirm } })

describe("deleting the workspace (HAL-3448)", () => {
  it("needs the exact name, and only the owner (the admin key while unclaimed)", async () => {
    const adminScoped = (await createKey("secret", ["read", "send", "admin"])).key
    const name = await workspaceName()
    const notRoot = await del(name, adminScoped)
    expect(notRoot.status).toBe(403)
    const wrong = await del(`${name} `)
    expect(wrong.status).toBe(400)
    expect(await json(wrong)).toMatchObject({ _tag: "InvalidRequest", field: "confirm" })
    expect(await json(await call("/v1/workspace/deletion", { key: ADMIN }))).toMatchObject({ status: "none" })
  })

  it("schedules it 7 days out with an export, stops sending, keeps a header on every answer, and restores", async () => {
    const before = Date.now()
    const res = await del(await workspaceName())
    expect(res.status).toBe(202)
    const deletion = await json<Deletion>(res)
    expect(deletion.requestedBy).toBe("root")
    expect(deletion.deletesAt - deletion.requestedAt).toBe(7 * 86_400_000)
    expect(deletion.requestedAt).toBeGreaterThanOrEqual(before)
    // The export started with it.
    const exported = await json<{ id: string; kind: string }>(
      await call(`/v1/exports/${deletion.exportId}`, { key: ADMIN }),
    )
    expect(exported).toMatchObject({ id: deletion.exportId, kind: "workspace" })
    // Twice is refused.
    const again = await del(await workspaceName())
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ reason: "already-deleting" })

    // Every answer says when; sending is refused; reading still works.
    const health = await call("/healthz")
    expect(health.headers.get("x-workspace-deleting")).toBe(new Date(deletion.deletesAt).toISOString())
    const send = await call("/v1/send", {
      method: "POST",
      key: ADMIN,
      json: { to: "someone@example.net", subject: "Hi", body: "<p>Hi</p>", from: "a@example.com" },
    })
    expect(send.status).toBe(409)
    expect(await json(send)).toMatchObject({ reason: "workspace-deleting", deletesAt: deletion.deletesAt })
    expect((await call("/v1/contacts", { key: ADMIN })).status).toBe(200)
    expect(await json(await call("/v1/workspace/deletion", { key: ADMIN }))).toMatchObject({
      status: "scheduled",
      deletion: { exportId: deletion.exportId },
      files: [],
    })
    // Sends that don't come through the API (automations, queued mail) are recorded as refused.
    const direct = await run<{ results: Array<{ status: string }> }>(
      sendTransactional({
        recipients: [{ email: `direct-${crypto.randomUUID().slice(0, 6)}@example.net` }],
        subject: "Hi",
        body: "<p>Hi</p>",
        from: { email: "a@example.com" },
        apiKeyId: "test",
      }),
    )
    expect(JSON.stringify(direct)).toContain('"rejected"')

    // Restoring calls it off; sending is back.
    const restored = await call("/v1/workspace/restore", { method: "POST", key: ADMIN })
    expect(restored.status).toBe(200)
    expect(await json(restored)).toEqual({ restored: true })
    expect((await call("/healthz")).headers.get("x-workspace-deleting")).toBeNull()
    const sendAgain = await call("/v1/send", {
      method: "POST",
      key: ADMIN,
      json: { to: "someone@example.net", subject: "Hi", body: "<p>Hi</p>", from: "a@example.com" },
    })
    expect(sendAgain.status).not.toBe(409)
    const twice = await call("/v1/workspace/restore", { method: "POST", key: ADMIN })
    expect(await json(twice)).toMatchObject({ reason: "not-deleting" })
    const audit = await env.DB.prepare(
      "select action from audit where action like 'workspace.delete.%' order by at",
    ).all<{ action: string }>()
    expect(audit.results.map((r) => r.action)).toEqual([
      "workspace.delete.request",
      "workspace.delete.restore",
    ])
    forgetDeletionCache()
  })

  it("answers only the owner once the workspace is claimed", async () => {
    await call("/v1/workspace/claim", {
      method: "POST",
      key: ADMIN,
      json: {
        workspaceName: "Doomed Co",
        name: "Ada",
        email: `ada-${crypto.randomUUID().slice(0, 6)}@example.org`,
      },
    })
    const refused = await del("Doomed Co")
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ reason: "owner" })
  })
})

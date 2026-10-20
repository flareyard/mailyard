import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { RAW_PATHS } from "../../src/http/rawRoutes.ts"
import { planAttachments } from "../../src/mail/attachmentPlan.ts"
import { PLATFORM_ONLY_PATHS } from "../../src/workers/flareyardSignIn.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"
import { delivery } from "../mailbox/deliveries.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const MIB = 1024 * 1024

const setup = async () => {
  const domain = `cmp-${uid()}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  const box = await json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `sam@${domain}`, kind: "user" },
    }),
  )
  return {
    domain,
    box,
    base: `/v1/mailboxes/${box.id}`,
    stub: env.MAILBOX.get(env.MAILBOX.idFromName(box.id)),
  }
}

describe("correspondents", () => {
  it("knows who wrote and who was written to, by address or name, most recent first", async () => {
    const { base, stub } = await setup()
    await stub.deliver(
      delivery({ from: { name: "Ada Lovelace", address: "ada@example.org" }, receivedAt: 1000 }),
    )
    await stub.deliver(
      delivery({ from: { name: "Ada Lovelace", address: "ada@example.org" }, receivedAt: 3000 }),
    )
    await stub.deliver(
      delivery({
        from: { name: "Robot", address: "noreply@example.org" },
        automated: true,
        receivedAt: 4000,
      }),
    )
    await stub.deliver(
      delivery({
        from: { name: "Sam", address: "sam@acme.test" },
        to: [{ name: "Grace Hopper", address: "grace@navy.example" }],
        receivedAt: 2000,
      }),
      "sent",
    )
    await stub.deliver(
      delivery({ from: { name: "Spammer", address: "spam@bad.example" }, receivedAt: 5000 }),
      "spam",
    )
    type List = {
      correspondents: Array<{ address: string; name: string | null; received: number; sent: number }>
    }
    const all = await json<List>(await call(`${base}/correspondents`, { key: ADMIN }))
    expect(all.correspondents.map((c) => c.address)).toEqual(["ada@example.org", "grace@navy.example"])
    expect(all.correspondents[0]).toMatchObject({ name: "Ada Lovelace", received: 2, sent: 0 })
    expect(all.correspondents[1]).toMatchObject({ received: 0, sent: 1 })
    const byName = await json<List>(await call(`${base}/correspondents?q=hop`, { key: ADMIN }))
    expect(byName.correspondents.map((c) => c.address)).toEqual(["grace@navy.example"])
    const byAddress = await json<List>(await call(`${base}/correspondents?q=ADA`, { key: ADMIN }))
    expect(byAddress.correspondents.map((c) => c.address)).toEqual(["ada@example.org"])
    expect(
      (await json<List>(await call(`${base}/correspondents?q=%25`, { key: ADMIN }))).correspondents,
    ).toEqual([])
  })
})

describe("identity signatures", () => {
  it("lists each identity's signature, an alias taking its mailbox's", async () => {
    const { domain, box } = await setup()
    const signature = { text: "— Sam", html: "<p>— Sam</p>" }
    await call(`/v1/mailboxes/${box.id}`, { method: "PATCH", key: ADMIN, json: { signature } })
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `hi@${domain}`, kind: "alias", targets: [box.id] },
    })
    const ids = await json<{ identities: Array<{ address: string; signature: unknown }> }>(
      await call("/v1/identities", { key: ADMIN }),
    )
    expect(ids.identities.find((i) => i.address === box.address)?.signature).toEqual(signature)
    expect(ids.identities.find((i) => i.address === `hi@${domain}`)?.signature).toEqual(signature)
  })
})

describe("attachment delivery on drafts", () => {
  it("plans the smallest files into the message and links the rest", () => {
    const plan = planAttachments({
      bodyText: "Hi",
      bodyHtml: null,
      attachments: [
        { key: "big", size: 4 * MIB },
        { key: "small", size: 100_000 },
        { key: "mid", size: 2 * MIB },
      ],
    })
    expect(Object.fromEntries(plan)).toEqual({ small: "inline", mid: "inline", big: "link" })
  })

  it("shows each attachment's delivery on the draft", async () => {
    const { base } = await setup()
    const upload = async (size: number, filename: string) =>
      json<{ key: string; filename: string; mimeType: string; size: number }>(
        await call(`${base}/uploads?filename=${filename}`, {
          method: "POST",
          key: ADMIN,
          body: new Uint8Array(size),
          headers: { "content-type": "application/octet-stream" },
        }),
      )
    const small = await upload(50_000, "small.bin")
    const big = await upload(6 * MIB, "big.bin")
    const draft = await json<{ attachments: Array<{ filename: string; delivery: string }> }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: ADMIN,
        json: {
          subject: "Files",
          attachments: [small, big].map((a) => ({
            key: a.key,
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
          })),
        },
      }),
    )
    expect(Object.fromEntries(draft.attachments.map((a) => [a.filename, a.delivery]))).toEqual({
      "small.bin": "inline",
      "big.bin": "link",
    })
  })
})

describe("the raw routes in the OpenAPI document", () => {
  it("describes every byte and socket route, and each is really served", async () => {
    const doc = await json<{ paths: Record<string, Record<string, { operationId: string }>> }>(
      await call("/openapi.json"),
    )
    // The Flareyard hand-off is listed only on installs Flareyard made (HAL-3360); it's still routed below.
    for (const path of Object.keys(RAW_PATHS))
      if (!PLATFORM_ONLY_PATHS.has(path)) expect(doc.paths[path], path).toBeDefined()
    expect(doc.paths["/v1/uploads"]?.post?.operationId).toBe("uploads.create")
    // Each answers its own refusal, not the API router's 404: they're routed.
    const concrete = (path: string) =>
      path
        .replace("{id}", "mbx_x")
        .replace("{messageId}", "m")
        .replace("{attachmentId}", "a")
        .replace("{token}", "t")
    for (const [path, ops] of Object.entries(RAW_PATHS)) {
      const method = Object.keys(ops)[0]?.toUpperCase() ?? "GET"
      const res = await exports.default.fetch(
        new Request(`https://mailyard.test${concrete(path)}`, {
          method,
          headers: path.endsWith("/live") ? { upgrade: "websocket" } : {},
        }),
      )
      const documented = Object.keys(
        (Object.values(ops)[0] as { responses: Record<string, unknown> }).responses,
      )
      expect(documented, `${method} ${path} answered ${res.status}`).toContain(String(res.status))
    }
  })
})

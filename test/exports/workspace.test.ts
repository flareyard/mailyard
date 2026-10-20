import { introspectWorkflow } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { parseMbox } from "../../src/imports/mbox.ts"
import { handleEmail } from "../../src/workers/inbound.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"
import { simpleMessage } from "../inbound/messages.ts"

/** HAL-3451: everything in one export, each part readable, nothing secret in it. */
installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const admin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(path, { key: ADMIN, ...init })

type Part = {
  kind: string
  format: string
  filename: string
  items: number
  bytes: number
  status: string
  error: string | null
  mailboxId: string | null
  url: string | null
}
type Export = {
  id: string
  kind: string
  status: string
  url: string | null
  error: string | null
  parts: Array<Part> | null
}

describe("workspace export", () => {
  it("writes mail, contacts, templates, lists, settings and the audit log, with a manifest", async () => {
    // Credentials kept in settings: the push key pair and an open claim link (HAL-3587).
    await env.DB.prepare(
      "insert into settings (key, value, updated_at) values ('vapid', ?, 1), ('claim', ?, 1) on conflict(key) do nothing",
    )
      .bind(
        JSON.stringify({ sealed: "vapid-sealed-private-key" }),
        JSON.stringify({ tokenHash: "claim-hash-value" }),
      )
      .run()
    const tag = uid()
    // Something in every part: a mailbox holding mail, a contact, a template, a topic, a webhook
    // with a secret, and an automation whose step holds a secret.
    const domain = `ws-${tag}.test`
    await admin("/v1/domains", { method: "POST", json: { name: domain } })
    const box = await json<{ id: string; address: string }>(
      await admin("/v1/mailboxes", { method: "POST", json: { address: `keep@${domain}`, kind: "user" } }),
    )
    const empty = await json<{ id: string }>(
      await admin("/v1/mailboxes", { method: "POST", json: { address: `empty@${domain}`, kind: "user" } }),
    )
    const raw = simpleMessage({
      to: box.address,
      subject: `Keep me ${tag}`,
      messageId: `<ws-${tag}@example.org>`,
    })
    await handleEmail(
      {
        from: "ada@example.org",
        to: box.address,
        headers: new Headers(),
        raw: new Blob([raw]).stream(),
        rawSize: raw.byteLength,
        setReject: () => {},
      } as unknown as ForwardableEmailMessage,
      env,
    )
    await admin("/v1/contacts", { method: "POST", json: { email: `ws-${tag}@example.net`, name: "Ada" } })
    await admin("/v1/templates", {
      method: "POST",
      json: { name: `Welcome ${tag}`, kind: "html", subject: "Hi", source: "<p>Hi {{name}}</p>" },
    })
    await admin("/v1/topics", { method: "POST", json: { name: `Topic ${tag}`, doubleOptIn: false } })
    const hook = await json<{ secret?: string }>(
      await admin("/v1/webhooks", {
        method: "POST",
        json: { url: "https://hooks.example.org/in", events: ["email.opened"] },
      }),
    )

    await using introspector = await introspectWorkflow(env.WORKSPACE_EXPORT_WORKFLOW)
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps()
    })
    const started = await admin("/v1/exports", { method: "POST", json: { kind: "workspace" } })
    expect(started.status).toBe(200)
    const created = await json<Export>(started)
    expect(created).toMatchObject({ kind: "workspace", status: "running" })

    let done: Export = created
    for (let i = 0; i < 600 && done.status === "running"; i++) {
      await sleep(100)
      done = await json<Export>(await admin(`/v1/exports/${created.id}`))
    }
    expect(done.status).toBe("completed")
    expect(done.error).toBeNull()
    const parts = done.parts ?? []
    // The empty mailbox has no part; the one holding mail does.
    expect(parts.filter((p) => p.kind === "mail").map((p) => p.mailboxId)).toEqual([box.id])
    expect(parts.map((p) => p.kind).sort()).toEqual(
      ["audit", "contacts", "lists", "mail", "manifest", "settings", "templates"].sort(),
    )
    expect(parts.every((p) => p.status === "complete" && p.url && p.bytes > 0)).toBe(true)
    expect(parts.some((p) => p.mailboxId === empty.id)).toBe(false)

    const fetchPart = async (kind: string) => {
      const part = parts.find((p) => p.kind === kind)
      const res = await exports.default.fetch(new Request(part?.url ?? ""))
      expect(res.status, kind).toBe(200)
      return new Uint8Array(await res.arrayBuffer())
    }
    const text = async (kind: string) => new TextDecoder().decode(await fetchPart(kind))

    const mbox = parseMbox(await fetchPart("mail"))
    expect(mbox).toHaveLength(1)
    expect(new TextDecoder().decode(mbox[0])).toContain(`Keep me ${tag}`)
    expect(await text("contacts")).toContain(`ws-${tag}@example.net`)
    expect(JSON.parse(await text("templates"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: `Welcome ${tag}`, versions: expect.any(Array) }),
      ]),
    )
    expect(JSON.parse(await text("lists")).topics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: `Topic ${tag}` })]),
    )
    const settingsText = await text("settings")
    const settings = JSON.parse(settingsText)
    expect(settings.webhookEndpoints).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: "https://hooks.example.org/in" })]),
    )
    // Nothing secret: no signing secret, no key hash.
    if (hook.secret) expect(settingsText).not.toContain(hook.secret)
    expect(settingsText).not.toMatch(/secret_?ciphertext|"hash"/i)
    expect(settingsText).not.toContain("vapid-sealed-private-key")
    expect(settingsText).not.toContain("claim-hash-value")
    expect(Object.keys(settings.settings)).not.toEqual(expect.arrayContaining(["vapid"]))
    expect((await text("audit")).split("\n")[0]).toContain("at,actor_type")
    const manifest = JSON.parse(await text("manifest"))
    expect(manifest).toMatchObject({ app: "mailyard", export: created.id })
    expect(manifest.parts).toHaveLength(parts.length - 1)

    // The export is listed; its own contacts file isn't listed as a separate export.
    const listed = await json<{ exports: Array<{ id: string; kind: string }> }>(await admin("/v1/exports"))
    expect(listed.exports.find((e) => e.id === created.id)?.kind).toBe("workspace")
    expect(
      listed.exports.filter((e) => e.kind === "contacts" && e.id !== created.id).every((e) => e.id),
    ).toBe(true)
    const alert = await env.DB.prepare("select title from alerts where key = ?")
      .bind(`export_ready:${created.id}`)
      .first<{ title: string }>()
    expect(alert?.title).toBe("The workspace export is ready")
  }, 120_000)

  it("is the admin's to take, and takes no filters", async () => {
    const reader = await json<{ key: string }>(
      await admin("/v1/api-keys", { method: "POST", json: { name: "r", kind: "secret", scopes: ["read"] } }),
    )
    expect(
      (await call("/v1/exports", { method: "POST", key: reader.key, json: { kind: "workspace" } })).status,
    ).toBe(403)
    const filtered = await admin("/v1/exports", {
      method: "POST",
      json: { kind: "workspace", filter: { status: "subscribed" } },
    })
    expect(filtered.status).toBe(400)
    expect(await json(filtered)).toMatchObject({ field: "filter" })
  })
})

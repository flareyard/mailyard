import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { readArcChain } from "../../src/inbound/auth.ts"
import { MAILBOX_MIGRATIONS } from "../../src/mailbox/schema.ts"
import { MailboxStore } from "../../src/mailbox/store.ts"
import { nearestLabelColor } from "../../src/mailbox/types.ts"
import type { MailboxDO } from "../../src/objects/MailboxDO.ts"
import { handleEmail } from "../../src/workers/inbound.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"
import { freshMailbox } from "../mailbox/deliveries.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)

const setup = async () => {
  const domain = `rd-${uid()}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  const box = await json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `sam@${domain}`, kind: "user" },
    }),
  )
  return { box, base: `/v1/mailboxes/${box.id}` }
}

const receive = async (to: string, raw: string) => {
  const bytes = new TextEncoder().encode(raw)
  const outcome = await handleEmail(
    {
      from: "bounce@example.org",
      to,
      headers: new Headers(),
      raw: new Blob([bytes]).stream(),
      rawSize: bytes.byteLength,
      canBeForwarded: true,
      setReject: () => {},
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage,
    env,
  )
  if (outcome?.outcome !== "filed") throw new Error(`not filed: ${JSON.stringify(outcome)}`)
  return outcome.id
}

const arcMail = (
  to: string,
  subject: string,
  auth = "spf=pass smtp.mailfrom=ada@example.org; dkim=pass header.d=example.org; dmarc=pass header.from=example.org; arc=pass",
) =>
  [
    `Authentication-Results: mx.cloudflare.net; ${auth}`,
    "ARC-Seal: i=1; a=rsa-sha256; t=1; cv=none; d=lists.example.net; s=arc; b=AAA",
    "ARC-Seal: i=2; a=rsa-sha256; t=2; cv=pass; d=google.com; s=arc-2024; b=BBB",
    "From: Ada <ada@example.org>",
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${uid()}@example.org>`,
    "Date: Sat, 17 Oct 2026 10:00:00 +0000",
    "",
    "Hello.",
    "",
  ].join("\r\n")

describe("the reader (HAL-3407)", () => {
  it("reads the newest ARC seal", () => {
    const headers = [
      { key: "arc-seal", value: "i=1; cv=none; d=a.example; s=x; b=1" },
      { key: "arc-seal", value: "i=3; cv=pass; d=C.Example; s=x; b=3" },
      { key: "arc-seal", value: "i=2; cv=pass; d=b.example; s=x; b=2" },
    ]
    expect(readArcChain(headers, null)).toEqual({ result: "pass", instance: 3, sealer: "c.example" })
    expect(readArcChain(headers, "fail")).toMatchObject({ result: "fail" })
    expect(readArcChain([], "pass")).toBeNull()
  })

  it("shows ARC on the message and every header in order when asked", async () => {
    const { box, base } = await setup()
    const id = await receive(box.address, arcMail(box.address, "With ARC"))
    const plain = await json<{ auth: { arc: unknown }; headers?: unknown }>(
      await call(`${base}/messages/${id}`, { key: ADMIN }),
    )
    expect(plain.auth.arc).toEqual({ result: "pass", instance: 2, sealer: "google.com" })
    expect(plain.headers).toBeUndefined()
    const full = await json<{ headers: Array<{ name: string; value: string }> }>(
      await call(`${base}/messages/${id}?include=headers`, { key: ADMIN }),
    )
    expect(full.headers.map((h) => h.name).slice(0, 3)).toEqual([
      "authentication-results",
      "arc-seal",
      "arc-seal",
    ])
    expect(full.headers.find((h) => h.name === "subject")?.value).toBe("With ARC")
  })

  it("files by the mailbox's own spam threshold", async () => {
    const { box, base } = await setup()
    // DMARC failing is a few points: under the default 5, over a strict mailbox's 1.
    const failing =
      "spf=softfail smtp.mailfrom=ada@example.org; dkim=none; dmarc=none header.from=example.org"
    const before = await receive(box.address, arcMail(box.address, "Before", failing))
    const first = await json<{ folder: string; spamScore: number }>(
      await call(`${base}/messages/${before}`, { key: ADMIN }),
    )
    expect(first.spamScore).toBeGreaterThan(1)
    expect(first.spamScore).toBeLessThan(5)
    expect(first.folder).toBe("inbox")
    const patched = await call(`/v1/mailboxes/${box.id}`, {
      method: "PATCH",
      key: ADMIN,
      json: { spamThreshold: 1 },
    })
    expect(patched.status).toBe(200)
    expect(await json(patched)).toMatchObject({ spamThreshold: 1, spamThresholdIsDefault: false })
    const after = await receive(box.address, arcMail(box.address, "After", failing))
    expect(
      (await json<{ folder: string }>(await call(`${base}/messages/${after}`, { key: ADMIN }))).folder,
    ).toBe("spam")
    expect(
      (await call(`/v1/mailboxes/${box.id}`, { method: "PATCH", key: ADMIN, json: { spamThreshold: 50 } }))
        .status,
    ).toBe(400)
    const reset = await json(
      await call(`/v1/mailboxes/${box.id}`, { method: "PATCH", key: ADMIN, json: { spamThreshold: null } }),
    )
    expect(reset).toMatchObject({ spamThreshold: 5, spamThresholdIsDefault: true })
  })

  it("keeps internal notes on a conversation, for members, never sent", async () => {
    const { box, base } = await setup()
    const id = await receive(box.address, arcMail(box.address, "Needs a note"))
    const msg = await json<{ threadId: string }>(await call(`${base}/messages/${id}`, { key: ADMIN }))
    const member = await createKey("secret", ["read", "send"])
    const viewer = await createKey("secret", ["read"])
    await call(`${base}/members`, {
      method: "PUT",
      key: ADMIN,
      json: {
        members: [
          { apiKeyId: member.apiKey.id, role: "member" },
          { apiKeyId: viewer.apiKey.id, role: "viewer" },
        ],
      },
    })
    const added = await call(`${base}/threads/${msg.threadId}/notes`, {
      method: "POST",
      key: member.key,
      json: { body: "Customer called; refund approved." },
    })
    expect(added.status).toBe(200)
    const note = await json<{ id: string; author: { id: string; name: string } }>(added)
    expect(note.author.id).toBe(member.apiKey.id)
    expect(
      (
        await call(`${base}/threads/${msg.threadId}/notes`, {
          method: "POST",
          key: viewer.key,
          json: { body: "x" },
        })
      ).status,
    ).toBe(403)
    const thread = await json<{ notes: Array<{ body: string }> }>(
      await call(`${base}/threads/${msg.threadId}`, { key: viewer.key }),
    )
    expect(thread.notes.map((n) => n.body)).toEqual(["Customer called; refund approved."])
    // Someone else's note isn't theirs to delete; the author's, or an admin's, is.
    const other = await createKey("secret", ["read", "send"])
    await call(`${base}/members`, {
      method: "PUT",
      key: ADMIN,
      json: {
        members: [
          { apiKeyId: member.apiKey.id, role: "member" },
          { apiKeyId: other.apiKey.id, role: "member" },
        ],
      },
    })
    expect((await call(`${base}/notes/${note.id}`, { method: "DELETE", key: other.key })).status).toBe(403)
    expect((await call(`${base}/notes/${note.id}`, { method: "DELETE", key: member.key })).status).toBe(200)
    expect(
      (await json<{ notes: unknown[] }>(await call(`${base}/threads/${msg.threadId}`, { key: ADMIN }))).notes,
    ).toEqual([])
  })

  it("moves label colours onto the palette when a mailbox migrates", async () => {
    expect(nearestLabelColor("#3366ff")).toBe("blue")
    expect(nearestLabelColor("#00aa88")).toBe("teal")
    expect(nearestLabelColor("#123")).toBe("slate")
    await runInDurableObject(freshMailbox(), (_i: MailboxDO, state) => {
      const sql = state.storage.sql
      sql.exec(
        "INSERT INTO labels (id, name, color, created_at) VALUES ('lbl_a', 'A', '#0ea5e9', 1), ('lbl_b', 'B', 'navy', 1)",
      )
      sql.exec("UPDATE _schema SET version = ?", MAILBOX_MIGRATIONS.length - 1)
      sql.exec("DROP TABLE thread_notes")
      new MailboxStore(sql, (fn) => state.storage.transactionSync(fn)).migrate()
      const colors = sql.exec("SELECT id, color FROM labels ORDER BY id").toArray()
      expect(colors).toEqual([
        { id: "lbl_a", color: "sky" },
        { id: "lbl_b", color: "navy" },
      ])
    })
  })
})

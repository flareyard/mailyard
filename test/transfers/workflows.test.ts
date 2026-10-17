import { env, exports } from "cloudflare:workers"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { PART_SIZE } from "../../src/exports/exporter.ts"
import { parseMbox } from "../../src/imports/mbox.ts"
import { handleEmail } from "../../src/workers/inbound.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"
import { largeMessage, simpleMessage } from "../inbound/messages.ts"

installDohFixture()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const mailbox = async (local: string) => {
  const domain = `wf-${crypto.randomUUID().slice(0, 8)}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  return json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `${local}@${domain}`, kind: "user" },
    }),
  )
}

const receive = async (raw: Uint8Array, to: string) => {
  const outcome = await handleEmail(
    {
      from: "ada@example.org",
      to,
      headers: new Headers(),
      raw: new Blob([raw]).stream(),
      rawSize: raw.byteLength,
      setReject: () => {},
    } as unknown as ForwardableEmailMessage,
    env,
  )
  if (outcome?.outcome !== "filed") throw new Error(JSON.stringify(outcome))
}

/** Waits for a Workflow-driven job to settle, reading its row like the API does. */
const settle = async <T extends { status: string }>(read: () => Promise<T>, timeoutMs = 60_000) => {
  const started = Date.now()
  for (;;) {
    const current = await read()
    if (!["pending", "running"].includes(current.status)) return current
    if (Date.now() - started > timeoutMs) throw new Error(`still ${current.status} after ${timeoutMs} ms`)
    await sleep(100)
  }
}

describe("export, then re-import the export", () => {
  it("round-trips: the re-imported mailbox holds the same messages, byte for byte", async () => {
    const source = await mailbox("source")
    const subjects = ["First", "From the start", "Résumé attached", "Last"]
    for (const [i, subject] of subjects.entries()) {
      const body =
        i === 1 ? "From here on, the line starts with From.\r\n>From quoted already" : `Message ${i}`
      await receive(
        simpleMessage({ to: source.address, subject, body, messageId: `<rt-${i}@example.org>` }),
        source.address,
      )
    }
    const started = await json<{ id: string; status: string }>(
      await call(`/v1/mailboxes/${source.id}/exports`, { method: "POST", key: ADMIN }),
    )
    const done = await settle(() =>
      call(`/v1/mailboxes/${source.id}/exports/${started.id}`, { key: ADMIN }).then((r) =>
        json<{ status: string; messageCount: number; downloads: { mbox: string; zip: string } }>(r),
      ),
    )
    expect(done).toMatchObject({ status: "complete", messageCount: 4 })

    // Both files download through their signed links.
    const mbox = new Uint8Array(
      await (await exports.default.fetch(new Request(done.downloads.mbox))).arrayBuffer(),
    )
    const zip = new Uint8Array(
      await (await exports.default.fetch(new Request(done.downloads.zip))).arrayBuffer(),
    )
    expect(parseMbox(mbox)).toHaveLength(4)
    const entries = unzipSync(zip)
    expect(Object.keys(entries)).toHaveLength(4)
    expect(Object.keys(entries).every((name) => /^inbox\/\d{4}-\d{2}-\d{2}-inb_.+\.eml$/.test(name))).toBe(
      true,
    )

    // The export completes the mailbox's removal precondition.
    expect(await json(await call(`/v1/mailboxes/${source.id}`, { key: ADMIN }))).toMatchObject({
      lastExport: { status: "complete", messageCount: 4 },
    })

    const target = await mailbox("target")
    const imported = await json<{ id: string }>(
      await call(`/v1/mailboxes/${target.id}/imports`, {
        method: "POST",
        key: ADMIN,
        json: { source: "mbox", exportId: started.id },
      }),
    )
    const result = await settle(() =>
      call(`/v1/mailboxes/${target.id}/imports/${imported.id}`, { key: ADMIN }).then((r) =>
        json<{ status: string; totals: { source: number; imported: number }; accountedFor: boolean }>(r),
      ),
    )
    expect(result).toMatchObject({
      status: "complete",
      totals: { source: 4, imported: 4 },
      accountedFor: true,
    })

    const original = (await env.MAILBOX.get(env.MAILBOX.idFromName(source.id)).messages({ limit: 50 }))
      .messages
    const copy = (await env.MAILBOX.get(env.MAILBOX.idFromName(target.id)).messages({ limit: 50 })).messages
    const key = (m: { messageId: string | null; subject: string; rawKey: string; size: number }) =>
      `${m.messageId}|${m.subject}|${m.rawKey}|${m.size}`
    // Same Message-IDs and subjects, and the same raw object: the bytes came back identical.
    expect(copy.map(key).sort()).toEqual(original.map(key).sort())
  }, 120_000)

  it("writes large mailboxes in equal 8 MiB parts and still opens as one zip", async () => {
    const big = await mailbox("big")
    for (let i = 0; i < 3; i++) {
      const { raw } = largeMessage(6 * 1024 * 1024)
      // Distinct bytes per message, so each is its own object.
      raw[raw.length - 12] = 48 + i
      await receive(raw, big.address)
    }
    const started = await json<{ id: string }>(
      await call(`/v1/mailboxes/${big.id}/exports`, { method: "POST", key: ADMIN }),
    )
    const done = await settle(
      () =>
        call(`/v1/mailboxes/${big.id}/exports/${started.id}`, { key: ADMIN }).then((r) =>
          json<{ status: string; size: number; zipSize: number; downloads: { zip: string } }>(r),
        ),
      180_000,
    )
    expect(done.status).toBe("complete")
    expect(done.size).toBeGreaterThan(2 * PART_SIZE)
    expect(done.zipSize).toBeGreaterThan(2 * PART_SIZE)
    const zip = new Uint8Array(
      await (await exports.default.fetch(new Request(done.downloads.zip))).arrayBuffer(),
    )
    expect(zip.byteLength).toBe(done.zipSize)
    expect(Object.keys(unzipSync(zip))).toHaveLength(3)
    const leftovers = await env.STORE.list({ prefix: `exports/${started.id}/` })
    expect(leftovers.objects.map((o) => o.key).sort()).toEqual([
      `exports/${started.id}/mailbox.mbox`,
      `exports/${started.id}/mailbox.zip`,
    ])
  }, 240_000)

  it("exports an empty mailbox as valid empty files", async () => {
    const empty = await mailbox("empty")
    const started = await json<{ id: string }>(
      await call(`/v1/mailboxes/${empty.id}/exports`, { method: "POST", key: ADMIN }),
    )
    const done = await settle(() =>
      call(`/v1/mailboxes/${empty.id}/exports/${started.id}`, { key: ADMIN }).then((r) =>
        json<{ status: string; messageCount: number; downloads: { zip: string } }>(r),
      ),
    )
    expect(done).toMatchObject({ status: "complete", messageCount: 0 })
    const zip = new Uint8Array(
      await (await exports.default.fetch(new Request(done.downloads.zip))).arrayBuffer(),
    )
    expect(Object.keys(unzipSync(zip))).toEqual([])
  })
})

import { env, exports } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { DocumentText } from "../src/services/DocumentText.ts"
import { handleEmail } from "../src/workers/inbound.ts"
import { installDohFixture } from "./dns.ts"
import attachmentsEml from "./fixtures/eml/attachments.eml?raw"
import { ADMIN, call, createKey, json } from "./helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
let rpcId = 0

type ToolResult = {
  isError?: boolean
  structuredContent: Record<string, unknown>
  content: Array<{ text: string }>
}

const tool = async (key: string, name: string, args: Record<string, unknown>) => {
  const res = await exports.default.fetch(
    new Request("https://mailyard.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  )
  const body = await json<{ result?: ToolResult; error?: { message: string } }>(res)
  if (!body.result) throw new Error(`no result: ${JSON.stringify(body)}`)
  return body.result
}

/** A mailbox with a member key (read and send) and a viewer key, and one delivered message with attachments. */
const setup = async () => {
  const domain = `mcpagent-${uid()}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  const box = await json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `desk@${domain}`, kind: "user" },
    }),
  )
  const member = await createKey("secret", ["read", "send"])
  const viewer = await createKey("secret", ["read", "send"])
  const outsider = await createKey("secret", ["read", "send"])
  await call(`/v1/mailboxes/${box.id}/members`, {
    method: "PUT",
    key: ADMIN,
    json: {
      members: [
        { apiKeyId: member.apiKey.id, role: "member" },
        { apiKeyId: viewer.apiKey.id, role: "viewer" },
      ],
    },
  })
  const bytes = new TextEncoder().encode(attachmentsEml)
  const outcome = await handleEmail(
    {
      from: "bounce@example.org",
      to: box.address,
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
  if (outcome?.outcome !== "filed") throw new Error("not filed")
  const message = await json<{ id: string; threadId: string }>(
    await call(`/v1/mailboxes/${box.id}/messages/${outcome.id}`, { key: ADMIN }),
  )
  return {
    box,
    member: member.key,
    viewer: viewer.key,
    outsider: outsider.key,
    messageId: message.id,
    threadId: message.threadId,
  }
}

describe("agent MCP tools (HAL-3459)", () => {
  it("lists each attachment in read_thread with a 15-minute link, and read_attachment reads its text", async () => {
    const { box, member, outsider, messageId, threadId } = await setup()
    const thread = await tool(member, "read_thread", { mailboxId: box.id, threadId })
    const [message] = thread.structuredContent.messages as Array<{
      attachments: Array<{ id: string; filename: string; mimeType: string; bytes: number; url: string }>
    }>
    const names = message?.attachments.map((a) => a.filename).sort()
    expect(names).toEqual(["résumé invoice.pdf", "usage.csv"])
    const csv = message?.attachments.find((a) => a.filename === "usage.csv")
    expect(csv?.url).toMatch(/^https:\/\/mailyard\.test\/v1\/files\//)
    const claim = JSON.parse(
      atob(
        (csv?.url.split("/v1/files/")[1] ?? "").split(".")[0]?.replace(/-/g, "+").replace(/_/g, "/") ?? "",
      ),
    )
    expect(claim.e - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(15 * 60)
    expect(claim.e - Math.floor(Date.now() / 1000)).toBeGreaterThan(14 * 60)
    expect(await (await exports.default.fetch(new Request(csv?.url ?? ""))).text()).toBe(
      "name,amount\r\nAda,10\r\nGrace,20",
    )

    const read = await tool(member, "read_attachment", {
      mailboxId: box.id,
      messageId,
      attachmentId: csv?.id,
    })
    expect(read.structuredContent).toMatchObject({
      text: "name,amount\r\nAda,10\r\nGrace,20",
      truncated: false,
      via: "as-is",
      attachment: { filename: "usage.csv", mimeType: "text/csv" },
    })
    const short = await tool(member, "read_attachment", {
      mailboxId: box.id,
      messageId,
      attachmentId: csv?.id,
      maxChars: 100,
    })
    expect(short.structuredContent.truncated).toBe(false)

    // Without a converter (no Workers AI in tests) a PDF says so and hands back the link.
    const pdf = message?.attachments.find((a) => a.filename === "résumé invoice.pdf")
    const pdfRead = await tool(member, "read_attachment", {
      mailboxId: box.id,
      messageId,
      attachmentId: pdf?.id,
    })
    expect(pdfRead.structuredContent).toMatchObject({
      text: null,
      url: expect.stringContaining("/v1/files/"),
    })
    expect(String(pdfRead.structuredContent.note)).toContain("couldn't be converted")

    // A key that isn't a member reads nothing.
    const refused = await tool(outsider, "read_attachment", {
      mailboxId: box.id,
      messageId,
      attachmentId: csv?.id,
    })
    expect(refused.isError).toBe(true)
    expect(await tool(outsider, "read_thread", { mailboxId: box.id, threadId })).toMatchObject({
      isError: true,
    })
  })

  it("composes a new message with an attachment as a draft, which send_draft then sends", async () => {
    const { box, member, viewer } = await setup()
    const composed = await tool(member, "compose_message", {
      mailboxId: box.id,
      to: ["ada@example.org"],
      cc: ["grace@example.org"],
      subject: "Your report",
      body: "Attached.",
      attachments: [{ filename: "report.txt", contentType: "text/plain", content: btoa("hello report") }],
    })
    expect(composed.isError).toBeFalsy()
    const draft = (
      composed.structuredContent as {
        draft: { id: string; to: Array<{ address: string }>; subject: string; attachments: unknown[] }
      }
    ).draft
    expect(draft).toMatchObject({
      subject: "Your report",
      attachments: [{ filename: "report.txt", mimeType: "text/plain", bytes: 12 }],
    })
    expect(draft.to.map((p) => p.address)).toEqual(["ada@example.org"])
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box.id))
    expect((await stub.draft(draft.id))?.status).toBe("draft")
    const sent = await tool(member, "send_draft", { mailboxId: box.id, draftId: draft.id, confirm: true })
    expect(sent.structuredContent).toMatchObject({ draftId: draft.id, sendAt: expect.any(Number) })
    expect((await stub.draft(draft.id))?.status).not.toBe("draft")

    // Viewers can't compose; bad base64 and slashes in names are refused with a reason.
    expect(
      await tool(viewer, "compose_message", {
        mailboxId: box.id,
        to: ["a@example.org"],
        subject: "x",
        body: "y",
      }),
    ).toMatchObject({ isError: true })
    const bad = await tool(member, "compose_message", {
      mailboxId: box.id,
      to: ["a@example.org"],
      subject: "x",
      body: "y",
      attachments: [{ filename: "../etc", content: "aGk=" }],
    })
    expect(bad.isError).toBe(true)
  })

  it("marks read, archives, labels (making the label), snoozes and moves through the API's path", async () => {
    const { box, member, viewer, threadId } = await setup()
    const thread = async () =>
      json<{ messages: Array<{ seen: boolean; folder: string; labelIds: string[] }> }>(
        await call(`/v1/mailboxes/${box.id}/threads/${threadId}`, { key: ADMIN }),
      )
    expect(
      (await tool(member, "mark_read", { mailboxId: box.id, threadIds: [threadId] })).structuredContent,
    ).toMatchObject({ updated: 1 })
    expect((await thread()).messages.every((m) => m.seen)).toBe(true)
    await tool(member, "mark_read", { mailboxId: box.id, threadIds: [threadId], read: false })
    expect((await thread()).messages.every((m) => !m.seen)).toBe(true)

    const labelled = await tool(member, "label", {
      mailboxId: box.id,
      threadIds: [threadId],
      label: "Invoices",
    })
    const label = (labelled.structuredContent as { label: { id: string; name: string } }).label
    expect(label.name).toBe("Invoices")
    expect((await thread()).messages[0]?.labelIds).toContain(label.id)
    // The same name again reuses it.
    const again = await tool(member, "label", { mailboxId: box.id, threadIds: [threadId], label: "invoices" })
    expect((again.structuredContent as { label: { id: string } }).label.id).toBe(label.id)
    await tool(member, "label", { mailboxId: box.id, threadIds: [threadId], label: "Invoices", remove: true })
    expect((await thread()).messages[0]?.labelIds).not.toContain(label.id)

    await tool(member, "archive", { mailboxId: box.id, threadIds: [threadId] })
    expect((await thread()).messages[0]?.folder).toBe("archive")
    await tool(member, "move", { mailboxId: box.id, threadIds: [threadId], folder: "inbox" })
    expect((await thread()).messages[0]?.folder).toBe("inbox")
    const past = await tool(member, "snooze", {
      mailboxId: box.id,
      threadIds: [threadId],
      until: "2020-01-01T00:00:00Z",
    })
    expect(past.isError).toBe(true)
    const snoozed = await tool(member, "snooze", {
      mailboxId: box.id,
      threadIds: [threadId],
      until: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect(snoozed.structuredContent).toMatchObject({ updated: 1 })
    expect((await thread()).messages[0]?.folder).toBe("snoozed")

    // A viewer membership reads but can't change anything.
    const denied = await tool(viewer, "archive", { mailboxId: box.id, threadIds: [threadId] })
    expect(denied.isError).toBe(true)
    expect(denied.content[0]?.text).toContain("Viewers")
  })

  it("converts documents through Workers AI when it's bound, and gives up quietly when it fails", async () => {
    const calls: Array<{ name: string; type: string }> = []
    const ai = {
      toMarkdown: async (input: { name: string; blob: Blob }) => {
        calls.push({ name: input.name, type: input.blob.type })
        return {
          name: input.name,
          mimeType: "application/pdf",
          format: "markdown",
          tokens: 0,
          data: "# Invoice\n\nTotal: 10",
        }
      },
    } as unknown as Ai
    const run = (layer: ReturnType<typeof DocumentText.layerWorkersAi>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* DocumentText).toMarkdown({
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            bytes: new Uint8Array([37, 80, 68, 70]),
          })
        }).pipe(Effect.provide(layer)),
      )
    expect(await run(DocumentText.layerWorkersAi(ai))).toEqual({
      text: "# Invoice\n\nTotal: 10",
      source: "workers-ai",
    })
    expect(calls).toEqual([{ name: "invoice.pdf", type: "application/pdf" }])
    const failing = { toMarkdown: async () => ({ format: "error", error: "unsupported" }) } as unknown as Ai
    expect(await run(DocumentText.layerWorkersAi(failing))).toBeNull()
    const throwing = {
      toMarkdown: async () => {
        throw new Error("down")
      },
    } as unknown as Ai
    expect(await run(DocumentText.layerWorkersAi(throwing))).toBeNull()
  })
})

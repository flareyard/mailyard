import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { installDohFixture } from "./dns.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"
import { delivery } from "./mailbox/deliveries.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
let n = 0

const rpc = async (key: string | null, body: unknown, headers: Record<string, string> = {}) =>
  exports.default.fetch(
    new Request("https://mailyard.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  )

const request = (method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id: ++n,
  method,
  ...(params ? { params } : {}),
})

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
const callTool = async (key: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await rpc(key, request("tools/call", { name, arguments: args }))
  expect(res.status).toBe(200)
  return await json<{ result?: ToolResult; error?: { code: number; message: string } }>(res)
}

/** A tool call's structured result; fails the test when the call didn't produce one. */
const content = (r: { result?: ToolResult; error?: unknown }) => {
  if (!r.result?.structuredContent) throw new Error(`no result: ${JSON.stringify(r)}`)
  return r.result.structuredContent
}

describe("the MCP server (HAL-3303)", () => {
  it("speaks the protocol: initialize, ping, notifications, batches, and refuses what it shouldn't", async () => {
    const init = await json<{
      result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } }
    }>(
      await rpc(
        ADMIN,
        request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      ),
    )
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mailyard" },
    })
    const unknownVersion = await json<{ result: { protocolVersion: string } }>(
      await rpc(ADMIN, request("initialize", { protocolVersion: "1999-01-01" })),
    )
    expect(unknownVersion.result.protocolVersion).toBe("2025-11-25")
    expect((await rpc(ADMIN, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202)
    const batch = await json<Array<{ id: number; result?: unknown; error?: { code: number } }>>(
      await rpc(ADMIN, [request("ping"), request("no/such")]),
    )
    expect(batch[0]?.result).toEqual({})
    expect(batch[1]?.error?.code).toBe(-32601)
    expect((await rpc(null, request("ping"))).status).toBe(401)
    expect((await rpc((await createKey("public")).key, request("ping"))).status).toBe(403)
    expect((await exports.default.fetch(new Request("https://mailyard.test/mcp"))).status).toBe(405)
    expect((await rpc(ADMIN, request("ping"), { "mcp-protocol-version": "1999-01-01" })).status).toBe(400)
    const bad = await exports.default.fetch(
      new Request("https://mailyard.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}` },
        body: "{",
      }),
    )
    expect(bad.status).toBe(400)
  })

  it("lists only the tools a key's scopes allow, each with a JSON Schema and annotations", async () => {
    const all = await json<{
      result: {
        tools: Array<{
          name: string
          inputSchema: { type: string; properties?: Record<string, unknown>; required?: Array<string> }
          annotations: { destructiveHint: boolean; readOnlyHint: boolean }
        }>
      }
    }>(await rpc(ADMIN, request("tools/list")))
    const names = all.result.tools.map((t) => t.name)
    expect(names.sort()).toEqual(
      [
        "archive",
        "campaign_stats",
        "compose_message",
        "contact_lookup",
        "draft_reply",
        "label",
        "list_mailboxes",
        "mark_read",
        "move",
        "read_attachment",
        "snooze",
        "preview_segment",
        "read_thread",
        "search_mail",
        "send_draft",
        "send_email",
        "track_event",
        "wait_for_mail",
      ].sort(),
    )
    for (const t of all.result.tools) expect(t.inputSchema.type).toBe("object")
    const send = all.result.tools.find((t) => t.name === "send_email")
    expect(send?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    expect(send?.inputSchema.required).toContain("confirm")
    expect(all.result.tools.find((t) => t.name === "search_mail")?.annotations.readOnlyHint).toBe(true)

    const reader = await createKey("secret", ["read"])
    const limited = await json<{ result: { tools: Array<{ name: string }> } }>(
      await rpc(reader.key, request("tools/list")),
    )
    expect(limited.result.tools.map((t) => t.name)).not.toContain("send_email")
    expect(limited.result.tools.map((t) => t.name)).toContain("search_mail")
    const denied = await callTool(reader.key, "send_email", {
      to: "a@b.co",
      subject: "x",
      body: "y",
      confirm: true,
    })
    expect(denied.result?.isError).toBe(true)
  })

  it("reads, searches, drafts and sends mail through the same checks as the API", async () => {
    const tag = `mcp${uid()}`
    const domain = `mcp-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const box = await json<{ id: string; address: string }>(
      await call("/v1/mailboxes", {
        method: "POST",
        key: ADMIN,
        json: { address: `sam@${domain}`, kind: "user" },
      }),
    )
    const other = await json<{ id: string }>(
      await call("/v1/mailboxes", {
        method: "POST",
        key: ADMIN,
        json: { address: `other@${domain}`, kind: "user" },
      }),
    )
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box.id))
    const delivered = (await stub.deliver(
      delivery({
        messageId: `<${tag}@x>`,
        subject: `Question ${tag}`,
        snippet: "Can you help?",
        bodyText: "Can you help?",
      }),
    )) as {
      id: string
      threadId: string
    }
    const member = await createKey("secret", ["read", "send"])
    await call(`/v1/mailboxes/${box.id}/members`, {
      method: "PUT",
      key: ADMIN,
      json: { members: [{ apiKeyId: member.apiKey.id, role: "member" }] },
    })

    const boxes = await callTool(member.key, "list_mailboxes")
    expect((content(boxes) as { mailboxes: Array<{ id: string }> }).mailboxes.map((m) => m.id)).toEqual([
      box.id,
    ])
    const found = await callTool(member.key, "search_mail", { q: tag })
    expect(JSON.stringify(found.result?.structuredContent)).toContain(`Question ${tag}`)
    const thread = await callTool(member.key, "read_thread", {
      mailboxId: box.id,
      threadId: delivered.threadId,
    })
    expect((content(thread) as { messages: Array<{ text: string }> }).messages[0]?.text).toContain(
      "Can you help?",
    )
    // Another mailbox is refused, as a readable error.
    const refused = await callTool(member.key, "read_thread", { mailboxId: other.id, threadId: "thr_x" })
    expect(refused.result?.isError).toBe(true)
    expect(refused.result?.content[0]?.text).toContain("MailboxAccessDenied")
    // Bad arguments are a protocol error.
    expect((await callTool(member.key, "read_thread", { mailboxId: box.id })).error?.code).toBe(-32602)

    const drafted = await callTool(member.key, "draft_reply", {
      mailboxId: box.id,
      messageId: delivered.id,
      mode: "reply",
      bodyText: "Happy to help.",
    })
    const draft = (
      content(drafted) as {
        draft: { id: string; subject: string; to: Array<{ address: string }> }
      }
    ).draft
    expect(draft.subject).toBe(`Re: Question ${tag}`)
    expect(draft.to[0]?.address).toBe("ada@example.org")
    const unconfirmed = await callTool(member.key, "send_draft", { mailboxId: box.id, draftId: draft.id })
    expect(unconfirmed.error?.code ?? (unconfirmed.result?.isError ? -1 : 0)).not.toBe(0)
    const sent = await callTool(member.key, "send_draft", {
      mailboxId: box.id,
      draftId: draft.id,
      confirm: true,
    })
    const scheduled = content(sent) as { sendAt: number; undoUntil: number }
    expect(scheduled.undoUntil).toBe(scheduled.sendAt)
    expect((await stub.draft(draft.id))?.status).toBe("scheduled")
  })

  it("sends transactional mail, looks up contacts, tracks events, previews segments and reports campaigns", async () => {
    const email = `mcp-${uid()}@example.net`
    const sent = await callTool(ADMIN, "send_email", {
      to: email,
      subject: "Your code",
      body: "<p>123456</p>",
      from: "hello@mailyard.test",
      confirm: true,
    })
    expect((content(sent) as { emails: Array<{ status: string }> }).emails[0]?.status).toBe("sent")
    const tracked = await callTool(ADMIN, "track_event", { email, event: "upgraded", data: { plan: "pro" } })
    expect(tracked.result?.isError).toBeFalsy()
    const contact = await callTool(ADMIN, "contact_lookup", { email: email.toUpperCase() })
    expect((content(contact) as { contact: { email: string } | null }).contact?.email).toBe(email)
    expect(
      (await callTool(ADMIN, "contact_lookup", { email: "nobody@nowhere.test" })).result?.structuredContent,
    ).toEqual({ contact: null })
    const preview = await callTool(ADMIN, "preview_segment", {
      filter: { type: "all", rules: [{ type: "field", field: "plan", op: "eq", value: "pro" }] },
    })
    expect(preview.result?.isError).toBeFalsy()
    expect(JSON.stringify(preview.result?.structuredContent)).toContain(email)
    const campaign = await json<{ id: string }>(
      await call("/v1/campaigns", {
        method: "POST",
        key: ADMIN,
        json: { name: `MCP ${uid()}`, subject: "Hi", fromAddress: "news@mailyard.test" },
      }),
    )
    const stats = await callTool(ADMIN, "campaign_stats", { campaignId: campaign.id })
    expect(stats.result?.isError).toBeFalsy()
    expect((await callTool(ADMIN, "campaign_stats", { campaignId: "cmp_nope" })).result?.isError).toBe(true)
  })
})

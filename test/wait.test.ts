import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { handleEmail } from "../src/workers/inbound.ts"
import { installDohFixture } from "./dns.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
let rpcId = 0

const mailbox = async () => {
  const domain = `wait-${uid()}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  return json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `agent@${domain}`, kind: "user" },
    }),
  )
}

const receive = async (to: string, subject: string) => {
  const raw = `From: Ada <ada@example.org>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${uid()}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n\r\nHello\r\n`
  const bytes = new TextEncoder().encode(raw)
  const outcome = await handleEmail(
    {
      from: "ada@example.org",
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
  if (outcome?.outcome !== "filed") throw new Error("not filed")
}

type Wait = {
  cursor: number
  reset: boolean
  messages: Array<{ subject: string; folder: string; threadId: string }>
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
  return (await json<{ result: { isError?: boolean; structuredContent: Record<string, unknown> } }>(res))
    .result
}

describe("waiting for mail (HAL-3461)", () => {
  it("answers 204 with a cursor at the timeout, and at once for mail already after the cursor", async () => {
    const box = await mailbox()
    const idle = await call(`/v1/mailboxes/${box.id}/wait?timeout=0.2`, { key: ADMIN })
    expect(idle.status).toBe(204)
    const cursor = Number(idle.headers.get("x-mailyard-cursor"))
    expect(Number.isInteger(cursor)).toBe(true)
    await receive(box.address, "Already here")
    const started = Date.now()
    const ready = await call(`/v1/mailboxes/${box.id}/wait?since=${cursor}&timeout=20`, { key: ADMIN })
    expect(ready.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(5_000)
    const body = await json<Wait>(ready)
    expect(body.reset).toBe(false)
    expect(body.messages.map((m) => m.subject)).toEqual(["Already here"])
    expect(body.cursor).toBeGreaterThan(cursor)
    expect(ready.headers.get("x-mailyard-cursor")).toBe(String(body.cursor))
    // From the new cursor there's nothing yet.
    expect(
      (await call(`/v1/mailboxes/${box.id}/wait?since=${body.cursor}&timeout=0.1`, { key: ADMIN })).status,
    ).toBe(204)
  })

  it("holds the request open and answers the moment mail lands", async () => {
    const box = await mailbox()
    const waiting = call(`/v1/mailboxes/${box.id}/wait?timeout=20`, { key: ADMIN })
    // Let the wait register with the mailbox before mail arrives.
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box.id))
    for (let i = 0; i < 50 && (await stub.waitingForMail()) === 0; i++)
      await new Promise((r) => setTimeout(r, 20))
    expect(await stub.waitingForMail()).toBe(1)
    await receive(box.address, "Wake up")
    const res = await waiting
    expect(res.status).toBe(200)
    expect((await json<Wait>(res)).messages).toEqual([
      expect.objectContaining({ subject: "Wake up", folder: "inbox" }),
    ])
    expect(await stub.waitingForMail()).toBe(0)
  })

  it("checks access and its parameters", async () => {
    const box = await mailbox()
    const outsider = (await createKey("secret", ["read"])).key
    expect((await call(`/v1/mailboxes/${box.id}/wait?timeout=0`, { key: outsider })).status).toBe(403)
    expect((await call(`/v1/mailboxes/mbx_nope/wait?timeout=0`, { key: ADMIN })).status).toBe(404)
    expect((await call(`/v1/mailboxes/${box.id}/wait?timeout=51`, { key: ADMIN })).status).toBe(400)
    expect((await call(`/v1/mailboxes/${box.id}/wait?since=-1`, { key: ADMIN })).status).toBe(400)
    expect((await call(`/v1/mailboxes/${box.id}/wait`)).status).toBe(401)
  })

  it("waits over MCP, and an agent key's reads leave audit rows with no content", async () => {
    const d = `agentwait-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: d } })
    const created = await json<{
      agent: { mailbox: { id: string; address: string }; key: { id: string } }
      key: string
    }>(
      await call("/v1/agents", {
        method: "POST",
        key: ADMIN,
        json: { name: `W ${uid()}`, address: `bot@${d}` },
      }),
    )
    const { key, agent } = created
    const first = await tool(key, "wait_for_mail", { mailboxId: agent.mailbox.id, timeoutSeconds: 0 })
    expect(first.structuredContent).toMatchObject({ timedOut: true, messages: [] })
    await receive(agent.mailbox.address, "Task for the agent")
    const woke = await tool(key, "wait_for_mail", {
      mailboxId: agent.mailbox.id,
      since: first.structuredContent.cursor,
      timeoutSeconds: 10,
    })
    const messages = woke.structuredContent.messages as Array<{ subject: string; threadId: string }>
    expect(messages.map((m) => m.subject)).toEqual(["Task for the agent"])
    await tool(key, "read_thread", { mailboxId: agent.mailbox.id, threadId: messages[0]?.threadId })
    await tool(key, "search_mail", { mailboxId: agent.mailbox.id, q: "secret plans" })
    await tool(key, "list_mailboxes", {})

    const rows = await env.DB.prepare(
      "select action, target, after from audit where actor = ? order by at, rowid",
    )
      .bind(agent.key.id)
      .all<{
        action: string
        target: string
        after: string
      }>()
    expect(rows.results.map((r) => r.action)).toEqual([
      "mcp.wait_for_mail",
      "mcp.wait_for_mail",
      "mcp.read_thread",
      "mcp.search_mail",
      "mcp.list_mailboxes",
    ])
    const read = rows.results.find((r) => r.action === "mcp.read_thread")
    expect(JSON.parse(read?.after ?? "{}")).toEqual({
      mailboxId: agent.mailbox.id,
      threadId: messages[0]?.threadId,
    })
    expect(JSON.parse(rows.results.find((r) => r.action === "mcp.search_mail")?.after ?? "{}")).toEqual({
      mailboxId: agent.mailbox.id,
      query: "secret plans",
    })
    // No message content in any row.
    expect(rows.results.some((r) => r.after.includes("Hello"))).toBe(false)

    // An ordinary key's MCP reads aren't audited.
    const api = await createKey("secret", ["read"])
    await tool(api.key, "list_mailboxes", {})
    const apiRows = await env.DB.prepare("select count(*) as n from audit where actor = ?")
      .bind(api.apiKey.id)
      .first<{ n: number }>()
    expect(apiRows?.n).toBe(0)
  })

  it("wakes an agent through the agent-wake webhook preset", async () => {
    const box = await mailbox()
    const other = await mailbox()
    const res = await call("/v1/webhooks", {
      method: "POST",
      key: ADMIN,
      json: { url: "https://hooks.test/wake", preset: { kind: "agent-wake", mailboxId: box.id } },
    })
    expect(res.status).toBe(200)
    const { endpoint } = await json<{
      endpoint: { id: string; events: string[]; filter: unknown; description: string }
    }>(res)
    expect(endpoint).toMatchObject({ events: ["mail.received"], filter: { mailboxIds: [box.id] } })
    expect(endpoint.description).toContain(box.address)
    await receive(box.address, "For the agent")
    await receive(other.address, "Not for it")
    const deliveries = await json<{ deliveries: Array<{ payload: { data: { subject: string } } }> }>(
      await call(`/v1/webhooks/${endpoint.id}/deliveries`, { key: ADMIN }),
    )
    expect(deliveries.deliveries.map((d) => d.payload.data.subject)).toEqual(["For the agent"])
    expect(
      (
        await call("/v1/webhooks", {
          method: "POST",
          key: ADMIN,
          json: { url: "https://hooks.test/x", preset: { kind: "agent-wake", mailboxId: "mbx_nope" } },
        })
      ).status,
    ).toBe(400)
    expect(
      (await call("/v1/webhooks", { method: "POST", key: ADMIN, json: { url: "https://hooks.test/y" } }))
        .status,
    ).toBe(400)

    // POST /v1/agents { wake } sets it up with the agent, and shows its secret once.
    const d = `wake-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: d } })
    const agent = await json<{
      agent: { mailbox: { id: string } }
      wake: { endpointId: string; secret: string }
    }>(
      await call("/v1/agents", {
        method: "POST",
        key: ADMIN,
        json: { name: `Wakes ${uid()}`, address: `wakes@${d}`, wake: { url: "https://hooks.test/agent" } },
      }),
    )
    expect(agent.wake.secret).toMatch(/^whsec_/)
    const hook = await json<{ filter: { mailboxIds: string[] } }>(
      await call(`/v1/webhooks/${agent.wake.endpointId}`, { key: ADMIN }),
    )
    expect(hook.filter.mailboxIds).toEqual([agent.agent.mailbox.id])
    const bad = await call("/v1/agents", {
      method: "POST",
      key: ADMIN,
      json: { name: "x", address: `x@${d}`, wake: { url: "http://insecure.test/" } },
    })
    expect(bad.status).toBe(400)
  })
})

import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { installDohFixture } from "./dns.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
let rpcId = 0

type Agent = {
  id: string
  name: string
  mailbox: { id: string; address: string }
  key: { id: string; prefix: string; scopes: string[]; revoked: boolean } | null
  limits: Limits | null
  sentToday: number
  pendingApprovals: number
}
type Limits = {
  sendsPerDay: number | null
  recipients: string
  allowDomains: string[]
  requireApproval: boolean
}
type Refusal = {
  _tag: string
  reason?: string
  notAllowed?: string[]
  limit?: number
  sentToday?: number
  resetsAt?: number
}
type Approval = {
  id: string
  status: string
  kind: string
  recipients: string[]
  subject: string
  result: Record<string, unknown> | null
}

const NO_LIMITS: Limits = { sendsPerDay: null, recipients: "any", allowDomains: [], requireApproval: false }

/** A domain Mailyard sends from and receives on, for the agent's mailbox. */
const domain = async () => {
  const name = `agents-${uid()}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name } })
  return name
}

const createAgent = async (limits?: Partial<Limits>) => {
  const d = await domain()
  const res = await call("/v1/agents", {
    method: "POST",
    key: ADMIN,
    json: {
      name: `Bot ${uid()}`,
      address: `bot@${d}`,
      ...(limits ? { limits: { ...NO_LIMITS, ...limits } } : {}),
    },
  })
  expect(res.status).toBe(200)
  return {
    ...(await json<{ agent: Agent; key: string; mcp: { url: string; command: string } }>(res)),
    domain: d,
  }
}

const send = (key: string, to: string | string[], subject = "Hello") =>
  call("/v1/send", {
    method: "POST",
    key,
    json: { to, subject, body: "<p>Hi</p>", from: "hello@mailyard.test" },
  })

const draftAndSend = async (key: string, mailboxId: string, to: string) => {
  const draft = await json<{ id: string }>(
    await call(`/v1/mailboxes/${mailboxId}/drafts`, {
      method: "POST",
      key,
      json: { to: [{ address: to }], subject: `Note ${uid()}`, bodyText: "Hi" },
    }),
  )
  const res = await call(`/v1/mailboxes/${mailboxId}/drafts/${draft.id}/send`, {
    method: "POST",
    key,
    json: { undoSeconds: 0 },
  })
  return { draftId: draft.id, res }
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
  const body = await json<{ result: { isError?: boolean; structuredContent: Record<string, unknown> } }>(res)
  return body.result
}

describe("agents (HAL-3460)", () => {
  it("makes the mailbox, an MCP key that owns it, and its limits, and shows the key once", async () => {
    const { agent, key, mcp } = await createAgent({ sendsPerDay: 50 })
    expect(key).toMatch(/^sk_/)
    expect(mcp.url).toBe("https://mailyard.test/mcp")
    expect(mcp.command).toBe(
      `claude mcp add --transport http mailyard https://mailyard.test/mcp --header "Authorization: Bearer ${key}"`,
    )
    expect(agent).toMatchObject({
      limits: { ...NO_LIMITS, sendsPerDay: 50 },
      sentToday: 0,
      pendingApprovals: 0,
    })
    expect(agent.key?.scopes).toEqual(["read", "send"])
    const keyRow = await env.DB.prepare("select purpose from api_keys where id = ?")
      .bind(agent.key?.id)
      .first<{ purpose: string }>()
    expect(keyRow?.purpose).toBe("mcp")
    const detail = await json<{ members: Array<{ apiKeyId: string; role: string }> }>(
      await call(`/v1/mailboxes/${agent.mailbox.id}`, { key: ADMIN }),
    )
    expect(detail.members).toEqual([expect.objectContaining({ apiKeyId: agent.key?.id, role: "owner" })])
    // The key reads its own mailbox over MCP and the API.
    expect((await call(`/v1/mailboxes/${agent.mailbox.id}/threads`, { key })).status).toBe(200)
    const listed = await json<{ agents: Agent[] }>(await call("/v1/agents", { key: ADMIN }))
    expect(listed.agents.map((a) => a.id)).toContain(agent.id)
    // Never the admin scope; and a key without agents.manage can't make one.
    const admin = await call("/v1/agents", {
      method: "POST",
      key: ADMIN,
      json: { name: "x", address: `x@${await domain()}`, scopes: ["admin"] },
    })
    expect(admin.status).toBe(400)
    const reader = (await createKey("secret", ["read", "send"])).key
    expect((await call("/v1/agents", { key: reader })).status).toBe(403)
  })

  it("keeps a key inside its allow-list on /v1/send, MCP send_email and a draft's send", async () => {
    const { agent, key } = await createAgent({ recipients: "domains", allowDomains: ["Example.org"] })
    const refused = await send(key, ["ok@example.org", "no@elsewhere.net", "sub@team.example.org"])
    expect(refused.status).toBe(409)
    expect(await json<Refusal>(refused)).toMatchObject({
      reason: "recipient_not_allowed",
      notAllowed: ["no@elsewhere.net"],
    })
    expect((await send(key, ["ok@example.org", "sub@team.example.org"])).status).toBe(200)

    const mcp = await tool(key, "send_email", {
      to: "no@elsewhere.net",
      subject: "Hi",
      body: "Hi",
      from: "hello@mailyard.test",
      confirm: true,
    })
    expect(mcp.isError).toBe(true)
    expect(mcp.structuredContent).toMatchObject({
      reason: "recipient_not_allowed",
      notAllowed: ["no@elsewhere.net"],
    })

    const { res } = await draftAndSend(key, agent.mailbox.id, "no@elsewhere.net")
    expect(res.status).toBe(409)
    expect(await json<Refusal>(res)).toMatchObject({ reason: "recipient_not_allowed" })
    const { res: ok } = await draftAndSend(key, agent.mailbox.id, "ok@example.org")
    expect(ok.status).toBe(200)

    // `contacts`: only people already in contacts.
    await call(`/v1/agents/${agent.id}`, {
      method: "PATCH",
      key: ADMIN,
      json: { limits: { ...NO_LIMITS, recipients: "contacts" } },
    })
    const known = `known-${uid()}@example.net`
    await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: known } })
    expect((await send(key, `stranger-${uid()}@example.net`)).status).toBe(409)
    expect((await send(key, known.toUpperCase())).status).toBe(200)
  })

  it("stops a key at its daily cap on every path, with when it resets", async () => {
    const { agent, key } = await createAgent({ sendsPerDay: 3 })
    expect((await send(key, ["a@example.net", "b@example.net"])).status).toBe(200)
    // One left: a two-recipient send would pass it, so none of it goes.
    const over = await send(key, ["c@example.net", "d@example.net"])
    expect(over.status).toBe(409)
    const refusal = await json<Refusal>(over)
    expect(refusal).toMatchObject({ reason: "agent_limit", limit: 3, sentToday: 2 })
    expect(refusal.resetsAt).toBe((Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000)
    const { res: lastOne } = await draftAndSend(key, agent.mailbox.id, "e@example.net")
    expect(lastOne.status).toBe(200)
    const mcp = await tool(key, "send_email", {
      to: "f@example.net",
      subject: "Hi",
      body: "Hi",
      from: "hello@mailyard.test",
      confirm: true,
    })
    expect(mcp.structuredContent).toMatchObject({ reason: "agent_limit", limit: 3, sentToday: 3 })
    const { res: draft } = await draftAndSend(key, agent.mailbox.id, "g@example.net")
    expect(await json<Refusal>(draft)).toMatchObject({ reason: "agent_limit" })
    expect((await json<Agent>(await call(`/v1/agents/${agent.id}`, { key: ADMIN }))).sentToday).toBe(3)
    // A template test counts too.
    const template = await json<{ id: string }>(
      await call("/v1/templates", {
        method: "POST",
        key: ADMIN,
        json: { name: `t-${uid()}`, kind: "html", subject: "S", source: "<p>B</p>" },
      }),
    )
    const test = await call(`/v1/templates/${template.id}/test`, {
      method: "POST",
      key,
      json: { to: ["h@example.net"], from: "hello@mailyard.test" },
    })
    expect(await json<Refusal>(test)).toMatchObject({ reason: "agent_limit" })
  })

  it("refuses campaigns to a limited key, and limits any key, not just agents", async () => {
    const { key: adminKey, apiKey } = await createKey("secret", ["read", "send", "admin"])
    const put = await call(`/v1/api-keys/${apiKey.id}/limits`, {
      method: "PUT",
      key: ADMIN,
      json: { limits: { ...NO_LIMITS, sendsPerDay: 10 } },
    })
    expect(await json(put)).toMatchObject({ limits: { sendsPerDay: 10 }, sentToday: 0 })
    const campaign = await json<{ id: string }>(
      await call("/v1/campaigns", {
        method: "POST",
        key: ADMIN,
        json: { name: `c-${uid()}`, fromAddress: "news@mailyard.test", subject: "S", bodyHtml: "<p>B</p>" },
      }),
    )
    const scheduled = await call(`/v1/campaigns/${campaign.id}/schedule`, {
      method: "POST",
      key: adminKey,
      json: {},
    })
    expect(scheduled.status).toBe(409)
    expect(await json<Refusal>(scheduled)).toMatchObject({ reason: "agent_limit" })
    await call(`/v1/api-keys/${apiKey.id}/limits`, { method: "PUT", key: ADMIN, json: { limits: null } })
    expect(await json(await call(`/v1/api-keys/${apiKey.id}/limits`, { key: ADMIN }))).toMatchObject({
      limits: null,
    })
    const bad = await call(`/v1/api-keys/${apiKey.id}/limits`, {
      method: "PUT",
      key: ADMIN,
      json: { limits: { ...NO_LIMITS, recipients: "domains" } },
    })
    expect(bad.status).toBe(400)
  })

  it("holds every send for approval, then sends it through the normal path on yes", async () => {
    const { agent, key } = await createAgent({ requireApproval: true })
    const held = await send(key, "ada@example.net", "Held one")
    expect(held.status).toBe(200)
    const body = await json<{ data: { emails: unknown[]; approval: { id: string; status: string } } }>(held)
    expect(body.data.emails).toEqual([])
    expect(body.data.approval.status).toBe("pending")
    expect(
      await env.DB.prepare(
        "select count(*) as n from messages_out where recipient = 'ada@example.net' and subject = 'Held one'",
      ).first<{ n: number }>(),
    ).toMatchObject({ n: 0 })
    const alert = await env.DB.prepare(
      "select count from alerts where key = 'approval_pending' and resolved_at is null",
    ).first<{ count: number }>()
    expect(alert?.count).toBeGreaterThanOrEqual(1)

    // Over MCP it says so, and a draft's send is held too.
    const viaMcp = await tool(key, "send_email", {
      to: "bob@example.net",
      subject: "Via MCP",
      body: "Hi",
      from: "hello@mailyard.test",
      confirm: true,
    })
    expect(viaMcp.structuredContent).toMatchObject({ held: true })
    const { draftId, res: draftHeld } = await draftAndSend(key, agent.mailbox.id, "cy@example.net")
    const draftBody = await json<{
      sendAt: number | null
      approval: { id: string } | null
      draft: { status: string }
    }>(draftHeld)
    expect(draftBody.sendAt).toBeNull()
    expect(draftBody.approval?.id).toMatch(/^apv_/)
    // A test send can't be held, so it's refused.
    const template = await json<{ id: string }>(
      await call("/v1/templates", {
        method: "POST",
        key: ADMIN,
        json: { name: `t-${uid()}`, kind: "html", subject: "S", source: "<p>B</p>" },
      }),
    )
    const test = await call(`/v1/templates/${template.id}/test`, {
      method: "POST",
      key,
      json: { to: ["x@example.net"], from: "hello@mailyard.test" },
    })
    expect(await json<Refusal>(test)).toMatchObject({ reason: "agent_limit" })

    const pending = await json<{ approvals: Approval[] }>(
      await call("/v1/approvals?status=pending", { key: ADMIN }),
    )
    const mine = pending.approvals.filter((a) =>
      [body.data.approval.id, draftBody.approval?.id].includes(a.id),
    )
    expect(mine.map((a) => a.kind).sort()).toEqual(["draft", "transactional"])
    expect((await json<Agent>(await call(`/v1/agents/${agent.id}`, { key: ADMIN }))).pendingApprovals).toBe(3)

    // Yes: the transactional send goes out as the agent's key.
    const approved = await json<Approval>(
      await call(`/v1/approvals/${body.data.approval.id}/approve`, { method: "POST", key: ADMIN }),
    )
    expect(approved.status).toBe("approved")
    const out = await env.DB.prepare(
      "select api_key_id as k, status from messages_out where recipient = 'ada@example.net' and subject = 'Held one'",
    ).first<{ k: string; status: string }>()
    expect(out).toMatchObject({ k: agent.key?.id, status: "sent" })
    // Twice is refused.
    const again = await call(`/v1/approvals/${body.data.approval.id}/approve`, { method: "POST", key: ADMIN })
    expect(await json<Refusal>(again)).toMatchObject({ reason: "decided" })

    // The draft is scheduled through the mailbox, undo window included.
    const draftApproved = await json<Approval>(
      await call(`/v1/approvals/${draftBody.approval?.id}/approve`, { method: "POST", key: ADMIN }),
    )
    expect(draftApproved.result?.sendAt).toEqual(expect.any(Number))
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(agent.mailbox.id))
    expect((await stub.draft(draftId))?.status).not.toBe("draft")

    // No: nothing goes, and with nothing left waiting the alert clears.
    const mcpApproval = (
      await json<{ approvals: Approval[] }>(await call("/v1/approvals?status=pending", { key: ADMIN }))
    ).approvals.find((a) => a.subject === "Via MCP")
    const rejected = await json<Approval>(
      await call(`/v1/approvals/${mcpApproval?.id}/reject`, {
        method: "POST",
        key: ADMIN,
        json: { reason: "Not now" },
      }),
    )
    expect(rejected).toMatchObject({ status: "rejected", reason: "Not now" })
    const stillOpen = await env.DB.prepare(
      "select count(*) as n from approvals where status = 'pending'",
    ).first<{ n: number }>()
    const alertAfter = await env.DB.prepare(
      "select resolved_at from alerts where key = 'approval_pending' order by created_at desc limit 1",
    ).first<{ resolved_at: number | null }>()
    if (stillOpen?.n === 0) expect(alertAfter?.resolved_at).not.toBeNull()
  })

  it("removing an agent revokes its key at once, rejects what it had waiting, and keeps the mailbox", async () => {
    const { agent, key } = await createAgent({ requireApproval: true })
    await send(key, "z@example.net", "Waiting")
    const removed = await json<Agent>(await call(`/v1/agents/${agent.id}`, { method: "DELETE", key: ADMIN }))
    expect(removed.key?.revoked).toBe(true)
    expect((await call("/v1/me", { key })).status).toBe(401)
    expect((await call(`/v1/mailboxes/${agent.mailbox.id}`, { key: ADMIN })).status).toBe(200)
    const waiting = await env.DB.prepare("select status from approvals where key_id = ?")
      .bind(agent.key?.id)
      .all<{ status: string }>()
    expect(waiting.results.map((r) => r.status)).toEqual(["rejected"])
  })
})

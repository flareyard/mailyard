import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Graph } from "../../src/automations/graph.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })
const DAY = 86_400_000

type Step = {
  nodeId: string
  at: number
  outcome: string
  detail: string
  send?: { subject: string; preview: string; to: string }
}
type DryRun = { endedBy: string; sends: number; startedAt: number; endsAt: number; path: Array<Step> }

const setup = async () => {
  const domain = `dry-${uid()}.test`
  setDns(goodDomain(domain))
  await admin("/v1/domains", "POST", { name: domain, sending: true, receiving: false })
  const template = async (subject: string, body = "<p>Hi {{ name }}, you're on {{ plan }}.</p>") =>
    (
      await json<{ id: string }>(
        await admin("/v1/templates", "POST", {
          name: `t-${uid()}`,
          kind: "html",
          subject,
          source: body,
          publish: true,
        }),
      )
    ).id
  return { from: `Team <team@${domain}>`, template }
}

const create = async (graph: Graph, settings: Record<string, unknown>) =>
  (
    await json<{ id: string; issues: unknown[] }>(
      await admin("/v1/automations", "POST", { name: `D ${uid()}`, graph, settings }),
    )
  ).id

const settingsFor = (from: string, extra: Record<string, unknown> = {}) => ({
  fromAddress: from,
  topicId: null,
  reentry: { mode: "never" },
  cadence: null,
  stopEvents: [],
  ...extra,
})

const dry = async (id: string, body: Record<string, unknown>) => {
  const res = await admin(`/v1/automations/${id}/dry-run`, "POST", body)
  if (res.status !== 200) throw new Error(`dry run: ${res.status} ${await res.text()}`)
  return json<DryRun>(res)
}

const outcomes = (r: DryRun) => r.path.map((p) => `${p.nodeId}:${p.outcome}`)

describe("automation dry run", () => {
  it("walks a drip with a branch, rendering each send, with simulated times, and writes nothing", async () => {
    const { from, template } = await setup()
    const welcome = await template("Welcome, {{ name }}")
    const nudge = await template("Still there?")
    const id = await create(
      {
        nodes: [
          { id: "t", type: "trigger", config: { kind: "event", event: "signed_up" } },
          { id: "s1", type: "send", config: { templateId: welcome, version: "published" } },
          { id: "w", type: "wait", config: { duration: { amount: 2, unit: "days" } } },
          { id: "b", type: "branch", config: { kind: "event", event: "purchase" } },
          { id: "s2", type: "send", config: { templateId: nudge, version: "published" } },
          { id: "x1", type: "exit", config: {} },
          { id: "x2", type: "exit", config: {} },
        ],
        edges: [
          { from: "t", to: "s1" },
          { from: "s1", to: "w" },
          { from: "w", to: "b" },
          { from: "b", to: "x1", port: "yes" },
          { from: "b", to: "s2", port: "no" },
          { from: "s2", to: "x2" },
        ],
      },
      settingsFor(from),
    )
    const before = await env.DB.prepare(
      "select (select count(*) from messages_out) as m, (select count(*) from automation_runs) as r, (select count(*) from automation_sends) as s",
    ).first()

    const lapsed = await dry(id, {
      contact: { email: "ada@example.com", name: "Ada", fields: { plan: "pro" } },
    })
    expect(outcomes(lapsed)).toEqual([
      "t:would-run",
      "s1:would-send",
      "w:would-wait",
      "b:no",
      "s2:would-send",
      "x2:exited",
    ])
    expect(lapsed).toMatchObject({ endedBy: "exit", sends: 2 })
    expect(lapsed.path[1]?.send).toMatchObject({ to: "ada@example.com", subject: "Welcome, Ada" })
    expect(lapsed.path[1]?.send?.preview).toContain("you're on pro")
    expect(lapsed.path[4]?.at).toBe(lapsed.startedAt + 2 * DAY)

    const bought = await dry(id, {
      contact: { email: "bo@example.com", name: "Bo" },
      events: [{ name: "purchase", afterMinutes: 90 }],
    })
    expect(outcomes(bought)).toEqual(["t:would-run", "s1:would-send", "w:would-wait", "b:yes", "x1:exited"])
    // Or settle the branch outright.
    expect(outcomes(await dry(id, { contact: { email: "c@example.com" }, assume: { b: "yes" } }))).toContain(
      "b:yes",
    )

    const after = await env.DB.prepare(
      "select (select count(*) from messages_out) as m, (select count(*) from automation_runs) as r, (select count(*) from automation_sends) as s",
    ).first()
    expect(after).toEqual(before)
  })

  it("shows where the cadence cap or a stop rule would end it", async () => {
    const { from, template } = await setup()
    const one = await template("One")
    const two = await template("Two")
    const graph: Graph = {
      nodes: [
        { id: "t", type: "trigger", config: { kind: "created" } },
        { id: "s1", type: "send", config: { templateId: one, version: "published" } },
        { id: "w", type: "wait", config: { duration: { amount: 1, unit: "days" } } },
        { id: "s2", type: "send", config: { templateId: two, version: "published" } },
        { id: "x", type: "exit", config: {} },
      ],
      edges: [
        { from: "t", to: "s1" },
        { from: "s1", to: "w" },
        { from: "w", to: "s2" },
        { from: "s2", to: "x" },
      ],
    }
    const capped = await create(
      graph,
      settingsFor(from, { cadence: { max: 1, days: 7 }, stopEvents: ["purchased"] }),
    )
    const r = await dry(capped, { contact: { email: "cap@example.com" } })
    expect(outcomes(r)).toEqual(["t:would-run", "s1:would-send", "w:would-wait", "s2:skipped", "x:exited"])
    expect(r.path[3]?.detail).toContain("would already have had 1 automation email in 7 days")

    const stopped = await dry(capped, {
      contact: { email: "stop@example.com" },
      events: [{ name: "purchased", afterMinutes: 30 }],
    })
    expect(outcomes(stopped)).toEqual(["t:would-run", "s1:would-send", "w:would-wait", "s2:stopped"])
    expect(stopped.endedBy).toBe("stop")
  })

  it("waits for an event: arrives at its time, or times out; and branches see earlier updates", async () => {
    const { from, template } = await setup()
    const pro = await template("For pro customers")
    const id = await create(
      {
        nodes: [
          { id: "t", type: "trigger", config: { kind: "created" } },
          {
            id: "we",
            type: "wait_event",
            config: { event: "activated", timeout: { amount: 3, unit: "days" } },
          },
          { id: "u", type: "update", config: { fields: { plan: "pro" } } },
          {
            id: "b",
            type: "branch",
            config: { kind: "rule", rule: { type: "field", field: "plan", op: "eq", value: "pro" } },
          },
          { id: "s", type: "send", config: { templateId: pro, version: "published" } },
          { id: "x1", type: "exit", config: {} },
          { id: "x2", type: "exit", config: {} },
          { id: "x3", type: "exit", config: {} },
        ],
        edges: [
          { from: "t", to: "we" },
          { from: "we", to: "u", port: "event" },
          { from: "we", to: "x3", port: "timeout" },
          { from: "u", to: "b" },
          { from: "b", to: "s", port: "yes" },
          { from: "b", to: "x2", port: "no" },
          { from: "s", to: "x1" },
        ],
      },
      settingsFor(from),
    )
    // A real contact on the free plan: the update makes them pro before the branch looks.
    const contact = await json<{ id: string }>(
      await admin("/v1/contacts", "POST", {
        email: `real-${uid()}@example.net`,
        name: "Cy",
        status: "subscribed",
        fields: { plan: "free" },
      }),
    )
    const activated = await dry(id, {
      contactId: contact.id,
      events: [{ name: "activated", afterMinutes: 600 }],
    })
    expect(outcomes(activated)).toEqual([
      "t:would-run",
      "we:would-wait",
      "we:event",
      "u:would-run",
      "b:yes",
      "s:would-send",
      "x1:exited",
    ])
    expect(activated.path[2]?.at).toBe(activated.startedAt + 600 * 60_000)
    // The real contact wasn't changed.
    const row = await env.DB.prepare("select fields from contacts where id = ?")
      .bind(contact.id)
      .first<{ fields: string }>()
    expect(JSON.parse(row?.fields ?? "{}")).toEqual({ plan: "free" })

    const quiet = await dry(id, { contactId: contact.id, assume: { we: "times-out" } })
    expect(outcomes(quiet)).toEqual(["t:would-run", "we:would-wait", "we:timed-out", "x3:exited"])
    expect(quiet.endsAt).toBe(quiet.startedAt + 3 * DAY)
  })

  it("runs a published version by number, and refuses a draft that isn't a graph yet", async () => {
    const { from, template } = await setup()
    const hello = await template("Hello")
    const graph: Graph = {
      nodes: [
        { id: "t", type: "trigger", config: { kind: "created" } },
        { id: "s", type: "send", config: { templateId: hello, version: "published" } },
        { id: "x", type: "exit", config: {} },
      ],
      edges: [
        { from: "t", to: "s" },
        { from: "s", to: "x" },
      ],
    }
    const id = await create(graph, settingsFor(from))
    await admin(`/v1/automations/${id}/publish`, "POST", {})
    // The draft now loses its exit; version 1 still has it.
    await admin(`/v1/automations/${id}`, "PATCH", {
      graph: { nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1) },
    })
    expect(outcomes(await dry(id, { version: 1, contact: { email: "v1@example.com" } }))).toEqual([
      "t:would-run",
      "s:would-send",
      "x:exited",
    ])
    expect(
      (await admin(`/v1/automations/${id}/dry-run`, "POST", { contact: { email: "d@example.com" } })).status,
    ).toBe(409)
    expect((await admin("/v1/automations/aut_nope/dry-run", "POST", {})).status).toBe(404)
  })
})

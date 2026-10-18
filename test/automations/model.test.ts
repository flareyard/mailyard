import { describe, expect, it } from "vitest"
import { type Graph, structuralIssues } from "../../src/automations/graph.ts"
import { fieldDate, nextWeekdayHour } from "../../src/automations/steps/waitUntil.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

type Issue = { nodeId: string | null; code: string; message: string }
type Detail = {
  id: string
  name: string
  status: string
  version: number
  publishedVersion: number | null
  graph: Graph
  issues: Array<Issue>
  counts: Record<string, unknown>
}

const codes = (graph: Graph) => structuralIssues(graph).map((i) => `${i.code}:${i.nodeId ?? "-"}`)

describe("graph structure", () => {
  const t = { id: "t", type: "trigger" as const, config: { kind: "created" as const } }
  const x = { id: "x", type: "exit" as const, config: {} }
  const w = { id: "w", type: "wait" as const, config: { duration: { amount: 2, unit: "days" as const } } }
  const b = {
    id: "b",
    type: "branch" as const,
    config: { kind: "event" as const, event: "purchase" },
  }

  it("accepts a trigger → wait → exit chain and a complete branch", () => {
    expect(
      codes({
        nodes: [t, w, x],
        edges: [
          { from: "t", to: "w" },
          { from: "w", to: "x" },
        ],
      }),
    ).toEqual([])
    const x2 = { ...x, id: "x2" }
    expect(
      codes({
        nodes: [t, b, x, x2],
        edges: [
          { from: "t", to: "b" },
          { from: "b", to: "x", port: "yes" },
          { from: "b", to: "x2", port: "no" },
        ],
      }),
    ).toEqual([])
  })

  it("names what's wrong: no trigger, a dangling step, a missing port, a loop, an unreachable node, a bad edge", () => {
    expect(codes({ nodes: [x], edges: [] })).toEqual(["no_trigger:-"])
    expect(codes({ nodes: [t, w], edges: [{ from: "t", to: "w" }] })).toEqual(["no_exit:w"])
    expect(
      codes({
        nodes: [t, b, x],
        edges: [
          { from: "t", to: "b" },
          { from: "b", to: "x", port: "yes" },
        ],
      }),
    ).toEqual(["no_exit:b"])
    const loop = codes({
      nodes: [t, w, { ...w, id: "w2" }, x],
      edges: [
        { from: "t", to: "w" },
        { from: "w", to: "w2" },
        { from: "w2", to: "w" },
      ],
    })
    expect(loop).toContain("cycle:-")
    expect(
      codes({
        nodes: [t, x, w],
        edges: [
          { from: "t", to: "x" },
          { from: "w", to: "x" },
        ],
      }),
    ).toEqual(["unreachable:w"])
    expect(
      codes({
        nodes: [t, x],
        edges: [
          { from: "t", to: "x" },
          { from: "x", to: "t" },
        ],
      }),
    ).toEqual(expect.arrayContaining(["invalid_edge:t", "invalid_edge:x"]))
    expect(codes({ nodes: [t, x], edges: [{ from: "t", to: "x", port: "yes" }] })).toEqual(
      expect.arrayContaining(["invalid_edge:t", "no_exit:t"]),
    )
  })

  it("works out wait-until times in UTC", () => {
    const fri = Date.UTC(2026, 9, 16, 12) // Friday 16 Oct 2026, 12:00
    expect(new Date(nextWeekdayHour(fri, 1, 9)).toISOString()).toBe("2026-10-19T09:00:00.000Z")
    expect(new Date(nextWeekdayHour(fri, 5, 13)).toISOString()).toBe("2026-10-16T13:00:00.000Z")
    expect(new Date(nextWeekdayHour(fri, 5, 12)).toISOString()).toBe("2026-10-23T12:00:00.000Z")
    expect(new Date(fieldDate("2026-12-25", -3, 8) ?? 0).toISOString()).toBe("2026-12-22T08:00:00.000Z")
    expect(fieldDate("not a date", 0, 8)).toBeNull()
  })
})

describe("automations API", () => {
  const setup = async () => {
    const domain = `auto-${uid()}.test`
    setDns(goodDomain(domain))
    await admin("/v1/domains", "POST", { name: domain, sending: true, receiving: false })
    const template = await json<{ id: string }>(
      await admin("/v1/templates", "POST", {
        name: `welcome-${uid()}`,
        kind: "html",
        subject: "Welcome, {{ name }}",
        source: "<p>Hello {{ name }}</p>",
        publish: true,
      }),
    )
    return { domain, templateId: template.id }
  }

  const drip = (templateId: string): Graph => ({
    nodes: [
      { id: "t", type: "trigger", config: { kind: "event", event: "signed_up" } },
      { id: "s1", type: "send", label: "Welcome", config: { templateId, version: "published" } },
      { id: "w", type: "wait", config: { duration: { amount: 2, unit: "days" } } },
      { id: "x", type: "exit", config: {} },
    ],
    edges: [
      { from: "t", to: "s1" },
      { from: "s1", to: "w" },
      { from: "w", to: "x" },
    ],
  })

  it("creates a draft, refuses to publish what isn't ready, then publishes frozen versions", async () => {
    const { domain, templateId } = await setup()
    const created = await json<Detail>(await admin("/v1/automations", "POST", { name: "Onboarding" }))
    expect(created).toMatchObject({ status: "draft", version: 1, publishedVersion: null, issues: [] })
    expect(created.graph.nodes.map((n) => n.type)).toEqual(["trigger", "exit"])

    // A send with no sender and an unknown template can't publish.
    const broken = drip("tpl_nope")
    const draft = await json<Detail>(await admin(`/v1/automations/${created.id}`, "PATCH", { graph: broken }))
    expect(draft.issues.map((i) => `${i.code}:${i.nodeId}`)).toEqual(
      expect.arrayContaining(["missing_content:s1", "invalid_config:s1"]),
    )
    const refused = await admin(`/v1/automations/${created.id}/publish`, "POST", {})
    expect(refused.status).toBe(409)
    expect(await json<{ issues: Array<Issue> }>(refused)).toMatchObject({ issues: expect.any(Array) })

    // Fixed: real template, a sender on a sending domain.
    const ready = await json<Detail>(
      await admin(`/v1/automations/${created.id}`, "PATCH", {
        graph: drip(templateId),
        settings: {
          fromAddress: `Hi <hi@${domain}>`,
          topicId: null,
          reentry: { mode: "never" },
          cadence: { max: 3, days: 7 },
          stopEvents: ["purchased"],
        },
      }),
    )
    expect(ready.issues).toEqual([])
    const v1 = await json<{ version: number }>(
      await admin(`/v1/automations/${created.id}/publish`, "POST", { note: "First" }),
    )
    expect(v1.version).toBe(1)
    const live = await json<Detail>(await admin(`/v1/automations/${created.id}`))
    expect(live).toMatchObject({ status: "live", publishedVersion: 1, version: 2 })

    // Edit the draft and publish again: v1 retires (no runs on it), v2 is live.
    const edited = drip(templateId)
    await admin(`/v1/automations/${created.id}`, "PATCH", {
      graph: {
        ...edited,
        nodes: edited.nodes.map((n) =>
          n.id === "w" ? { ...n, config: { duration: { amount: 3, unit: "days" } } } : n,
        ),
      },
    })
    expect(
      (await json<{ version: number }>(await admin(`/v1/automations/${created.id}/publish`, "POST", {})))
        .version,
    ).toBe(2)
    const versions = await json<{
      versions: Array<{ version: number; status: string; note: string | null }>
    }>(await admin(`/v1/automations/${created.id}/versions`))
    expect(versions.versions.map((v) => [v.version, v.status, v.note])).toEqual([
      [2, "live", null],
      [1, "retired", "First"],
    ])

    // Restoring v1 puts its graph back in the draft; the live version doesn't change.
    const restored = await json<Detail>(
      await admin(`/v1/automations/${created.id}/versions/1/restore`, "POST"),
    )
    expect(restored.graph.nodes.find((n) => n.id === "w")).toMatchObject({
      config: { duration: { amount: 2 } },
    })
    expect(restored.publishedVersion).toBe(2)

    // Pause and resume.
    expect((await json<Detail>(await admin(`/v1/automations/${created.id}/pause`, "POST"))).status).toBe(
      "paused",
    )
    expect((await json<Detail>(await admin(`/v1/automations/${created.id}/resume`, "POST"))).status).toBe(
      "live",
    )

    const list = await json<{
      automations: Array<{ id: string; status: string }>
      summary: { live: number }
    }>(await admin("/v1/automations?range=30d"))
    expect(list.automations.find((a) => a.id === created.id)?.status).toBe("live")
    expect(list.summary.live).toBeGreaterThanOrEqual(1)
    expect(await json(await admin("/v1/automations/summary"))).toMatchObject({
      live: expect.any(Number),
      sends7d: expect.any(Number),
    })

    expect((await admin(`/v1/automations/${created.id}`, "DELETE")).status).toBe(200)
    expect((await admin(`/v1/automations/${created.id}`)).status).toBe(404)
  })

  it("checks graphs and settings at the edge", async () => {
    const created = await json<Detail>(await admin("/v1/automations", "POST", { name: "Edge" }))
    // Not a node type; a webhook to http://; an empty update.
    const bad = (node: unknown) =>
      admin(`/v1/automations/${created.id}`, "PATCH", {
        graph: { nodes: [{ id: "t", type: "trigger", config: { kind: "created" } }, node], edges: [] },
      })
    expect((await bad({ id: "z", type: "teleport", config: {} })).status).toBe(400)
    expect((await bad({ id: "h", type: "webhook", config: { url: "http://x.test" } })).status).toBe(400)
    const empty = await json<Detail>(await bad({ id: "u", type: "update", config: { fields: {} } }))
    expect(empty.issues.map((i) => `${i.code}:${i.nodeId}`)).toEqual(
      expect.arrayContaining(["invalid_config:u", "unreachable:u", "no_exit:t"]),
    )
    expect((await admin("/v1/automations", "POST", { name: "" })).status).toBe(400)
    expect((await admin(`/v1/automations/${created.id}/pause`, "POST")).status).toBe(400)
    expect((await admin("/v1/automations/aut_nope")).status).toBe(404)
  })
})

describe("secrets in step settings (HAL-3412)", () => {
  const hook = "https://hooks.slack.com/services/T000/B000/abcdefSECRET"
  const graph = (url: string, id = "h") => ({
    nodes: [
      { id: "t", type: "trigger", config: { kind: "created" } },
      { id, type: "webhook", config: { url } },
      { id: "x", type: "exit", config: {} },
    ],
    edges: [
      { from: "t", to: id },
      { from: id, to: "x" },
    ],
  })
  const webhookUrl = (d: Detail) =>
    (d.graph.nodes.find((n) => n.type === "webhook")?.config as { url: string } | undefined)?.url

  it("redacts webhook URLs for keys without admin, and keeps them when a redacted graph is saved", async () => {
    const created = await json<Detail & { redacted: boolean }>(
      await admin("/v1/automations", "POST", { name: `Secrets ${uid()}`, graph: graph(hook) }),
    )
    expect(created.redacted).toBe(false)
    expect(webhookUrl(created)).toBe(hook)

    const reader = (await createKey("secret", ["read"])).key
    const read = await json<Detail & { redacted: boolean }>(
      await call(`/v1/automations/${created.id}`, { key: reader }),
    )
    expect(read.redacted).toBe(true)
    expect(webhookUrl(read)).toBe("https://hooks.slack.com/•••")
    expect(JSON.stringify(read)).not.toContain("SECRET")
    // Read keys still can't save it.
    const refused = await call(`/v1/automations/${created.id}`, {
      method: "PATCH",
      key: reader,
      json: { graph: read.graph },
    })
    expect(refused.status).toBe(403)

    const full = await json<Detail & { redacted: boolean }>(await admin(`/v1/automations/${created.id}`))
    expect(full.redacted).toBe(false)
    expect(webhookUrl(full)).toBe(hook)

    // The editor saves back what it read, redactions and all: the stored URL survives.
    const saved = await json<Detail>(
      await admin(`/v1/automations/${created.id}`, "PATCH", { name: "Renamed", graph: read.graph }),
    )
    expect(webhookUrl(saved)).toBe(hook)
    expect(saved.name).toBe("Renamed")
    // A new URL replaces it.
    const changed = await json<Detail>(
      await admin(`/v1/automations/${created.id}`, "PATCH", {
        graph: graph("https://hooks.example.com/new"),
      }),
    )
    expect(webhookUrl(changed)).toBe("https://hooks.example.com/new")
  })

  it("refuses a redacted value it has nothing to restore from", async () => {
    const createdRedacted = await admin("/v1/automations", "POST", {
      name: `Secrets ${uid()}`,
      graph: graph("https://hooks.slack.com/•••"),
    })
    expect(createdRedacted.status).toBe(400)
    const created = await json<Detail>(
      await admin("/v1/automations", "POST", { name: `Secrets ${uid()}`, graph: graph(hook) }),
    )
    // A step id the stored graph doesn't have.
    const res = await admin(`/v1/automations/${created.id}`, "PATCH", {
      graph: graph("https://hooks.slack.com/•••", "h2"),
    })
    expect(res.status).toBe(400)
    expect(await json<{ message: string }>(res)).toMatchObject({
      message: expect.stringContaining("url of step h2"),
    })
    expect(webhookUrl(await json<Detail>(await admin(`/v1/automations/${created.id}`)))).toBe(hook)
  })
})

import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  introspectWorkflowInstance,
} from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Graph } from "../../src/automations/graph.ts"
import { checkRun, finishRun, runIdFor } from "../../src/automations/runs.ts"
import { track } from "../../src/domain/events.ts"
import worker from "../../src/workers/api.ts"
import { runtimeFor } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

const setup = async () => {
  const domain = `run-${uid()}.test`
  setDns(goodDomain(domain))
  await admin("/v1/domains", "POST", { name: domain, sending: true, receiving: false })
  await env.SEND_GOVERNOR.get(env.SEND_GOVERNOR.idFromName("account")).configure({
    dailyQuota: 100_000,
    establishedDomains: [domain],
  })
  const template = async (subject: string) =>
    (
      await json<{ id: string }>(
        await admin("/v1/templates", "POST", {
          name: `t-${uid()}`,
          kind: "html",
          subject,
          source: `<p>Hi {{ name }}, {{ trigger.plan ?? "welcome" }}</p>`,
          publish: true,
        }),
      )
    ).id
  return { from: `Team <team@${domain}>`, template }
}

const contact = async (fields: Record<string, unknown> = {}) =>
  (
    await json<{ id: string; email: string }>(
      await admin("/v1/contacts", "POST", {
        email: `c-${uid()}@example.net`,
        name: "Ada",
        status: "subscribed",
        fields,
      }),
    )
  ).id

const automation = async (graph: Graph, settings: Record<string, unknown>) => {
  const a = await json<{ id: string; issues: unknown[] }>(
    await admin("/v1/automations", "POST", { name: `A ${uid()}`, graph, settings }),
  )
  expect(a.issues).toEqual([])
  const published = await admin(`/v1/automations/${a.id}/publish`, "POST", {})
  if (published.status !== 200) throw new Error(`publish: ${await published.text()}`)
  return a.id
}

const settingsFor = (from: string, extra: Record<string, unknown> = {}) => ({
  fromAddress: from,
  topicId: null,
  reentry: { mode: "never" },
  cadence: null,
  stopEvents: [],
  ...extra,
})

const runTrigger = async (body: Record<string, unknown>) => {
  const batch = createMessageBatch("mailyard-automation-triggers", [
    { id: `at-${uid()}`, timestamp: new Date(), attempts: 1, body: { ...body, at: Date.now() } },
  ])
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  return getQueueResult(batch, ctx)
}

const runRow = (runId: string) =>
  env.DB.prepare("select state, current_step, error from automation_runs where id = ?")
    .bind(runId)
    .first<{ state: string; current_step: string | null; error: string | null }>()

const until = async (check: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error("timed out waiting")
}

const sends = (runId: string) =>
  env.DB.prepare(
    "select m.subject, m.status, m.idempotency_key from messages_out m where m.automation_run_id = ? and m.stream = 'automation' order by m.created_at",
  )
    .bind(runId)
    .all<{ subject: string; status: string; idempotency_key: string }>()

const stepsOf = async (runId: string) =>
  (
    await env.DB.prepare(
      "select node_id, outcome, port from automation_run_steps where run_id = ? order by seq",
    )
      .bind(runId)
      .all<{ node_id: string; outcome: string; port: string | null }>()
  ).results.map((s) => `${s.node_id}:${s.outcome}${s.port ? `:${s.port}` : ""}`)

describe("automation runs", () => {
  it("runs a drip from a tracked event: send, a two-day wait, send, done", async () => {
    const { from, template } = await setup()
    const welcome = await template("Welcome")
    const followUp = await template("Two days in")
    const id = await automation(
      {
        nodes: [
          { id: "t", type: "trigger", config: { kind: "event", event: "signed_up" } },
          { id: "s1", type: "send", config: { templateId: welcome, version: "published" } },
          { id: "w", type: "wait", config: { duration: { amount: 2, unit: "days" } } },
          { id: "s2", type: "send", config: { templateId: followUp, version: "published" } },
          { id: "x", type: "exit", config: {} },
        ],
        edges: [
          { from: "t", to: "s1" },
          { from: "s1", to: "w" },
          { from: "w", to: "s2" },
          { from: "s2", to: "x" },
        ],
      },
      settingsFor(from),
    )
    const c = await contact()
    const runId = runIdFor(id, c, 1)
    await using instance = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, runId)
    await instance.modify(async (m) => {
      await m.disableSleeps()
    })
    // The trigger arrives through the queue, as a tracked event's would.
    await runTrigger({ kind: "event", contactId: c, key: "signed_up", data: { plan: "pro" } })
    await instance.waitForStatus("complete")
    expect(await runRow(runId)).toMatchObject({ state: "completed" })
    const mail = (await sends(runId)).results
    expect(mail.map((m) => m.subject)).toEqual(["Welcome", "Two days in"])
    expect(mail.map((m) => m.idempotency_key)).toEqual([`${runId}:s1`, `${runId}:s2`])
    expect(await stepsOf(runId)).toEqual(["t:passed", "s1:sent", "w:waiting", "s2:sent", "x:exited"])
    // The trigger's data reached the template.
    const rendered = await env.DB.prepare("select rendered_key from messages_out where idempotency_key = ?")
      .bind(`${runId}:s1`)
      .first<{ rendered_key: string }>()
    const html = (
      ((await (await env.STORE.get(rendered?.rendered_key ?? ""))?.json()) ?? {}) as { html?: string }
    ).html
    expect(html).toContain("Hi Ada, pro")

    // Run history through the API.
    const runs = await json<{ runs: Array<{ id: string; status: string }>; total: number }>(
      await admin(`/v1/automations/${id}/runs?status=completed`),
    )
    expect(runs.runs.map((r) => r.id)).toEqual([runId])
    const detail = await json<{ steps: Array<{ outcome: string }> }>(await admin(`/v1/runs/${runId}`))
    expect(detail.steps).toHaveLength(5)
  }, 60_000)

  it("skips a send the contact has no data for, without using up the cadence cap (HAL-3411)", async () => {
    const { from } = await setup()
    const needsName = (
      await json<{ id: string }>(
        await admin("/v1/templates", "POST", {
          name: `t-${uid()}`,
          kind: "html",
          subject: "For {{ first_name }}",
          source: "<p>Hi {{ first_name }}</p>",
          publish: true,
        }),
      )
    ).id
    const id = await automation(
      {
        nodes: [
          { id: "t", type: "trigger", config: { kind: "event", event: "joined" } },
          { id: "s", type: "send", config: { templateId: needsName, version: "published" } },
          { id: "x", type: "exit", config: {} },
        ],
        edges: [
          { from: "t", to: "s" },
          { from: "s", to: "x" },
        ],
      },
      settingsFor(from, { cadence: { max: 1, days: 7 } }),
    )
    const c = await contact()
    const runId = runIdFor(id, c, 1)
    await using instance = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, runId)
    await runTrigger({ kind: "event", contactId: c, key: "joined", data: {} })
    await instance.waitForStatus("complete")
    expect(await stepsOf(runId)).toEqual(["t:passed", "s:skipped", "x:exited"])
    expect((await sends(runId)).results).toEqual([])
    // The run log names the missing field, so it can link to it (HAL-3417).
    const logged = await json<{ steps: Array<{ nodeId: string; missing: string[] }> }>(
      await admin(`/v1/runs/${runId}`),
    )
    expect(logged.steps.map((step) => [step.nodeId, step.missing])).toEqual([
      ["t", []],
      ["s", ["first_name"]],
      ["x", []],
    ])
    const detail = await json<{ steps: Array<{ nodeId: string; detail: string }> }>(
      await admin(`/v1/runs/${runId}`),
    )
    expect(detail.steps.find((s) => s.nodeId === "s")?.detail).toContain("{{ first_name }}")
    const counted = await env.DB.prepare("select count(*) as n from automation_sends where run_id = ?")
      .bind(runId)
      .first<{ n: number }>()
    expect(counted?.n).toBe(0)
  }, 60_000)

  it("branches on an event: woken by the event, or the timeout path", async () => {
    const { from, template } = await setup()
    const thanks = await template("Thanks for buying")
    const nudge = await template("Still thinking?")
    const id = await automation(
      {
        nodes: [
          { id: "t", type: "trigger", config: { kind: "created" } },
          {
            id: "w",
            type: "wait_event",
            config: { event: "purchase", timeout: { amount: 1, unit: "days" } },
          },
          { id: "yes", type: "send", config: { templateId: thanks, version: "published" } },
          { id: "no", type: "send", config: { templateId: nudge, version: "published" } },
          { id: "x1", type: "exit", config: {} },
          { id: "x2", type: "exit", config: {} },
        ],
        edges: [
          { from: "t", to: "w" },
          { from: "w", to: "yes", port: "event" },
          { from: "w", to: "no", port: "timeout" },
          { from: "yes", to: "x1" },
          { from: "no", to: "x2" },
        ],
      },
      settingsFor(from),
    )
    // A buyer: the tracked event wakes the waiting run.
    const buyer = await contact()
    const buyerRun = runIdFor(id, buyer, 1)
    await using bought = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, buyerRun)
    expect(await json(await admin(`/v1/automations/${id}/enter`, "POST", { contactId: buyer }))).toEqual({
      result: `entered: ${buyerRun}`,
    })
    await until(async () => (await runRow(buyerRun))?.state === "waiting")
    const email =
      (await env.DB.prepare("select email from contacts where id = ?").bind(buyer).first<{ email: string }>())
        ?.email ?? ""
    await runtimeFor(env).runPromise(track({ event: "purchase", email }))
    await bought.waitForStatus("complete")
    expect((await sends(buyerRun)).results.map((m) => m.subject)).toEqual(["Thanks for buying"])
    expect(await stepsOf(buyerRun)).toEqual([
      "t:passed",
      "w:waiting",
      "w:passed:event",
      "yes:sent",
      "x1:exited",
    ])

    // Someone who doesn't buy: the wait times out.
    const browser = await contact()
    const browserRun = runIdFor(id, browser, 1)
    await using lapsed = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, browserRun)
    await lapsed.modify(async (m) => {
      await m.forceEventTimeout({ name: "event 1 w" })
    })
    await admin(`/v1/automations/${id}/enter`, "POST", { contactId: browser })
    await lapsed.waitForStatus("complete")
    expect((await sends(browserRun)).results.map((m) => m.subject)).toEqual(["Still thinking?"])
    expect(await stepsOf(browserRun)).toContain("w:passed:timeout")
  }, 60_000)

  it("stops a run when the contact unsubscribes mid-wait, and a stop event ends it too", async () => {
    const { from, template } = await setup()
    const first = await template("First")
    const second = await template("Second")
    const graph: Graph = {
      nodes: [
        { id: "t", type: "trigger", config: { kind: "created" } },
        { id: "s1", type: "send", config: { templateId: first, version: "published" } },
        { id: "w", type: "wait", config: { duration: { amount: 2, unit: "days" } } },
        { id: "s2", type: "send", config: { templateId: second, version: "published" } },
        { id: "x", type: "exit", config: {} },
      ],
      edges: [
        { from: "t", to: "s1" },
        { from: "s1", to: "w" },
        { from: "w", to: "s2" },
        { from: "s2", to: "x" },
      ],
    }
    const id = await automation(graph, settingsFor(from, { stopEvents: ["purchased"] }))
    const c = await contact()
    const runId = runIdFor(id, c, 1)
    await admin(`/v1/automations/${id}/enter`, "POST", { contactId: c })
    await until(async () => (await runRow(runId))?.state === "waiting")
    expect((await sends(runId)).results).toHaveLength(1)
    // It shows, and counts, at the wait it's in.
    expect((await json<{ nodeId: string }>(await admin(`/v1/runs/${runId}`))).nodeId).toBe("w")
    expect(
      (await json<{ counts: Record<string, { here: number }> }>(await admin(`/v1/automations/${id}`))).counts
        .w?.here,
    ).toBe(1)
    await admin(`/v1/contacts/${c}`, "PATCH", { status: "unsubscribed" })
    expect(await runRow(runId)).toMatchObject({ state: "exited" })
    expect((await stepsOf(runId)).at(-1)).toBe("w:exited")
    expect((await sends(runId)).results).toHaveLength(1)

    // A stop event since the run began: the check before the next step says stop.
    const other = await contact()
    const otherRun = runIdFor(id, other, 1)
    await admin(`/v1/automations/${id}/enter`, "POST", { contactId: other })
    await until(async () => (await runRow(otherRun))?.state === "waiting")
    const email =
      (await env.DB.prepare("select email from contacts where id = ?").bind(other).first<{ email: string }>())
        ?.email ?? ""
    await runtimeFor(env).runPromise(track({ event: "purchased", email }))
    const verdict = await runtimeFor(env).runPromise(checkRun(otherRun))
    expect(verdict).toEqual({ verdict: "stop", detail: "Stopped by purchased." })
    // And the API ends a run on request.
    const ended = await json<{ status: string; exitedBy: string }>(
      await admin(`/v1/runs/${otherRun}/exit`, "POST"),
    )
    expect(ended).toMatchObject({ status: "exited", exitedBy: "root" })
    expect((await admin(`/v1/runs/${otherRun}/exit`, "POST")).status).toBe(409)
  }, 60_000)

  it("respects re-entry and the cadence cap across automations", async () => {
    const { from, template } = await setup()
    const hello = await template("Hello")
    const again = await template("Again")
    const oneSend = (templateId: string): Graph => ({
      nodes: [
        { id: "t", type: "trigger", config: { kind: "created" } },
        { id: "s", type: "send", config: { templateId, version: "published" } },
        { id: "x", type: "exit", config: {} },
      ],
      edges: [
        { from: "t", to: "s" },
        { from: "s", to: "x" },
      ],
    })
    const never = await automation(oneSend(hello), settingsFor(from))
    const capped = await automation(
      oneSend(again),
      settingsFor(from, { reentry: { mode: "after", days: 30 }, cadence: { max: 1, days: 7 } }),
    )
    const c = await contact()

    const r1 = runIdFor(never, c, 1)
    await using i1 = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, r1)
    await admin(`/v1/automations/${never}/enter`, "POST", { contactId: c })
    await i1.waitForStatus("complete")
    expect(await json(await admin(`/v1/automations/${never}/enter`, "POST", { contactId: c }))).toEqual({
      result: "skipped: re-entry is off",
    })

    // The second automation caps at one automation email a week: the first one already counted.
    const r2 = runIdFor(capped, c, 1)
    await using i2 = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, r2)
    await admin(`/v1/automations/${capped}/enter`, "POST", { contactId: c })
    await i2.waitForStatus("complete")
    expect((await sends(r2)).results).toHaveLength(0)
    expect(await stepsOf(r2)).toEqual(["t:passed", "s:skipped", "x:exited"])

    // Inside its 30-day re-entry window: skipped; once it's 31 days ago, a second entry.
    expect(await json(await admin(`/v1/automations/${capped}/enter`, "POST", { contactId: c }))).toEqual({
      result: "skipped: inside the re-entry window",
    })
    await env.DB.prepare("update automation_runs set started_at = started_at - 31 * 86400000 where id = ?")
      .bind(r2)
      .run()
    await using i3 = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, runIdFor(capped, c, 2))
    expect(await json(await admin(`/v1/automations/${capped}/enter`, "POST", { contactId: c }))).toEqual({
      result: `entered: ${runIdFor(capped, c, 2)}`,
    })
    await i3.waitForStatus("complete")

    // A duplicate trigger for a run that's in progress or done doesn't enter twice.
    const results = await runTrigger({ kind: "enter", contactId: c, key: never })
    expect(results.explicitAcks).toHaveLength(1)
    const count = await env.DB.prepare("select count(*) as n from automation_runs where automation_id = ?")
      .bind(never)
      .first<{ n: number }>()
    expect(count?.n).toBe(1)
  }, 60_000)

  it("retries a failed run from the step that failed", async () => {
    const { from, template } = await setup()
    const hello = await template("Hello")
    const id = await automation(
      {
        nodes: [
          { id: "t", type: "trigger", config: { kind: "created" } },
          { id: "w", type: "wait", config: { duration: { amount: 1, unit: "hours" } } },
          { id: "s", type: "send", config: { templateId: hello, version: "published" } },
          { id: "x", type: "exit", config: {} },
        ],
        edges: [
          { from: "t", to: "w" },
          { from: "w", to: "s" },
          { from: "s", to: "x" },
        ],
      },
      settingsFor(from),
    )
    const c = await contact()
    const runId = runIdFor(id, c, 1)
    await admin(`/v1/automations/${id}/enter`, "POST", { contactId: c })
    await until(async () => (await runRow(runId))?.state === "waiting")
    // As if the send had kept failing: the run is failed, positioned at the send.
    await runtimeFor(env).runPromise(finishRun(runId, "failed", "The sender was down."))
    expect(await runRow(runId)).toMatchObject({
      state: "failed",
      current_step: "s",
      error: "The sender was down.",
    })
    expect((await admin(`/v1/runs/${runId}/retry`, "POST")).status).toBe(200)
    await using retried = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, `${runId}-r1`)
    await retried.waitForStatus("complete")
    expect(await runRow(runId)).toMatchObject({ state: "completed", error: null })
    expect((await sends(runId)).results.map((m) => m.subject)).toEqual(["Hello"])
    expect((await admin(`/v1/runs/${runId}/retry`, "POST")).status).toBe(409)
  }, 60_000)
})

describe("triggers and sweeps", () => {
  /** The Worker's bindings with the trigger queue swapped for one that records what's sent. */
  const recording = () => {
    const sent: Array<Record<string, unknown>> = []
    const queue = {
      send: async (body: Record<string, unknown>) => {
        sent.push(body)
      },
      sendBatch: async (batch: ReadonlyArray<{ body: Record<string, unknown> }>) => {
        for (const b of batch) sent.push(b.body)
      },
    }
    return { sent, bindings: { ...env, AUTOMATION_QUEUE: queue } as unknown as typeof env }
  }

  it("queues a trigger only when a live automation listens for it", async () => {
    const { from, template } = await setup()
    const hello = await template("Hello")
    const event = `ordered_${uid()}`
    await automation(
      {
        nodes: [
          { id: "t", type: "trigger", config: { kind: "event", event } },
          { id: "s", type: "send", config: { templateId: hello, version: "published" } },
          { id: "x", type: "exit", config: {} },
        ],
        edges: [
          { from: "t", to: "s" },
          { from: "s", to: "x" },
        ],
      },
      settingsFor(from),
    )
    const { sent, bindings } = recording()
    const email = `trk-${uid()}@example.net`
    await runtimeFor(bindings).runPromise(track({ event, email, data: { total: 40 } }))
    await runtimeFor(bindings).runPromise(track({ event: `nobody_listens_${uid()}`, email }))
    const triggers = sent.filter((s) => s.kind === "event")
    expect(triggers).toEqual([expect.objectContaining({ kind: "event", key: event, data: { total: 40 } })])
  })

  it("sweeps date triggers at their hour and segment triggers at night", async () => {
    const { from, template } = await setup()
    const card = await template("Happy birthday")
    const tag = uid()
    const dateAutomation = await automation(
      {
        nodes: [
          {
            id: "t",
            type: "trigger",
            config: { kind: "date", field: "birthday", offsetDays: 0, hour: 9, repeat: "yearly" },
          },
          { id: "s", type: "send", config: { templateId: card, version: "published" } },
          { id: "x", type: "exit", config: {} },
        ],
        edges: [
          { from: "t", to: "s" },
          { from: "s", to: "x" },
        ],
      },
      settingsFor(from),
    )
    const today = await contact({ birthday: "1990-10-17", tag })
    await contact({ birthday: "1990-10-18", tag })
    const at9 = Date.UTC(2026, 9, 17, 9, 5)
    const { sent, bindings } = recording()
    const { sweepAutomations } = await import("../../src/automations/runs.ts")
    await runtimeFor(bindings).runPromise(sweepAutomations(at9))
    expect(sent.filter((s) => s.key === dateAutomation).map((s) => s.contactId)).toEqual([today])
    // Each entry carries the date it's about (HAL-3411).
    expect(sent.find((s) => s.key === dateAutomation)?.data).toEqual({
      field: "birthday",
      date: "1990-10-17",
      offsetDays: 0,
      years: 36,
    })
    // At another hour, nothing for it.
    const later = recording()
    await runtimeFor(later.bindings).runPromise(sweepAutomations(Date.UTC(2026, 9, 17, 10, 5)))
    expect(later.sent.filter((s) => s.key === dateAutomation)).toEqual([])

    // A segment trigger: at 02:00 its members who haven't been through it enter.
    const segment = await json<{ id: string }>(
      await admin("/v1/segments", "POST", {
        name: `S ${tag}`,
        filter: { type: "all", rules: [{ type: "field", field: "tag", op: "eq", value: tag }] },
      }),
    )
    const segmentAutomation = await automation(
      {
        nodes: [
          { id: "t", type: "trigger", config: { kind: "segment", segmentId: segment.id } },
          { id: "x", type: "exit", config: {} },
        ],
        edges: [{ from: "t", to: "x" }],
      },
      settingsFor(from),
    )
    const night = recording()
    await runtimeFor(night.bindings).runPromise(sweepAutomations(Date.UTC(2026, 9, 18, 2, 0)))
    expect(night.sent.filter((s) => s.key === segmentAutomation)).toHaveLength(2)
    // Entering, a segment run is told which segment (HAL-3411).
    const { enterAutomation } = await import("../../src/automations/runs.ts")
    const member = night.sent.find((s) => s.key === segmentAutomation)?.contactId as string
    const entered = await runtimeFor(env).runPromise(enterAutomation(segmentAutomation, member, null))
    expect(entered).toMatch(/^entered: /)
    const row = await env.DB.prepare("select trigger_data from automation_runs where id = ?")
      .bind(entered.slice("entered: ".length))
      .first<{ trigger_data: string }>()
    expect(JSON.parse(row?.trigger_data ?? "null")).toEqual({
      segmentId: segment.id,
      segmentName: `S ${tag}`,
    })
  })
})

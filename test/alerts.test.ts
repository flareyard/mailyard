import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { finishRun, syncFailedAlert } from "../src/automations/runs.ts"
import { sweepAlerts } from "../src/domain/alertSweep.ts"
import { ALERT_KINDS, expireNotices, raiseAlert } from "../src/domain/alerts.ts"
import { deliver, MAX_WEBHOOK_ATTEMPTS } from "../src/domain/webhooks.ts"
import { Governor } from "../src/services/Governor.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "./dns.ts"
import { ADMIN, call, json } from "./helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
// biome-ignore lint/suspicious/noExplicitAny: the app's services, provided by the runtime.
const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  runtimeFor(env).runPromise(effect as never) as Promise<A>

type Alert = {
  id: string
  kind: string
  severity: string
  title: string
  detail: string
  count: number
  subject: { type: string; id: string } | null
  resolvedAt: number | null
  resolvedBy: string | null
}
const openAlert = (key: string) =>
  env.DB.prepare("select * from alerts where key = ? and resolved_at is null")
    .bind(key)
    .first<Record<string, unknown>>()
const lastAlert = (key: string) =>
  env.DB.prepare("select * from alerts where key = ? order by created_at desc limit 1")
    .bind(key)
    .first<Record<string, unknown>>()
const list = (query = "") =>
  call(`/v1/alerts${query}`, { key: ADMIN }).then((r) =>
    json<{ alerts: Array<Alert>; open: Record<string, number>; nextCursor: string | null }>(r),
  )

describe("alerts", () => {
  it("refreshes an open alert instead of opening a second, and counts", async () => {
    const key = `test-${uid()}`
    const base = {
      key,
      kind: "bounce_spike" as const,
      severity: "warning" as const,
      title: "One",
      detail: "d",
    }
    const first = await run(raiseAlert(base))
    const again = await run(raiseAlert({ ...base, title: "Two", severity: "critical" }))
    expect(again).toBe(first)
    expect(await openAlert(key)).toMatchObject({ count: 2, title: "Two", severity: "critical" })
    await run(raiseAlert({ ...base, title: "Two", severity: "critical", count: 7 }))
    expect(await openAlert(key)).toMatchObject({ count: 7 })

    const page = await list("?kind=bounce_spike")
    expect(page.alerts.every((a) => a.kind === "bounce_spike")).toBe(true)
    expect(page.alerts.find((a) => a.id === first)).toMatchObject({ count: 7, title: "Two" })
    expect(page.open.total).toBeGreaterThanOrEqual(1)
    expect(page.open.critical).toBeGreaterThanOrEqual(1)
    expect((await call("/v1/alerts?kind=nonsense", { key: ADMIN })).status).toBe(400)
  })

  it("publishes the kinds as a fixed set in the contract", async () => {
    const doc = await json<{ components: { schemas: Record<string, unknown> } }>(await call("/openapi.json"))
    expect(JSON.stringify(doc)).toContain('"delivery_events_missing"')
    for (const kind of ALERT_KINDS) expect(JSON.stringify(doc)).toContain(`"${kind}"`)
  })

  it("expires notices after their time", async () => {
    const key = `export_ready:exp_${uid()}`
    await run(raiseAlert({ key, kind: "export_ready", severity: "info", title: "Ready", detail: "d" }))
    await run(expireNotices(Date.now() + 25 * 3_600_000))
    expect(await lastAlert(key)).toMatchObject({ resolved_by: "expired" })
  })
})

describe("raised by the event that causes them", () => {
  it("webhook_dead_letter: opens when a delivery dies, clears when it's replayed", async () => {
    const url = `https://hooks-${uid()}.example/receive`
    const created = await json<{ endpoint: { id: string } }>(
      await call("/v1/webhooks", { method: "POST", key: ADMIN, json: { url, events: ["*"] } }),
    )
    const endpointId = created.endpoint.id
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      new Request(input, init).url === url
        ? new Response("nope", { status: 500 })
        : realFetch(input, init)) as typeof fetch
    try {
      const deliveryId = `whd_${uid()}${uid()}`
      await env.DB.prepare(
        "insert into webhook_deliveries (id, endpoint_id, event_id, event_type, payload, status, attempts, created_at) values (?, ?, ?, 'contact.created', '{}', 'retrying', ?, ?)",
      )
        .bind(deliveryId, endpointId, `evt_${uid()}`, MAX_WEBHOOK_ATTEMPTS - 1, Date.now())
        .run()
      expect(await run(deliver(deliveryId))).toBe("dead")
      expect(await openAlert(`webhook_dead_letter:${endpointId}`)).toMatchObject({
        kind: "webhook_dead_letter",
        severity: "warning",
        count: 1,
      })
      const replay = await call(`/v1/webhooks/${endpointId}/deliveries/${deliveryId}/replay`, {
        method: "POST",
        key: ADMIN,
      })
      expect(replay.status).toBe(200)
      expect(await openAlert(`webhook_dead_letter:${endpointId}`)).toBeNull()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("import_failed: a contact import that can't start says so", async () => {
    const up = await call("/v1/uploads?filename=c.csv", {
      method: "POST",
      key: ADMIN,
      body: "name\nAda\n",
      headers: { "content-type": "text/csv" },
    })
    const uploadId = (await json<{ id: string }>(up)).id
    const res = await call("/v1/imports/contacts", {
      method: "POST",
      key: ADMIN,
      json: { uploadId, mapping: { email: "email" } },
    })
    const { id } = await json<{ id: string }>(res)
    const deadline = Date.now() + 60_000
    let status = "queued"
    while (status !== "failed" && status !== "completed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      status = (await json<{ status: string }>(await call(`/v1/imports/${id}`, { key: ADMIN }))).status
    }
    expect(status).toBe("failed")
    expect(await openAlert(`import_failed:${id}`)).toMatchObject({
      kind: "import_failed",
      severity: "warning",
    })
  })

  it("domain_activated once, then dns_drift when a record breaks, cleared when it's fixed", async () => {
    const name = `alerts-${uid()}.test`
    setDns(goodDomain(name))
    const created = await call("/v1/domains", { method: "POST", key: ADMIN, json: { name } })
    const { id } = await json<{ id: string }>(created)
    expect(await openAlert(`domain_activated:${id}`)).toMatchObject({
      kind: "domain_activated",
      severity: "info",
    })
    expect(await openAlert(`dns_drift:${id}`)).toBeNull()

    // Someone points MX elsewhere.
    setDns({ [`MX ${name}`]: ["10 mx.other-provider.example."] })
    await call(`/v1/domains/${id}/recheck`, { method: "POST", key: ADMIN })
    const drift = await openAlert(`dns_drift:${id}`)
    expect(drift).toMatchObject({ kind: "dns_drift", severity: "critical" })
    expect(String(drift?.title)).toContain("MX")
    // Activation is news once.
    expect(
      (
        await env.DB.prepare("select count(*) as n from alerts where key = ?")
          .bind(`domain_activated:${id}`)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1)

    setDns(goodDomain(name))
    await call(`/v1/domains/${id}/recheck`, { method: "POST", key: ADMIN })
    expect(await openAlert(`dns_drift:${id}`)).toBeNull()
    expect(await lastAlert(`dns_drift:${id}`)).toMatchObject({ resolved_by: "dns-check" })
  })

  it("automation_failed: counts today's failed runs and clears when they're gone", async () => {
    const automationId = `aut_${uid()}${uid()}`
    const now = Date.now()
    await env.DB.prepare(
      "insert into automations (id, name, trigger, graph, settings, status, version) values (?, 'Welcome flow', '{}', '{}', '{}', 'live', 1)",
    )
      .bind(automationId)
      .run()
    const contactId = `con_${uid()}${uid()}`
    await env.DB.prepare("insert into contacts (id, email, status) values (?, ?, 'subscribed')")
      .bind(contactId, `${uid()}@example.net`)
      .run()
    const runIds = [`run_${uid()}`, `run_${uid()}`]
    for (const runId of runIds)
      await env.DB.prepare(
        "insert into automation_runs (id, automation_id, version, contact_id, workflow_id, state, seq, started_at, updated_at) values (?, ?, 1, ?, ?, 'running', 0, ?, ?)",
      )
        .bind(runId, automationId, contactId, `wf-${runId}`, now, now)
        .run()
    for (const runId of runIds) await run(finishRun(runId, "failed", "The template is archived."))
    const alert = await openAlert(`automation_failed:${automationId}`)
    expect(alert).toMatchObject({ kind: "automation_failed", count: 2 })
    expect(String(alert?.title)).toContain("Welcome flow")

    await env.DB.prepare("update automation_runs set state = 'completed' where automation_id = ?")
      .bind(automationId)
      .run()
    await run(syncFailedAlert(automationId))
    expect(await openAlert(`automation_failed:${automationId}`)).toBeNull()
  })
})

describe("the hourly sweep", () => {
  const insertMessages = async (
    tag: string,
    rows: Array<[status: string, bounce: string | null, n: number]>,
  ) => {
    const statements = []
    for (const [status, bounce, n] of rows)
      for (let i = 0; i < n; i++)
        statements.push(
          env.DB.prepare(
            "insert into messages_out (id, stream, recipient, sender, subject, status, bounce_type, created_at) values (?, 'campaign', 'r@example.net', 'news@x.test', 'S', ?, ?, ?)",
          ).bind(`msg_${tag}_${status}_${i}_${uid()}`, status, bounce, Date.now() - 3_600_000),
        )
    for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50))
  }
  const removeMessages = (tag: string) =>
    env.DB.prepare("delete from messages_out where id like ?").bind(`msg_${tag}_%`).run()

  it("raises bounce_spike and complaint_spike over the pause line, and clears them", async () => {
    const tag = uid()
    await insertMessages(tag, [
      ["delivered", null, 400],
      ["bounced", "hard", 60],
      ["complained", null, 5],
    ])
    const report = await run(sweepAlerts())
    expect(report).toContain("spikes ok")
    expect(await openAlert("bounce_spike")).toMatchObject({ kind: "bounce_spike", severity: "critical" })
    expect(await openAlert("complaint_spike")).toMatchObject({ kind: "complaint_spike" })
    await removeMessages(tag)
    await run(sweepAlerts())
    expect(await openAlert("bounce_spike")).toBeNull()
    expect(await openAlert("complaint_spike")).toBeNull()
  })

  it("raises reputation alerts from Mailyard's own 30-day rates", async () => {
    const day = new Date().toISOString().slice(0, 10)
    const provider = `p${uid()}`
    await env.DB.prepare(
      "insert into daily_stats (day, stream, provider, sent, delivered, bounced_hard, complained) values (?, 'campaign', ?, 100000, 90000, 9000, 0)",
    )
      .bind(day, provider)
      .run()
    await run(sweepAlerts())
    expect(await openAlert("reputation_at_risk")).toMatchObject({
      kind: "reputation_at_risk",
      severity: "critical",
    })
    await env.DB.prepare("delete from daily_stats where provider = ?").bind(provider).run()
    await run(sweepAlerts())
    expect(await openAlert("reputation_at_risk")).toBeNull()
  })

  it("raises quota_80, then quota_100 in its place, against a configured quota", async () => {
    const before = await run(Effect.flatMap(Governor, (g) => g.overview))
    await run(Effect.flatMap(Governor, (g) => g.configure({ dailyQuota: 100 })))
    try {
      const sent = Object.values(before.sent).reduce((a, b) => a + b, 0)
      await run(Effect.flatMap(Governor, (g) => g.consume("transactional", Math.max(0, 85 - sent))))
      await run(sweepAlerts())
      expect(await openAlert("quota_80")).toMatchObject({ kind: "quota_80", severity: "warning" })
      await run(Effect.flatMap(Governor, (g) => g.consume("transactional", 20)))
      await run(sweepAlerts())
      expect(await openAlert("quota_100")).toMatchObject({ kind: "quota_100", severity: "critical" })
      expect(await openAlert("quota_80")).toBeNull()
    } finally {
      await run(Effect.flatMap(Governor, (g) => g.configure({ dailyQuota: before.config.dailyQuota })))
    }
    await run(sweepAlerts())
    expect(await openAlert("quota_100")).toBeNull()
  })
})

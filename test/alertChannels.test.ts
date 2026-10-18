import { env } from "cloudflare:workers"
import type * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { raiseAlert } from "../src/domain/alerts.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { ADMIN, call, json } from "./helpers.ts"

const uid = () => crypto.randomUUID().slice(0, 8)
// biome-ignore lint/suspicious/noExplicitAny: the app's services, provided by the runtime.
const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  runtimeFor(env).runPromise(effect as never) as Promise<A>

type View = {
  channels: Array<{ kind: string; target: string; kinds?: string[]; minSeverity: string }>
  defaultEmail: string | null
  effective: { criticalEmail: string | null; note: string | null }
}
const put = (body: unknown) => call("/v1/settings/alerts", { method: "PUT", key: ADMIN, json: body })
const get = () => call("/v1/settings/alerts", { key: ADMIN }).then((r) => json<View>(r))

/** A paused endpoint: deliveries are recorded and held, nothing leaves the Worker. */
const endpoint = async (events: string[]) => {
  const r = await call("/v1/webhooks", {
    method: "POST",
    key: ADMIN,
    json: { url: `https://hooks.test/${uid()}`, events, paused: true },
  })
  expect(r.status).toBe(200)
  return (await json<{ endpoint: { id: string } }>(r)).endpoint.id
}
const deliveries = async (endpointId: string) =>
  (
    await env.DB.prepare(
      "select payload from webhook_deliveries where endpoint_id = ? and event_type = 'alert.raised' order by created_at, rowid",
    )
      .bind(endpointId)
      .all<{ payload: string }>()
  ).results.map((d) => (JSON.parse(d.payload) as { data: Record<string, unknown> }).data)

const mailTo = async (email: string) =>
  (
    await env.DB.prepare(
      "select subject, stream, contact_id as contactId from messages_out where recipient = ? order by created_at, rowid",
    )
      .bind(email)
      .all<{ subject: string; stream: string; contactId: string | null }>()
  ).results

const alert = (key: string, kind: "bounce_spike" | "quota_80", severity: "info" | "warning" | "critical") =>
  run(raiseAlert({ key, kind, severity, title: `Alert ${key}`, detail: "Something to look at." }))

describe("alert channels (HAL-3465)", () => {
  it("starts with no channels and says alerts only reach the drawer", async () => {
    await put({ channels: [] })
    const view = await get()
    expect(view).toMatchObject({ channels: [], defaultEmail: null, effective: { criticalEmail: null } })
    expect(view.effective.note).toContain("only show in the app")
  })

  it("refuses a bad address, an unknown endpoint and an unknown alert kind", async () => {
    const bad = await put({ channels: [{ kind: "email", target: "not-an-address", minSeverity: "warning" }] })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ field: "channels[0].target" })
    const missing = await put({ channels: [{ kind: "webhook", target: "whk_nope", minSeverity: "info" }] })
    expect(missing.status).toBe(400)
    expect(await json(missing)).toMatchObject({ field: "channels[0].target" })
    const kind = await put({
      channels: [{ kind: "email", target: "a@example.org", kinds: ["nonsense"], minSeverity: "info" }],
    })
    expect(kind.status).toBe(400)
    const fallback = await put({ channels: [], defaultEmail: "nope" })
    expect(fallback.status).toBe(400)
  })

  it("mails and posts on open and on a rise in severity, filtered by kind and severity", async () => {
    const ops = `ops-${uid()}@example.org`
    const hook = await endpoint(["contact.created"])
    const saved = await put({
      channels: [
        { kind: "email", target: ops.toUpperCase(), kinds: ["bounce_spike"], minSeverity: "warning" },
        { kind: "webhook", target: hook, minSeverity: "critical" },
      ],
    })
    expect(saved.status).toBe(200)
    const view = await json<View>(saved)
    expect(view.channels[0]?.target).toBe(ops)
    expect(view.effective).toEqual({ criticalEmail: null, note: null })

    const key = `bounce_spike:${uid()}`
    await alert(key, "bounce_spike", "info")
    expect(await mailTo(ops)).toEqual([]) // below the channel's severity

    await alert(key, "bounce_spike", "warning")
    // A refresh that rises from info to warning: the email channel takes it now.
    let mail = await mailTo(ops)
    expect(mail).toHaveLength(1)
    expect(mail[0]).toMatchObject({ stream: "system", contactId: null, subject: `[warning] Alert ${key}` })
    expect(await deliveries(hook)).toEqual([])

    // The same severity again only counts; nobody hears twice.
    await alert(key, "bounce_spike", "warning")
    expect(await mailTo(ops)).toHaveLength(1)

    await alert(key, "bounce_spike", "critical")
    mail = await mailTo(ops)
    expect(mail.map((m) => m.subject)).toEqual([`[warning] Alert ${key}`, `[critical] Alert ${key}`])
    const posted = await deliveries(hook)
    expect(posted).toEqual([
      expect.objectContaining({ key, kind: "bounce_spike", severity: "critical", escalated: true }),
    ])

    // Another kind skips the kind-filtered email channel but reaches the all-kinds webhook.
    const quota = `quota_80:${uid()}`
    await alert(quota, "quota_80", "critical")
    expect(await mailTo(ops)).toHaveLength(2)
    expect((await deliveries(hook)).map((d) => d.key)).toEqual([key, quota])
  })

  it("sends alert.raised to every subscribed endpoint once, channel or not", async () => {
    const subscribed = await endpoint(["alert.raised"])
    await put({ channels: [{ kind: "webhook", target: subscribed, minSeverity: "info" }] })
    const key = `bounce_spike:${uid()}`
    await alert(key, "bounce_spike", "info")
    const posted = await deliveries(subscribed)
    expect(posted).toEqual([
      expect.objectContaining({ key, severity: "info", escalated: false, alertId: expect.any(String) }),
    ])
  })

  it("with no channels, mails critical alerts to the fallback address only", async () => {
    const fallback = `owner-${uid()}@example.org`
    const view = await json<View>(await put({ channels: [], defaultEmail: fallback }))
    expect(view.effective.criticalEmail).toBe(fallback)
    expect(view.effective.note).toContain(fallback)

    await alert(`bounce_spike:${uid()}`, "bounce_spike", "warning")
    expect(await mailTo(fallback)).toEqual([])
    const key = `bounce_spike:${uid()}`
    await alert(key, "bounce_spike", "critical")
    expect((await mailTo(fallback)).map((m) => m.subject)).toEqual([`[critical] Alert ${key}`])

    const audit = await json<{ entries: Array<{ action: string }> }>(
      await call("/v1/audit?action=settings.alerts", { key: ADMIN }),
    )
    expect(audit.entries.length).toBeGreaterThan(0)
  })
})

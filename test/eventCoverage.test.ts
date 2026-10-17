import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Env } from "../src/Bindings.ts"
import { eventCoverage } from "../src/domain/eventCoverage.ts"
import worker from "../src/workers/api.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "./dns.ts"
import { ADMIN, call, json } from "./helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const HOUR = 3_600_000

/** A sending domain with `rows` messages from it, each `ageHours` old, in the given statuses. */
const domainWith = async (statuses: ReadonlyArray<string>, ageHours = 7) => {
  const name = `ev-${uid()}.test`
  setDns(goodDomain(name))
  const res = await call("/v1/domains", {
    method: "POST",
    key: ADMIN,
    json: { name, sending: true, receiving: false },
  })
  if (res.status !== 200 && res.status !== 201) throw new Error(`domain: ${await res.text()}`)
  for (const status of statuses) {
    await env.DB.prepare(
      "insert into messages_out (id, stream, recipient, sender, subject, status, created_at) values (?, 'transactional', 'a@example.net', ?, 's', ?, ?)",
    )
      .bind(`msg_${uid()}${uid()}`, `news@${name}`, status, Date.now() - ageHours * HOUR)
      .run()
  }
  return name
}

type Coverage = {
  domain: string
  subscribed: boolean | null
  withEvents: number
  silent: number
  status: string
  detail: string
}
const coverageOf = async (domain: string) =>
  (await json<{ domains: Array<Coverage> }>(await call("/v1/sending/events", { key: ADMIN }))).domains.find(
    (d) => d.domain === domain,
  )

const openAlert = async (domain: string) =>
  env.DB.prepare("select id, severity, title from alerts where key = ? and resolved_at is null")
    .bind(`delivery-events:${domain}`)
    .first<{ id: string; severity: string; title: string }>()

const runCron = async () => {
  const ctx = createExecutionContext()
  worker.scheduled?.(createScheduledController({ scheduledTime: Date.now(), cron: "23 * * * *" }), env, ctx)
  await waitOnExecutionContext(ctx)
}

describe("delivery-events coverage from the ledger", () => {
  it("warns about a domain whose old mail never had an event, and trusts one whose mail did", async () => {
    const silent = await domainWith(["sent", "sent"])
    const flowing = await domainWith(["delivered", "sent", "bounced"])
    const young = await domainWith(["sent"], 1)
    const idle = await domainWith([])

    expect(await coverageOf(silent)).toMatchObject({
      status: "warn",
      silent: 2,
      withEvents: 0,
      subscribed: null,
    })
    expect((await coverageOf(silent))?.detail).toContain("2 messages")
    expect(await coverageOf(flowing)).toMatchObject({ status: "ok", withEvents: 2, silent: 1 })
    // Mail an hour old is still within its six hours; nothing to judge yet.
    expect(await coverageOf(young)).toMatchObject({ status: "unknown", silent: 0 })
    expect(await coverageOf(idle)).toMatchObject({ status: "unknown" })

    // The health strip fails on it, and the campaign pre-flight warns.
    const health = await json<{ checks: Array<{ name: string; status: string; detail: string }> }>(
      await call("/v1/health", { key: ADMIN }),
    )
    const check = health.checks.find((c) => c.name === "delivery_events")
    expect(check?.status).toBe("fail")
    expect(check?.detail).toContain(silent)
    const campaign = await json<{ id: string }>(
      await call("/v1/campaigns", {
        method: "POST",
        key: ADMIN,
        json: { name: "C", fromAddress: `news@${silent}`, subject: "S", bodyHtml: "<p>Hi</p>" },
      }),
    )
    const checks = await json<{ checks: Array<{ id: string; status: string }> }>(
      await call(`/v1/campaigns/${campaign.id}/checks`, { key: ADMIN }),
    )
    expect(checks.checks.find((c) => c.id === "delivery_events")?.status).toBe("warn")
  })

  it("the hourly cron opens a critical alert, keeps one per domain, and closes it once events arrive", async () => {
    const silent = await domainWith(["sent"])
    await runCron()
    const alert = await openAlert(silent)
    expect(alert).toMatchObject({ severity: "critical", title: `No delivery events for ${silent}` })
    await runCron()
    const count = await env.DB.prepare("select count(*) as n from alerts where key = ?")
      .bind(`delivery-events:${silent}`)
      .first<{ n: number }>()
    expect(count?.n).toBe(1)

    await env.DB.prepare("update messages_out set status = 'delivered' where sender = ?")
      .bind(`news@${silent}`)
      .run()
    await runCron()
    expect(await openAlert(silent)).toBeNull()
  })
})

describe("delivery-events coverage from the account's subscriptions", () => {
  /** The Cloudflare API as the read-only token sees it: our queue, and subscriptions for `domains`. */
  const withApi = async <A>(subscribed: ReadonlyArray<string>, run: (bindings: Env) => Promise<A>) => {
    const realFetch = globalThis.fetch
    const seen: Array<string> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url)
      if (url.hostname !== "api.cloudflare.com") return realFetch(input, init)
      seen.push(`${url.pathname}${url.search}`)
      if (url.pathname.endsWith("/queues"))
        return Response.json({
          success: true,
          result: [{ queue_id: "q-events", queue_name: "mailyard-email-events" }],
        })
      if (url.pathname.endsWith("/event_subscriptions/subscriptions"))
        return Response.json({
          success: true,
          result: [
            ...subscribed.map((domain) => ({
              enabled: true,
              source: { type: "email.sending", domain },
              destination: { type: "queues.queue", queue_id: "q-events" },
            })),
            // Another app's queue, and a disabled one: neither counts.
            {
              enabled: true,
              source: { type: "email.sending", domain: "other.test" },
              destination: { type: "queues.queue", queue_id: "q-other" },
            },
            ...subscribed.map((domain) => ({
              enabled: false,
              source: { type: "email.sending", domain: `off.${domain}` },
              destination: { type: "queues.queue", queue_id: "q-events" },
            })),
          ],
          result_info: { total_pages: 1 },
        })
      return Response.json({ success: false, result: null })
    }) as typeof fetch
    try {
      const bindings = { ...env, CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_EMAIL_READ_TOKEN: "tok" } as Env
      return { result: await run(bindings), seen }
    } finally {
      globalThis.fetch = realFetch
    }
  }

  it("warns about a sending domain with no subscription even before any mail is sent", async () => {
    const covered = await domainWith([])
    const missing = await domainWith([])
    const { result, seen } = await withApi([covered], (b) => runtimeFor(b).runPromise(eventCoverage()))
    expect(result.find((c) => c.domain === covered)).toMatchObject({ status: "ok", subscribed: true })
    const gap = result.find((c) => c.domain === missing)
    expect(gap).toMatchObject({ status: "warn", subscribed: false })
    expect(gap?.detail).toContain("no delivery-events subscription")
    expect(seen).toContain("/client/v4/accounts/acct/queues?name=mailyard-email-events")
  })

  it("says unknown, never ok, when the token can't read the subscriptions", async () => {
    const name = await domainWith([])
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(new Request(input, init).url).hostname === "api.cloudflare.com"
        ? Response.json(
            { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null },
            { status: 403 },
          )
        : realFetch(input, init)) as typeof fetch
    try {
      const bindings = { ...env, CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_EMAIL_READ_TOKEN: "tok" } as Env
      const result = await runtimeFor(bindings).runPromise(eventCoverage(name))
      expect(result).toEqual([expect.objectContaining({ domain: name, status: "unknown", subscribed: null })])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

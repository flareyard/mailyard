import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeAll, describe, expect, it } from "vitest"
import { Bindings } from "../../src/Bindings.ts"
import { forecast, reputation, usage } from "../../src/domain/insights.ts"
import { CloudflareEmail } from "../../src/services/CloudflareEmail.ts"
import { Database } from "../../src/services/Database.ts"
import { call, createKey, json } from "../helpers.ts"

let key = ""
beforeAll(async () => {
  key = (await createKey("secret")).key
})

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)

const seed = async (
  rows: Array<{
    day: string
    stream?: string
    provider?: string
    sent?: number
    delivered?: number
    bouncedHard?: number
    complained?: number
  }>,
) => {
  await env.DB.prepare("delete from daily_stats").run()
  for (const r of rows) {
    await env.DB.prepare(
      "insert into daily_stats (day, stream, provider, sent, delivered, bounced_hard, complained) values (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        r.day,
        r.stream ?? "transactional",
        r.provider ?? "",
        r.sent ?? 0,
        r.delivered ?? 0,
        r.bouncedHard ?? 0,
        r.complained ?? 0,
      )
      .run()
  }
}

describe("without a Cloudflare read token", () => {
  it("reports what Mailyard knows and leaves the quota and reputation unknown, not guessed", async () => {
    await seed([{ day: day(0), sent: 12 }])
    const u = await json<{ today: { sent: number; quota: number | null; source: string } }>(
      await call("/v1/usage", { key }),
    )
    expect(u.today).toMatchObject({ sent: 12, quota: null, source: "not-connected" })

    const f = await json<{ possible: boolean; reason?: string }>(
      await call("/v1/usage/forecast?recipients=500", { key }),
    )
    expect(f.possible).toBe(false)

    const r = await json<{ source: string; policySource: string; status: string | null }>(
      await call("/v1/reputation", { key }),
    )
    expect(r).toMatchObject({ source: "not-connected", policySource: "measured-2026-10-16", status: null })
  })

  it("shows the health strip, flagging the in-memory sender", async () => {
    const h = await json<{ status: string; checks: Array<{ name: string; status: string }> }>(
      await call("/v1/health", { key }),
    )
    expect(h.checks.find((c) => c.name === "database")?.status).toBe("ok")
    expect(h.checks.find((c) => c.name === "sending")?.status).toBe("warn")
    expect(h.checks.find((c) => c.name === "quota")?.status).toBe("unknown")
    expect(h.status).toBe("warn")
  })
})

describe("rates", () => {
  it("are null under 100 sends, so a handful of bounces can't look like a crisis", async () => {
    await seed([{ day: day(0), sent: 20, delivered: 18, bouncedHard: 2 }])
    const d = await json<{ rates: { insufficientData: boolean; bounceRate: number | null } }>(
      await call("/v1/stats/delivery?range=7d", { key }),
    )
    expect(d.rates).toMatchObject({ insufficientData: true, bounceRate: null })
  })

  it("are computed over enough volume and judged against the thresholds", async () => {
    await seed([
      { day: day(0), sent: 100, delivered: 97, bouncedHard: 3, complained: 0 },
      { day: day(3), sent: 100, delivered: 99, bouncedHard: 1, complained: 0 },
    ])
    const d = await json<{ totals: { sent: number }; rates: { bounceRate: number; deliveryRate: number } }>(
      await call("/v1/stats/delivery?range=7d", { key }),
    )
    expect(d.totals.sent).toBe(200)
    expect(d.rates.bounceRate).toBeCloseTo(0.02)
    expect(d.rates.deliveryRate).toBeCloseTo(0.98)
    const r = await json<{ levels: { bounce: string; complaint: string } }>(
      await call("/v1/reputation", { key }),
    )
    // 2% sits exactly on the warning line (warning_at 0.02), below at-risk (0.05).
    expect(r.levels).toEqual({ bounce: "warning", complaint: "ok", spamRejection: "ok" })
  })

  it("exclude days outside the range", async () => {
    await seed([
      { day: day(0), sent: 10 },
      { day: day(10), sent: 500 },
    ])
    const week = await json<{ totals: { sent: number } }>(await call("/v1/stats/delivery?range=7d", { key }))
    const month = await json<{ totals: { sent: number } }>(
      await call("/v1/stats/delivery?range=30d", { key }),
    )
    expect([week.totals.sent, month.totals.sent]).toEqual([10, 510])
  })
})

describe("volume and providers", () => {
  it("lists every day in the range, zeros included, split by stream", async () => {
    await seed([
      { day: day(0), stream: "transactional", sent: 5 },
      { day: day(0), stream: "campaign", sent: 7 },
      { day: day(2), stream: "transactional", sent: 1 },
    ])
    const v = await json<{
      days: Array<{ day: string; byStream: Record<string, number> }>
      streams: Array<string>
    }>(await call("/v1/stats/volume?range=7d", { key }))
    expect(v.days).toHaveLength(7)
    expect(v.streams).toEqual(["campaign", "transactional"])
    expect(v.days.at(-1)).toEqual({ day: day(0), byStream: { campaign: 7, transactional: 5 } })
    expect(v.days.at(-2)?.byStream).toEqual({ campaign: 0, transactional: 0 })
  })

  it("ranks mailbox providers by volume", async () => {
    await seed([
      { day: day(0), provider: "gmail", delivered: 40 },
      { day: day(0), provider: "outlook", delivered: 10, bouncedHard: 2 },
      { day: day(0), provider: "", sent: 52 },
    ])
    const p = await json<{ providers: Array<{ provider: string; total: number }> }>(
      await call("/v1/stats/providers", { key }),
    )
    expect(p.providers.map((x) => [x.provider, x.total])).toEqual([
      ["gmail", 40],
      ["outlook", 12],
    ])
  })
})

describe("usage", () => {
  it("prices the month: 3,000 included, then $0.35 per 1,000", async () => {
    await seed([{ day: day(0), sent: 4000 }])
    const u = await json<{
      month: { billed: number; overage: number; costUsd: number }
      pricing: { measuredAt: string }
    }>(await call("/v1/usage", { key }))
    // Only today's row counts if it's in this month, which it always is.
    expect(u.month).toMatchObject({ billed: 4000, overage: 1000, costUsd: 0.35 })
    expect(u.pricing.measuredAt).toBe("2026-10-16")
  })
})

describe("with a read-only Cloudflare token", () => {
  // Response bodies as the API returned them for the founder's account on 2026-10-16.
  const limits = {
    success: true,
    result: {
      quota: { value: 1000, unit: "day" },
      usage: { sent: 400, over_quota: false, resets_at: "2026-10-17T00:00:00Z" },
    },
  }
  const rep = {
    success: true,
    result: {
      status: "healthy",
      status_since: null,
      grace_started_at: null,
      evaluated_at: null,
      active_policy: {
        customer_bounce: { warning_at: 0.02, at_risk_at: 0.05, minimum_denominator: 100 },
        complaint: { warning_at: 0.001, at_risk_at: 0.002, minimum_denominator: 100 },
        spam_rejection: { warning_at: 0.01, at_risk_at: 0.03, minimum_denominator: 100 },
        suspension_after_hours: 168,
      },
    },
  }

  const run = <A, E>(effect: Effect.Effect<A, E, Database | CloudflareEmail | Bindings>) => {
    const bindings = Layer.succeed(Bindings, {
      ...env,
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_EMAIL_READ_TOKEN: "tok",
    })
    const layer = Layer.mergeAll(Database.layer, CloudflareEmail.layer).pipe(Layer.provideMerge(bindings))
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url
      if (url.endsWith("/accounts/acc/email/sending/limits")) return Response.json(limits)
      if (url.endsWith("/accounts/acc/email/sending/reputation")) return Response.json(rep)
      return real(input, init)
    }) as typeof fetch
    return Effect.runPromise(effect.pipe(Effect.provide(layer))).finally(() => {
      globalThis.fetch = real
    })
  }

  it("reads today's quota and forecasts a send against it", async () => {
    await seed([{ day: day(0), sent: 400 }])
    const u = await run(usage())
    expect(u.today).toMatchObject({ sent: 400, quota: 1000, remaining: 600, source: "cloudflare" })
    const f = await run(forecast(2000))
    expect(f).toMatchObject({ possible: true, quota: 1000, sendableToday: 600, additionalDays: 2 })
  })

  it("reports Cloudflare's own verdict and the account's policy", async () => {
    const r = await run(reputation())
    expect(r).toMatchObject({ status: "healthy", source: "cloudflare", policySource: "account" })
  })
})

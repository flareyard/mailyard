import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { engagementStats } from "../domain/engagement.ts"
import { deferralStats, deliveryStats, providerStats, type Range, volumeStats } from "../domain/insights.ts"
import { audienceStats, inboundStats } from "../domain/overview.ts"
import { authorize, problem } from "./auth.ts"
import { runtimeFor } from "./inbound.ts"

/**
 * `GET /v1/stats/{chart}.csv` (HAL-3421): each Analytics chart as CSV, from the same functions as its
 * JSON endpoint, so the two can't disagree. Rates stay fractions (0.021, not 2.1%); empty means not
 * enough data. Needs a secret key with read.
 */
export const STATS_CSV_PATH = /^\/v1\/stats\/([a-z-]+)\.csv$/

export const CSV_CHARTS = [
  "volume",
  "delivery",
  "providers",
  "deferrals",
  "engagement",
  "engagement-hours",
  "unsubscribes",
  "inbound",
  "audience",
] as const
type Chart = (typeof CSV_CHARTS)[number]

type Cell = string | number | boolean | null | undefined
type Table = { readonly columns: ReadonlyArray<string>; readonly rows: ReadonlyArray<ReadonlyArray<Cell>> }

/** RFC 4180: quote a cell holding a comma, quote or line break; a leading = + - @ is neutralised for spreadsheets. */
const cell = (v: Cell) => {
  if (v === null || v === undefined) return ""
  const s = String(v)
  const safe = /^[=+\-@]/.test(s) && typeof v === "string" ? `'${s}` : s
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export const toCsv = (t: Table) =>
  `${[t.columns, ...t.rows].map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`

const RANGES = ["24h", "7d", "30d"] as const
const STATS_RANGES = ["24h", "7d", "30d", "90d"] as const

const tableFor = (chart: Chart, url: URL) =>
  Effect.gen(function* () {
    const raw = url.searchParams.get("range") ?? "30d"
    const range = ((RANGES as ReadonlyArray<string>).includes(raw) ? raw : "30d") as Range
    switch (chart) {
      case "volume": {
        const v = yield* volumeStats(range, url.searchParams.get("by") === "hour" ? "hour" : "day")
        const points =
          v.by === "hour"
            ? v.hours.map((h) => ({ at: h.hour, s: h.byStream }))
            : v.days.map((d) => ({ at: d.day, s: d.byStream }))
        return {
          columns: [v.by, "transactional", "campaign", "automation", "mailbox"],
          rows: points.map((p) => [p.at, p.s.transactional, p.s.campaign, p.s.automation, p.s.mailbox]),
        }
      }
      case "delivery": {
        const d = yield* deliveryStats(range, "day")
        return {
          columns: [
            "day",
            "sent",
            "delivered",
            "deferred",
            "bouncedHard",
            "bouncedSoft",
            "complained",
            "rejected",
            "failed",
            "deliveryRate",
            "bounceRate",
            "complaintRate",
            "rejectionRate",
            "insufficientData",
          ],
          rows: d.days.map((x) => [
            x.day,
            x.totals.sent,
            x.totals.delivered,
            x.totals.deferred,
            x.totals.bouncedHard,
            x.totals.bouncedSoft,
            x.totals.complained,
            x.totals.rejected,
            x.totals.failed,
            x.rates.deliveryRate,
            x.rates.bounceRate,
            x.rates.complaintRate,
            x.rates.rejectionRate,
            x.rates.insufficientData,
          ]),
        }
      }
      case "providers": {
        const p = yield* providerStats(range)
        return {
          columns: ["provider", "delivered", "deferred", "bounced", "complained", "total"],
          rows: p.providers.map((x) => [
            x.provider,
            x.delivered,
            x.deferred,
            x.bounced,
            x.complained,
            x.total,
          ]),
        }
      }
      case "deferrals": {
        const d = yield* deferralStats(range)
        return {
          columns: ["reason", "smtpStatus", "provider", "count"],
          rows: d.reasons.map((r) => [r.reason, r.smtpStatus, r.provider, r.count]),
        }
      }
      case "engagement": {
        const e = yield* engagementStats(range)
        return {
          columns: [
            "campaignId",
            "name",
            "startedAt",
            "delivered",
            "uniqueOpens",
            "machineOpens",
            "uniqueClicks",
            "unsubscribed",
            "openRate",
            "clickRate",
          ],
          rows: e.campaigns.map((c) => [
            c.id,
            c.name,
            new Date(c.startedAt).toISOString(),
            c.delivered,
            c.uniqueOpens,
            c.machineOpens,
            c.uniqueClicks,
            c.unsubscribed,
            c.openRate,
            c.clickRate,
          ]),
        }
      }
      case "engagement-hours": {
        const e = yield* engagementStats(range)
        return {
          columns: ["weekday", "hourUtc", "opens", "clicks"],
          rows: e.byHour.flatMap((d) => d.hours.map((h) => [d.weekday, h.hour, h.opens, h.clicks])),
        }
      }
      case "unsubscribes": {
        const e = yield* engagementStats(range)
        return {
          columns: ["topicId", "topic", "unsubscribed"],
          rows: e.unsubscribesByTopic.map((t) => [t.topicId, t.name, t.unsubscribed]),
        }
      }
      case "inbound": {
        const r = url.searchParams.get("range") ?? "30d"
        const i = yield* inboundStats(
          ((STATS_RANGES as ReadonlyArray<string>).includes(r) ? r : "30d") as never,
        )
        return {
          columns: ["day", "received", "rejected", "spam"],
          rows: i.days.map((d) => [d.day, d.received, d.rejected, d.spam]),
        }
      }
      case "audience": {
        const r = url.searchParams.get("range") ?? "30d"
        const a = yield* audienceStats(
          ((STATS_RANGES as ReadonlyArray<string>).includes(r) ? r : "30d") as never,
        )
        return { columns: ["day", "total"], rows: a.totalByDay.map((d) => [d.day, d.total]) }
      }
    }
  })

export const handleStatsCsv = async (request: Request, env: Env, chart: string) => {
  if (request.method !== "GET") return problem(405, "Use GET.")
  if (!(CSV_CHARTS as ReadonlyArray<string>).includes(chart))
    return problem(404, `No chart ${chart}. Charts: ${CSV_CHARTS.join(", ")}.`)
  const auth = await authorize(request, env)
  if (auth instanceof Response) return auth
  if (auth.caller.kind !== "secret" || !auth.caller.scopes.includes("read"))
    return problem(403, "This needs a secret key with the read scope.", {
      reason: auth.caller.kind === "public" ? "public-key" : "insufficient-scope",
      required: "read",
    })
  const url = new URL(request.url)
  const table = await runtimeFor(env).runPromise(tableFor(chart as Chart, url).pipe(Effect.orDie))
  const range = url.searchParams.get("range") ?? "30d"
  return new Response(toCsv(table), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="mailyard-${chart}-${range}.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  })
}

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import {
  campaignEngagement,
  campaigns,
  engagementHourly,
  mailboxExports,
  mailboxes,
  subscriptionChanges,
  topics,
  uploads,
} from "../db/schema.ts"
import { Database, queryIn } from "../services/Database.ts"
import { Mailboxes } from "../services/Mailboxes.ts"
import { type Range, since } from "./insights.ts"
import { HOLDS_MAIL } from "./mailboxes.ts"

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

const rate = (n: number, of: number) => (of > 0 ? n / of : null)

/**
 * `GET /v1/stats/engagement` (HAL-3421): campaigns started in the range side by side, when people
 * open and click (a weekday × hour grid in UTC), and which topics people left. Opens are estimates:
 * privacy proxies open mail for people, so machine opens are counted apart and never as people.
 */
export const engagementStats = Effect.fn("stats.engagement")(function* (range: Range) {
  const database = yield* Database
  const from = since(range)
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const started = yield* database.query("stats.engagementCampaigns", (db) =>
    db
      .select({ id: campaigns.id, name: campaigns.name, startedAt: campaigns.startedAt })
      .from(campaigns)
      .where(gte(campaigns.startedAt, fromMs))
      .orderBy(desc(campaigns.startedAt))
      .limit(100)
      .all(),
  )
  const counts = yield* queryIn(
    "stats.engagementCounts",
    started.map((c) => c.id),
    (db, chunk) =>
      db.select().from(campaignEngagement).where(inArray(campaignEngagement.campaignId, chunk)).all(),
  )
  const grid = yield* database.query("stats.engagementGrid", (db) =>
    db
      .select({
        day: engagementHourly.day,
        hour: engagementHourly.hour,
        opens: engagementHourly.opens,
        clicks: engagementHourly.clicks,
      })
      .from(engagementHourly)
      .where(gte(engagementHourly.day, from))
      .all(),
  )
  const byHour = WEEKDAYS.map((weekday) => ({
    weekday,
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, opens: 0, clicks: 0 })),
  }))
  for (const g of grid) {
    // getUTCDay: 0 is Sunday; the grid starts on Monday.
    const dow = (new Date(`${g.day}T00:00:00Z`).getUTCDay() + 6) % 7
    const cell = byHour[dow]?.hours[g.hour]
    if (cell) {
      cell.opens += g.opens
      cell.clicks += g.clicks
    }
  }
  const left = yield* database.query("stats.engagementTopics", (db) =>
    db
      .select({ topicId: subscriptionChanges.topicId, name: topics.name, n: sql<number>`count(*)` })
      .from(subscriptionChanges)
      .innerJoin(topics, eq(topics.id, subscriptionChanges.topicId))
      .where(and(eq(subscriptionChanges.to, "unsubscribed"), gte(subscriptionChanges.at, fromMs)))
      .groupBy(subscriptionChanges.topicId, topics.name)
      .all(),
  )
  return {
    range,
    from,
    estimate: true as const,
    campaigns: started.map((c) => {
      const e = counts.find((x) => x.campaignId === c.id)
      const delivered = e?.delivered ?? 0
      return {
        id: c.id,
        name: c.name,
        startedAt: c.startedAt as number,
        delivered,
        uniqueOpens: e?.uniqueOpens ?? 0,
        machineOpens: e?.machineOpens ?? 0,
        uniqueClicks: e?.uniqueClicks ?? 0,
        unsubscribed: e?.unsubscribed ?? 0,
        openRate: rate(e?.uniqueOpens ?? 0, delivered),
        clickRate: rate(e?.uniqueClicks ?? 0, delivered),
      }
    }),
    byHour,
    unsubscribesByTopic: left
      .map((t) => ({ topicId: t.topicId, name: t.name, unsubscribed: Number(t.n) }))
      .sort((a, b) => b.unsubscribed - a.unsubscribed),
  }
})

/**
 * `GET /v1/usage/storage` (HAL-3421): what Mailyard keeps in R2, from the sizes it recorded when it
 * stored each thing, never by listing the bucket. Mailboxes count their originals and attachments;
 * exports their zips; uploads their files. Rendered copies of sent mail are small and not counted.
 */
export const storageUsage = Effect.fn("stats.storage")(function* () {
  const database = yield* Database
  const boxes = yield* database.query("stats.storageMailboxes", (db) =>
    db.select({ id: mailboxes.id, address: mailboxes.address, kind: mailboxes.kind }).from(mailboxes).all(),
  )
  const store = yield* Mailboxes
  const byMailbox = yield* Effect.forEach(
    boxes.filter((b) => HOLDS_MAIL.has(b.kind)),
    (b) =>
      store.storage(b.id).pipe(
        Effect.map((s) => ({ mailboxId: b.id, address: b.address, messages: s.messages, bytes: s.bytes })),
        Effect.orElseSucceed(() => ({ mailboxId: b.id, address: b.address, messages: null, bytes: null })),
      ),
    { concurrency: 8 },
  )
  const exportsRow = yield* database.query("stats.storageExports", (db) =>
    db
      .select({ bytes: sql<number>`coalesce(sum(${mailboxExports.zipSize}), 0)` })
      .from(mailboxExports)
      .get(),
  )
  const uploadsRow = yield* database.query("stats.storageUploads", (db) =>
    db
      .select({ bytes: sql<number>`coalesce(sum(${uploads.size}), 0)` })
      .from(uploads)
      .get(),
  )
  const mail = byMailbox.reduce((a, b) => a + (b.bytes ?? 0), 0)
  const exportsBytes = Number(exportsRow?.bytes ?? 0)
  const uploadsBytes = Number(uploadsRow?.bytes ?? 0)
  return {
    totalBytes: mail + exportsBytes + uploadsBytes,
    mailBytes: mail,
    exportsBytes,
    uploadsBytes,
    /** A mailbox that didn't answer has null counts and isn't in the total. */
    byMailbox: byMailbox.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1)),
    measuredAt: Date.now(),
  }
})

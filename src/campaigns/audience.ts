import { inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import { type campaigns, segments } from "../db/schema.ts"
import { segmentCondition } from "../domain/segments.ts"
import { D1_MAX_PARAMS, Database } from "../services/Database.ts"

type CampaignRow = typeof campaigns.$inferSelect
type AudienceOf = Pick<CampaignRow, "id" | "segmentId" | "topicId" | "exclude">

const DAY_MS = 86_400_000

/** The most segments a campaign can leave out, and how far back "recently sent" reaches. */
export const EXCLUDE_LIMITS = { segments: 10, recentlySentDays: 90 } as const

/**
 * Other campaigns' mail to this contact since `?` (this campaign's own test sends and earlier
 * chunks don't count): served by messages_out(contact_id, created_at).
 */
const RECENTLY_SENT =
  "exists (select 1 from messages_out m where m.contact_id = contacts.id and m.stream = 'campaign' and m.created_at >= ? and m.campaign_id is not ?)"

/**
 * Who a campaign goes to: the contacts its segment matches (everyone without one), who are
 * subscribed overall, subscribed to its topic when it has one, not on the suppression list, and
 * not left out by its exclusions. As raw SQL over `contacts` with its parameters, so a send can
 * page through it.
 */
export const audienceSql = Effect.fn("audience.sql")(function* (
  campaign: AudienceOf,
  options: {
    readonly now?: number
    /** A compiled filter to use in place of the campaign's segment (a resend's dry run). */
    readonly segment?: { readonly sql: string; readonly params: ReadonlyArray<unknown> }
  } = {},
) {
  const now = options.now ?? Date.now()
  const segment =
    options.segment ??
    (campaign.segmentId
      ? yield* segmentCondition(campaign.segmentId)
      : { sql: "1", params: [] as ReadonlyArray<unknown> })
  const onTopic = campaign.topicId
    ? `exists (select 1 from subscriptions s where s.contact_id = contacts.id and s.topic_id = ? and s.state = 'subscribed')`
    : "1"
  const excludedSegments: Array<{ id: string; sql: string; params: ReadonlyArray<unknown> }> = []
  for (const id of campaign.exclude?.segmentIds ?? []) {
    const c = yield* segmentCondition(id)
    excludedSegments.push({ id, ...c })
  }
  const days = campaign.exclude?.recentlySentDays ?? null
  const recent = days === null ? null : { sql: RECENTLY_SENT, params: [now - days * DAY_MS, campaign.id] }
  const leaveOut = [
    ...excludedSegments.map((s) => `not (${s.sql})`),
    ...(recent ? [`not ${recent.sql}`] : []),
  ]
  return {
    segment,
    onTopic: { sql: onTopic, params: campaign.topicId ? [campaign.topicId] : [] },
    excludedSegments,
    recent,
    /** The full condition for a sendable recipient. */
    where: `(${segment.sql}) and contacts.status = 'subscribed' and (${onTopic}) and not exists (select 1 from suppressions x where x.email = contacts.email)${leaveOut.map((c) => ` and ${c}`).join("")}`,
    params: [
      ...segment.params,
      ...(campaign.topicId ? [campaign.topicId] : []),
      ...excludedSegments.flatMap((s) => s.params),
      ...(recent ? recent.params : []),
    ],
  }
})

/**
 * Whether a campaign's audience still fits one D1 statement: the preview binds every parameter
 * once, and a send binds them beside a slice of contact ids. Null when it fits, else why not.
 */
export const audienceTooComplex = (a: { readonly params: ReadonlyArray<unknown> }) =>
  a.params.length > D1_MAX_PARAMS
    ? "The segment and its exclusions are too complex together; leave out fewer segments, or simplify one."
    : null

/** Contact ids a chunk lookup can bind beside the audience's own parameters (D1 binds at most 100). */
export const idSliceFor = (a: { readonly params: ReadonlyArray<unknown> }, wanted: number) =>
  Math.max(1, Math.min(wanted, 100 - a.params.length))

/** The segment's size, what can be sent, and why the rest can't: the editor's audience line. */
export const audiencePreview = Effect.fn("audience.preview")(function* (
  campaign: AudienceOf,
  segment?: { readonly sql: string; readonly params: ReadonlyArray<unknown> },
) {
  const { DB } = yield* Bindings
  const a = yield* audienceSql(campaign, segment ? { segment } : {})
  // The first exclusion that matches a contact claims it, so the buckets still add up to the total.
  const exSeg = a.excludedSegments.length
    ? `case ${a.excludedSegments.map((s, i) => `when (${s.sql}) then ${i}`).join(" ")} else null end`
    : "null"
  const row = yield* Effect.promise(() =>
    DB.prepare(
      // Each contact lands in exactly one bucket, so the buckets add up to the segment's size.
      `with c as (
         select status in ('bounced', 'complained', 'suppressed') or exists (select 1 from suppressions x where x.email = contacts.email) as blocked,
                status, (${a.onTopic.sql}) as on_topic, ${exSeg} as ex_seg, ${a.recent ? a.recent.sql : "0"} as recent
         from contacts where (${a.segment.sql})
       ),
       d as (
         select *, not blocked and status = 'subscribed' and on_topic as reachable from c
       )
       select count(*) as total,
         coalesce(sum(blocked), 0) as blocked,
         coalesce(sum(not blocked and status = 'unsubscribed'), 0) as unsubscribed,
         coalesce(sum(not blocked and status = 'unconfirmed'), 0) as unconfirmed,
         coalesce(sum(not blocked and status = 'subscribed' and not on_topic), 0) as not_on_topic,
         ${a.excludedSegments.map((_, i) => `coalesce(sum(reachable and ex_seg = ${i}), 0) as ex_${i},`).join("\n         ")}
         coalesce(sum(reachable and ex_seg is null and recent), 0) as recently_sent,
         coalesce(sum(reachable and ex_seg is null and not recent), 0) as sendable
       from d`,
    )
      .bind(
        ...a.onTopic.params,
        ...a.excludedSegments.flatMap((s) => s.params),
        ...(a.recent ? a.recent.params : []),
        ...a.segment.params,
      )
      .first<Record<string, number>>(),
  )
  const names = yield* segmentNames(a.excludedSegments.map((s) => s.id))
  return {
    matching: row?.total ?? 0,
    sendable: row?.sendable ?? 0,
    excluded: {
      blocked: row?.blocked ?? 0,
      unsubscribed: row?.unsubscribed ?? 0,
      unconfirmed: row?.unconfirmed ?? 0,
      notOnTopic: row?.not_on_topic ?? 0,
      /** Reachable contacts each excluded segment left out; one counted under the first it matches. */
      bySegment: a.excludedSegments.map((s, i) => ({
        segmentId: s.id,
        name: names.get(s.id) ?? s.id,
        count: row?.[`ex_${i}`] ?? 0,
      })),
      recentlySent: row?.recently_sent ?? 0,
    },
  }
})

const segmentNames = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (ids.length === 0) return new Map<string, string>()
    const database = yield* Database
    const rows = yield* database.query("audience.excludedNames", (db) =>
      db
        .select({ id: segments.id, name: segments.name })
        .from(segments)
        // d1: bounded: a campaign excludes at most EXCLUDE_LIMITS.segments segments.
        .where(inArray(segments.id, [...ids]))
        .all(),
    )
    return new Map(rows.map((r) => [r.id, r.name]))
  })

import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import type { campaigns } from "../db/schema.ts"
import { segmentCondition } from "../domain/segments.ts"

type CampaignRow = typeof campaigns.$inferSelect

/**
 * Who a campaign goes to: the contacts its segment matches (everyone without one), who are
 * subscribed overall, subscribed to its topic when it has one, and not on the suppression list.
 * As raw SQL over `contacts` with its parameters, so a send can page through it.
 */
export const audienceSql = Effect.fn("audience.sql")(function* (
  campaign: Pick<CampaignRow, "segmentId" | "topicId">,
) {
  const segment = campaign.segmentId
    ? yield* segmentCondition(campaign.segmentId)
    : { sql: "1", params: [] as ReadonlyArray<unknown> }
  const onTopic = campaign.topicId
    ? `exists (select 1 from subscriptions s where s.contact_id = contacts.id and s.topic_id = ? and s.state = 'subscribed')`
    : "1"
  return {
    segment,
    onTopic: { sql: onTopic, params: campaign.topicId ? [campaign.topicId] : [] },
    /** The full condition for a sendable recipient. */
    where: `(${segment.sql}) and contacts.status = 'subscribed' and (${onTopic}) and not exists (select 1 from suppressions x where x.email = contacts.email)`,
    params: [...segment.params, ...(campaign.topicId ? [campaign.topicId] : [])],
  }
})

/** The segment's size, what can be sent, and why the rest can't: the editor's audience line. */
export const audiencePreview = Effect.fn("audience.preview")(function* (
  campaign: Pick<CampaignRow, "segmentId" | "topicId">,
) {
  const { DB } = yield* Bindings
  const a = yield* audienceSql(campaign)
  const row = yield* Effect.promise(() =>
    DB.prepare(
      // Each contact lands in exactly one bucket, so the buckets add up to the segment's size.
      `with c as (
         select status in ('bounced', 'complained', 'suppressed') or exists (select 1 from suppressions x where x.email = contacts.email) as blocked,
                status, (${a.onTopic.sql}) as on_topic
         from contacts where (${a.segment.sql})
       )
       select count(*) as total,
         coalesce(sum(blocked), 0) as blocked,
         coalesce(sum(not blocked and status = 'unsubscribed'), 0) as unsubscribed,
         coalesce(sum(not blocked and status = 'unconfirmed'), 0) as unconfirmed,
         coalesce(sum(not blocked and status = 'subscribed' and not on_topic), 0) as not_on_topic,
         coalesce(sum(not blocked and status = 'subscribed' and on_topic), 0) as sendable
       from c`,
    )
      .bind(...a.onTopic.params, ...a.segment.params)
      .first<{
        total: number
        blocked: number
        unsubscribed: number
        unconfirmed: number
        not_on_topic: number
        sendable: number
      }>(),
  )
  return {
    matching: row?.total ?? 0,
    sendable: row?.sendable ?? 0,
    excluded: {
      blocked: row?.blocked ?? 0,
      unsubscribed: row?.unsubscribed ?? 0,
      unconfirmed: row?.unconfirmed ?? 0,
      notOnTopic: row?.not_on_topic ?? 0,
    },
  }
})

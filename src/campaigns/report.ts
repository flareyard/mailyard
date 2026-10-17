import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import { createSegment } from "../domain/segments.ts"
import { CampaignInvalid, createCampaign, findCampaign } from "./campaigns.ts"

/**
 * A campaign's numbers, all counted from rows (`messages_out`, `events`, `inbound_messages`,
 * `campaign_links`), never estimated. "Opened" and "clicked" are people; what looked like machines
 * is reported beside them, so Apple's privacy proxy can't inflate the rate unnoticed.
 */

type Row = Record<string, number | string | null>

const one = (sql: string, ...params: Array<unknown>) =>
  Effect.gen(function* () {
    const { DB } = yield* Bindings
    return (
      (yield* Effect.promise(() =>
        DB.prepare(sql)
          .bind(...params)
          .first<Row>(),
      )) ?? {}
    )
  })
const all = (sql: string, ...params: Array<unknown>) =>
  Effect.gen(function* () {
    const { DB } = yield* Bindings
    return (yield* Effect.promise(() =>
      DB.prepare(sql)
        .bind(...params)
        .all<Row>(),
    )).results
  })

const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0))
const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0)
/** A Message-ID as compared: no angle brackets, lower case. */
const bare = (column: string) => `lower(replace(replace(${column}, '<', ''), '>', ''))`

export const campaignReport = Effect.fn("campaigns.report")(function* (id: string) {
  const campaign = yield* findCampaign(id)
  const funnel = yield* one(
    `select count(*) as sent,
       coalesce(sum(status in ('delivered', 'complained')), 0) as delivered,
       coalesce(sum(first_opened_at is not null), 0) as opened,
       coalesce(sum(first_opened_at is null and machine_opens > 0), 0) as machine_only,
       coalesce(sum(machine_opens > 0), 0) as machine_opened,
       coalesce(sum(first_clicked_at is not null), 0) as clicked,
       coalesce(sum(status = 'bounced' and bounce_type = 'hard'), 0) as bounced_hard,
       coalesce(sum(status = 'bounced' and coalesce(bounce_type, '') <> 'hard'), 0) as bounced_soft,
       coalesce(sum(status = 'complained'), 0) as complained,
       coalesce(sum(status in ('failed', 'rejected')), 0) as failed,
       coalesce(sum(status in ('queued', 'sent', 'deferred')), 0) as pending,
       coalesce(sum(tracked), 0) as tracked
     from messages_out where campaign_id = ? and stream = 'campaign'`,
    id,
  )
  const unsubscribed = yield* one(
    `select count(distinct contact_id) as n from events where name = 'email.unsubscribed' and json_extract(data, '$.campaignId') = ?`,
    id,
  )
  const replied = yield* one(
    `select count(distinct i.id) as n from inbound_messages i
     where i.in_reply_to is not null and ${bare("i.in_reply_to")} in (
       select ${bare("cf_message_id")} from messages_out where campaign_id = ? and stream = 'campaign' and cf_message_id is not null)`,
    id,
  )
  const providers = yield* all(
    `select coalesce(provider, 'unknown') as provider, count(*) as sent,
       coalesce(sum(status in ('delivered', 'complained')), 0) as delivered,
       coalesce(sum(status = 'bounced'), 0) as bounced,
       coalesce(sum(status = 'complained'), 0) as complained,
       coalesce(sum(first_opened_at is not null), 0) as opened
     from messages_out where campaign_id = ? and stream = 'campaign'
     group by coalesce(provider, 'unknown') order by sent desc, provider`,
    id,
  )
  const links = yield* all(
    "select url, clicks, machine_clicks from campaign_links where campaign_id = ? order by clicks desc, machine_clicks desc limit 100",
    id,
  )
  const start = campaign.startedAt ?? campaign.sendAt ?? campaign.createdAt
  // The first week after sending starts, hour by hour: when people opened and clicked.
  const activity = yield* all(
    `select h, sum(o) as opens, sum(c) as clicks from (
       select cast((first_opened_at - ?) / 3600000 as integer) as h, 1 as o, 0 as c from messages_out
         where campaign_id = ? and first_opened_at is not null and first_opened_at >= ?
       union all
       select cast((first_clicked_at - ?) / 3600000 as integer) as h, 0 as o, 1 as c from messages_out
         where campaign_id = ? and first_clicked_at is not null and first_clicked_at >= ?
     ) where h < 168 group by h order by h`,
    start,
    id,
    start,
    start,
    id,
    start,
  )
  const variants = campaign.ab
    ? yield* all(
        `select variant, count(*) as sent, coalesce(sum(first_opened_at is not null), 0) as opened,
           coalesce(sum(first_clicked_at is not null), 0) as clicked
         from messages_out where campaign_id = ? and stream = 'campaign' and variant is not null group by variant order by variant`,
        id,
      )
    : []
  const sent = n(funnel.sent)
  const delivered = n(funnel.delivered)
  return {
    campaignId: id,
    status: campaign.status,
    audience: campaign.audienceSize ?? 0,
    sent,
    delivered,
    pending: n(funnel.pending),
    tracked: n(funnel.tracked) > 0,
    opened: n(funnel.opened),
    /** Messages whose only opens looked like machines (Apple Mail Privacy Protection, mostly). */
    machineOnlyOpens: n(funnel.machine_only),
    machineOpenShare: rate(n(funnel.machine_opened), sent),
    clicked: n(funnel.clicked),
    replied: n(replied.n),
    unsubscribed: n(unsubscribed.n),
    bounced: { hard: n(funnel.bounced_hard), soft: n(funnel.bounced_soft) },
    complained: n(funnel.complained),
    failed: n(funnel.failed),
    rates: {
      delivery: rate(delivered, sent),
      open: rate(n(funnel.opened), delivered),
      click: rate(n(funnel.clicked), delivered),
      clickToOpen: rate(n(funnel.clicked), n(funnel.opened)),
      bounce: rate(n(funnel.bounced_hard) + n(funnel.bounced_soft), sent),
      complaint: rate(n(funnel.complained), delivered),
      unsubscribe: rate(n(unsubscribed.n), delivered),
    },
    providers: providers.map((p) => ({
      provider: String(p.provider),
      sent: n(p.sent),
      delivered: n(p.delivered),
      bounced: n(p.bounced),
      complained: n(p.complained),
      opened: n(p.opened),
    })),
    links: links.map((l) => ({
      url: String(l.url),
      clicks: n(l.clicks),
      machineClicks: n(l.machine_clicks),
    })),
    activity: activity.map((a) => ({ hour: n(a.h), opens: n(a.opens), clicks: n(a.clicks) })),
    ab: campaign.ab
      ? {
          metric: campaign.ab.metric,
          winner: campaign.abWinner,
          variants: variants.map((v) => ({
            variant: String(v.variant) as "a" | "b",
            subject: v.variant === "b" ? (campaign.subjectB ?? "") : campaign.subject,
            sent: n(v.sent),
            opened: n(v.opened),
            clicked: n(v.clicked),
          })),
        }
      : null,
  }
})

export const RECIPIENT_FILTERS = [
  "delivered",
  "bounced",
  "complained",
  "failed",
  "pending",
  "opened",
  "clicked",
  "unsubscribed",
] as const
export type RecipientFilter = (typeof RECIPIENT_FILTERS)[number]

/** Who got it and how it went for each of them, newest first, filterable by outcome. */
export const campaignRecipients = Effect.fn("campaigns.recipients")(function* (
  id: string,
  query: {
    readonly status?: RecipientFilter | undefined
    readonly cursor?: string | undefined
    readonly limit?: number | undefined
  },
) {
  yield* findCampaign(id)
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const filter: Record<RecipientFilter, string> = {
    delivered: "m.status in ('delivered', 'complained')",
    bounced: "m.status = 'bounced'",
    complained: "m.status = 'complained'",
    failed: "m.status in ('failed', 'rejected')",
    pending: "m.status in ('queued', 'sent', 'deferred')",
    opened: "m.first_opened_at is not null",
    clicked: "m.first_clicked_at is not null",
    unsubscribed:
      "exists (select 1 from events e where e.contact_id = m.contact_id and e.name = 'email.unsubscribed' and json_extract(e.data, '$.campaignId') = m.campaign_id)",
  }
  const rows = yield* all(
    `select m.id, m.contact_id, m.recipient, m.status, m.bounce_type, m.provider, m.variant, m.first_opened_at, m.first_clicked_at,
            m.opens, m.clicks, m.machine_opens, m.created_at, c.name,
            exists (select 1 from events e where e.contact_id = m.contact_id and e.name = 'email.unsubscribed' and json_extract(e.data, '$.campaignId') = m.campaign_id) as unsubscribed
     from messages_out m left join contacts c on c.id = m.contact_id
     where m.campaign_id = ? and m.stream = 'campaign'${query.status ? ` and ${filter[query.status]}` : ""}${query.cursor ? " and m.id < ?" : ""}
     order by m.id desc limit ${limit + 1}`,
    id,
    ...(query.cursor ? [query.cursor] : []),
  )
  const page = rows.slice(0, limit)
  return {
    recipients: page.map((r) => ({
      messageId: String(r.id),
      contactId: r.contact_id === null ? null : String(r.contact_id),
      email: String(r.recipient),
      name: r.name === null ? null : String(r.name),
      status: String(r.status),
      bounceType: r.bounce_type === null ? null : String(r.bounce_type),
      provider: r.provider === null ? null : String(r.provider),
      variant: r.variant === null ? null : String(r.variant),
      openedAt: r.first_opened_at === null ? null : n(r.first_opened_at),
      clickedAt: r.first_clicked_at === null ? null : n(r.first_clicked_at),
      opens: n(r.opens),
      clicks: n(r.clicks),
      machineOpens: n(r.machine_opens),
      unsubscribed: n(r.unsubscribed) === 1,
      sentAt: n(r.created_at),
    })),
    nextCursor: rows.length > limit ? String(page.at(-1)?.id ?? "") : null,
  }
})

/**
 * A new draft for the people who got this campaign and didn't open it: same content and topic,
 * audience a segment of "received it and didn't open". Needs open tracking to mean anything.
 */
export const resendToNonOpeners = Effect.fn("campaigns.resend")(function* (id: string, actor: string) {
  const campaign = yield* findCampaign(id)
  if (campaign.status !== "sent")
    return yield* new CampaignInvalid({
      field: "status",
      message: "Resend once the campaign has finished sending.",
    })
  if (!campaign.trackOpens)
    return yield* new CampaignInvalid({
      field: "trackOpens",
      message: "Without open tracking there's no telling who didn't open.",
    })
  const segment = yield* createSegment(
    {
      name: `Didn't open: ${campaign.name}`.slice(0, 100),
      filter: {
        type: "all",
        rules: [
          { type: "campaign", campaignId: id, activity: "received" },
          { type: "campaign", campaignId: id, activity: "opened", did: false },
        ],
      },
    },
    actor,
  ).pipe(
    // The filter is fixed and valid; failing it would be a bug here, not the caller's input.
    Effect.catchTag("SegmentInvalid", Effect.die),
  )
  return yield* createCampaign(
    {
      name: `${campaign.name} (resend)`.slice(0, 200),
      fromAddress: campaign.fromAddress,
      subject: campaign.subject,
      segmentId: segment.id,
      topicId: campaign.topicId,
      templateId: campaign.templateId,
      bodyHtml: campaign.bodyHtml,
      bodyText: campaign.bodyText,
      replyTo: campaign.replyTo,
      preheader: campaign.preheader,
      trackOpens: campaign.trackOpens,
      trackClicks: campaign.trackClicks,
    },
    actor,
  )
})

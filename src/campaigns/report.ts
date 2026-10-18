import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import { createSegment, prepare } from "../domain/segments.ts"
import { audiencePreview } from "./audience.ts"
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
/** The volume under which a campaign's rates are noise, as /v1/stats/delivery's minimum. */
const MIN_SENDS = 100
const roundedRate = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0
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
  const rate = (part: number, whole: number) => (sent < MIN_SENDS ? null : roundedRate(part, whole))
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
    /** Under 100 sends the rates are null: one bounce in five sends is a 20% rate that means nothing (HAL-3428). */
    insufficientData: sent < MIN_SENDS,
    minimumSends: MIN_SENDS,
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

export interface ResendOptions {
  /**
   * Treat a machine-only open (a privacy proxy fetching the pixel) as opened, so those people
   * aren't mailed again. Left false, only human opens count, which reaches more people but some
   * of them did see it.
   */
  readonly countMachineOpensAsOpened?: boolean | undefined
  /** A new subject for the resend; left out, the original's. */
  readonly subject?: string | undefined
}

/** "Received this campaign and didn't open it", as a segment filter. */
const nonOpenerFilter = (id: string, options: ResendOptions) => ({
  type: "all" as const,
  rules: [
    { type: "campaign" as const, campaignId: id, activity: "received" as const },
    {
      type: "campaign" as const,
      campaignId: id,
      activity: "opened" as const,
      did: false,
      ...(options.countMachineOpensAsOpened ? { includeMachine: true } : {}),
    },
  ],
})

const resendable = Effect.fn("campaigns.resendable")(function* (id: string) {
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
  return campaign
})

/**
 * How many a resend would reach, without creating anything: who received it and didn't open, and
 * of those, who can still be mailed (subscribed, on the topic, not suppressed).
 */
export const resendDryRun = Effect.fn("campaigns.resendDryRun")(function* (
  id: string,
  options: ResendOptions,
) {
  const campaign = yield* resendable(id)
  const { query } = yield* prepare(nonOpenerFilter(id, options)).pipe(
    Effect.catchTag("SegmentInvalid", Effect.die),
  )
  const preview = yield* audiencePreview(
    { id: "", segmentId: null, topicId: campaign.topicId, exclude: null },
    { sql: query.sql, params: query.params },
  )
  return {
    recipients: preview.matching,
    sendable: preview.sendable,
    countMachineOpensAsOpened: options.countMachineOpensAsOpened ?? false,
  }
})

/**
 * A new draft for the people who got this campaign and didn't open it: same content and topic,
 * audience a segment of "received it and didn't open". Needs open tracking to mean anything.
 */
export const resendToNonOpeners = Effect.fn("campaigns.resend")(function* (
  id: string,
  actor: string,
  options: ResendOptions = {},
) {
  const campaign = yield* resendable(id)
  const subject = options.subject?.trim()
  if (options.subject !== undefined && (!subject || subject.length > 998))
    return yield* new CampaignInvalid({ field: "subject", message: "A subject is 1 to 998 characters." })
  const segment = yield* createSegment(
    {
      name: `Didn't open: ${campaign.name}`.slice(0, 100),
      filter: nonOpenerFilter(id, options),
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
      subject: subject ?? campaign.subject,
      segmentId: segment.id,
      topicId: campaign.topicId,
      templateId: campaign.templateId,
      bodyHtml: campaign.bodyHtml,
      bodyBlocks: campaign.bodyBlocks,
      bodyText: campaign.bodyText,
      replyTo: campaign.replyTo,
      preheader: campaign.preheader,
      trackOpens: campaign.trackOpens,
      trackClicks: campaign.trackClicks,
    },
    actor,
  )
})

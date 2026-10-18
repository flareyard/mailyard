import { and, count, desc, eq, inArray, lt, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import {
  campaignEngagement,
  campaigns,
  contacts,
  domains,
  segments,
  templates,
  topics,
} from "../db/schema.ts"
import { recordAudit } from "../domain/audit.ts"
import { parseParty, sendBulkMessage } from "../domain/outbox.ts"
import { Ids } from "../kit/index.ts"
import { Database, queryIn } from "../services/Database.ts"
import type { BlocksDocument } from "../templates/document.ts"
import { validateTemplate } from "../templates/render.ts"
import { audiencePreview, audienceSql, audienceTooComplex, EXCLUDE_LIMITS } from "./audience.ts"
import { checkCampaign, linksIn } from "./checks.ts"
import { getCompliance } from "./compliance.ts"
import { renderFor } from "./content.ts"
import { linkStatuses } from "./links.ts"

export class CampaignNotFound extends Schema.TaggedError<CampaignNotFound>()("CampaignNotFound", {
  id: Schema.String,
}) {}
export class CampaignInvalid extends Schema.TaggedError<CampaignInvalid>()("CampaignInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
/** The campaign is past the state where this can happen (editing one that's sending, say). */
export class CampaignLocked extends Schema.TaggedError<CampaignLocked>()("CampaignLocked", {
  message: Schema.String,
}) {}

export type CampaignRow = typeof campaigns.$inferSelect
export type CampaignStatus = CampaignRow["status"]
export type AbTest = NonNullable<CampaignRow["ab"]>

export const describeCampaign = (c: CampaignRow) => ({
  id: c.id,
  name: c.name,
  status: c.status,
  segmentId: c.segmentId,
  topicId: c.topicId,
  templateId: c.templateId,
  templateVersion: c.templateVersion,
  bodyHtml: c.bodyHtml,
  bodyText: c.bodyText,
  bodyBlocks: c.bodyBlocks ?? null,
  fromAddress: c.fromAddress,
  replyTo: c.replyTo,
  subject: c.subject,
  subjectB: c.subjectB,
  preheader: c.preheader,
  ab: c.ab ?? null,
  trackOpens: c.trackOpens,
  trackClicks: c.trackClicks,
  sendAt: c.sendAt,
  audienceSize: c.audienceSize,
  pausedReason: c.pausedReason,
  pausedBy: c.pausedBy,
  timezone: c.timezone,
  lastTest: c.lastTest ?? null,
  exclude: c.exclude ?? null,
  updatedBy: c.updatedBy,
  abWinner: c.abWinner,
  startedAt: c.startedAt,
  finishedAt: c.finishedAt,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
})
export type CampaignView = ReturnType<typeof describeCampaign>

export const findCampaign = Effect.fn("campaigns.find")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("campaigns.get", (db) =>
    db.select().from(campaigns).where(eq(campaigns.id, id)).get(),
  )
  if (!row) return yield* new CampaignNotFound({ id })
  return row
})

export interface CampaignInput {
  readonly name?: string | undefined
  readonly segmentId?: string | null | undefined
  readonly topicId?: string | null | undefined
  readonly templateId?: string | null | undefined
  readonly bodyHtml?: string | null | undefined
  readonly bodyText?: string | null | undefined
  /** Block content: a template-kit document, in place of `bodyHtml`. */
  readonly bodyBlocks?: BlocksDocument | null | undefined
  readonly fromAddress?: string | undefined
  readonly replyTo?: string | null | undefined
  readonly subject?: string | undefined
  readonly subjectB?: string | null | undefined
  readonly preheader?: string | null | undefined
  readonly ab?: AbTest | null | undefined
  readonly trackOpens?: boolean | undefined
  readonly trackClicks?: boolean | undefined
  /** The IANA zone the schedule was picked in (`Africa/Lagos`). */
  readonly timezone?: string | null | undefined
  /** Who to leave out: contacts in these segments, and anyone mailed by a campaign recently. */
  readonly exclude?: Exclude | null | undefined
}

export type Exclude = NonNullable<CampaignRow["exclude"]>

/** An exclusion that leaves nobody out is stored as none, so the editor reads one shape. */
export const normaliseExclude = (e: Exclude | null | undefined) =>
  e === undefined
    ? undefined
    : e === null || (e.segmentIds.length === 0 && e.recentlySentDays === null)
      ? null
      : { segmentIds: [...new Set(e.segmentIds)], recentlySentDays: e.recentlySentDays }

/** A stale edit: someone saved the campaign after the editor loaded it (HAL-3428). */
export class CampaignStale extends Schema.TaggedError<CampaignStale>()("CampaignStale", {
  message: Schema.String,
  updatedAt: Schema.NullOr(Schema.Number),
  updatedBy: Schema.NullOr(Schema.String),
}) {}

const isZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

/** Checks a whole campaign (the stored one with the patch applied), so every rule sees every field. */
const validate = (next: Omit<CampaignRow, "id" | "status" | "createdAt">) =>
  Effect.gen(function* () {
    const database = yield* Database
    const bad = (field: string, message: string) => Effect.fail(new CampaignInvalid({ field, message }))
    if (next.name.trim().length === 0 || next.name.length > 200)
      return yield* bad("name", "A name is 1 to 200 characters.")
    if (next.subject.trim().length === 0 || next.subject.length > 998)
      return yield* bad("subject", "A subject is 1 to 998 characters.")
    const from = parseParty(next.fromAddress)
    if (!EMAIL.test(from.email))
      return yield* bad("fromAddress", 'A sender is "Name <address>" or an address.')
    const fromDomain = from.email.slice(from.email.lastIndexOf("@") + 1).toLowerCase()
    const domain = yield* database.query("campaigns.fromDomain", (db) =>
      db.select().from(domains).where(eq(domains.name, fromDomain)).get(),
    )
    if (!domain?.sendingEnabled)
      return yield* bad("fromAddress", `${fromDomain} isn't a sending domain in Mailyard.`)
    if (next.timezone && !isZone(next.timezone))
      return yield* bad(
        "timezone",
        `${next.timezone} isn't a time zone (use an IANA name, like Africa/Lagos).`,
      )
    if (next.replyTo && !EMAIL.test(parseParty(next.replyTo).email))
      return yield* bad("replyTo", "Not an email address.")
    if (next.templateId && next.bodyHtml) return yield* bad("bodyHtml", "Use a template or a body, not both.")
    if (next.bodyBlocks) {
      if (next.templateId) return yield* bad("bodyBlocks", "Use a template or blocks, not both.")
      if (next.bodyHtml) return yield* bad("bodyBlocks", "Use blocks or an HTML body, not both.")
      const invalid = validateTemplate({
        kind: "blocks",
        subject: next.subject,
        source: JSON.stringify(next.bodyBlocks),
        text: next.bodyText,
      })
      if (invalid) return yield* bad("bodyBlocks", invalid)
    }
    if (next.templateId) {
      const t = yield* database.query("campaigns.template", (db) =>
        db
          .select({ id: templates.id })
          .from(templates)
          .where(eq(templates.id, next.templateId as string))
          .get(),
      )
      if (!t) return yield* bad("templateId", `Template ${next.templateId} not found.`)
    }
    if (next.segmentId) {
      const s = yield* database.query("campaigns.segment", (db) =>
        db
          .select({ id: segments.id })
          .from(segments)
          .where(eq(segments.id, next.segmentId as string))
          .get(),
      )
      if (!s) return yield* bad("segmentId", `Segment ${next.segmentId} not found.`)
    }
    if (next.topicId) {
      const t = yield* database.query("campaigns.topicCheck", (db) =>
        db
          .select({ archived: topics.archived })
          .from(topics)
          .where(eq(topics.id, next.topicId as string))
          .get(),
      )
      if (!t) return yield* bad("topicId", `Topic ${next.topicId} not found.`)
      if (t.archived) return yield* bad("topicId", "That topic is archived.")
    }
    if (next.exclude) {
      const ex = next.exclude
      if (ex.segmentIds.length > EXCLUDE_LIMITS.segments)
        return yield* bad("exclude.segmentIds", `Leave out at most ${EXCLUDE_LIMITS.segments} segments.`)
      if (next.segmentId && ex.segmentIds.includes(next.segmentId))
        return yield* bad("exclude.segmentIds", "A campaign can't leave out the segment it's sent to.")
      if (
        ex.recentlySentDays !== null &&
        (!Number.isInteger(ex.recentlySentDays) ||
          ex.recentlySentDays < 1 ||
          ex.recentlySentDays > EXCLUDE_LIMITS.recentlySentDays)
      )
        return yield* bad(
          "exclude.recentlySentDays",
          `Leave out people mailed in the last 1 to ${EXCLUDE_LIMITS.recentlySentDays} days.`,
        )
      const found = yield* database.query("campaigns.excludeSegments", (db) =>
        db
          .select({ id: segments.id })
          .from(segments)
          // d1: bounded: checked above, at most EXCLUDE_LIMITS.segments ids.
          .where(inArray(segments.id, [...ex.segmentIds]))
          .all(),
      )
      const missing = ex.segmentIds.filter((id) => !found.some((f) => f.id === id))
      if (missing.length) return yield* bad("exclude.segmentIds", `Segment ${missing.join(", ")} not found.`)
    }
    if (next.segmentId || next.exclude) {
      const a = yield* audienceSql({ ...next, id: "" }).pipe(
        Effect.catchTag("SegmentNotFound", (e) => bad("segmentId", `Segment ${e.id} not found.`)),
      )
      const tooComplex = audienceTooComplex(a)
      if (tooComplex) return yield* bad("exclude", tooComplex)
    }
    if (next.ab) {
      if (!next.subjectB) return yield* bad("subjectB", "An A/B test needs a second subject.")
      if (next.ab.percent < 5 || next.ab.percent > 50)
        return yield* bad("ab.percent", "Test with 5% to 50% of the audience.")
      if (next.ab.waitHours < 1 || next.ab.waitHours > 72)
        return yield* bad("ab.waitHours", "Pick the winner after 1 to 72 hours.")
      if (next.ab.metric === "opens" && !next.trackOpens) {
        return yield* bad("ab.metric", "Picking the winner on opens needs open tracking on.")
      }
      if (next.ab.metric === "clicks" && !next.trackClicks) {
        return yield* bad("ab.metric", "Picking the winner on clicks needs click tracking on.")
      }
    }
  })

/**
 * Whether a new campaign tracks opens and clicks when the request doesn't say: on, unless the
 * deploy's settings (`MAILYARD_TRACK_OPENS`, `MAILYARD_TRACK_CLICKS`, "false") switch it off.
 */
export const trackingDefaults = (env: {
  readonly MAILYARD_TRACK_OPENS?: string | undefined
  readonly MAILYARD_TRACK_CLICKS?: string | undefined
}) => ({
  trackOpens: env.MAILYARD_TRACK_OPENS?.trim().toLowerCase() !== "false",
  trackClicks: env.MAILYARD_TRACK_CLICKS?.trim().toLowerCase() !== "false",
})

export const createCampaign = Effect.fn("campaigns.create")(function* (
  input: CampaignInput & { readonly name: string; readonly fromAddress: string; readonly subject: string },
  actor: string,
) {
  const now = Date.now()
  const defaults = trackingDefaults(yield* Bindings)
  const row = {
    name: input.name.trim(),
    segmentId: input.segmentId ?? null,
    topicId: input.topicId ?? null,
    templateId: input.templateId ?? null,
    templateVersion: null,
    bodyHtml: input.bodyHtml ?? null,
    bodyText: input.bodyText ?? null,
    bodyBlocks: input.bodyBlocks ?? null,
    fromAddress: input.fromAddress.trim(),
    replyTo: input.replyTo ?? null,
    subject: input.subject,
    subjectB: input.subjectB ?? null,
    preheader: input.preheader ?? null,
    ab: input.ab ?? null,
    trackOpens: input.trackOpens ?? defaults.trackOpens,
    trackClicks: input.trackClicks ?? defaults.trackClicks,
    sendAt: null,
    workflowId: null,
    audienceSize: null,
    pausedReason: null,
    pausedBy: null,
    timezone: input.timezone ?? null,
    exclude: normaliseExclude(input.exclude) ?? null,
    lastTest: null,
    updatedBy: actor,
    abWinner: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  }
  yield* validate(row)
  const database = yield* Database
  const id = `cmp_${yield* (yield* Ids).next}`
  const created = yield* database.query("campaigns.insert", (db) =>
    db
      .insert(campaigns)
      .values({ id, status: "draft", ...row })
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "campaign.create", target: id, after: { name: row.name } })
  return describeCampaign(created)
})

/** Edits a draft. Once scheduled, a campaign's content is what it is: cancel, copy and edit the copy. */
export const updateCampaign = Effect.fn("campaigns.update")(function* (
  id: string,
  input: CampaignInput & {
    /** The `updatedAt` the editor loaded: refused if someone has saved since. */
    readonly ifMatch?: number | undefined
  },
  actor: string,
) {
  const before = yield* findCampaign(id)
  if (before.status !== "draft")
    return yield* new CampaignLocked({ message: `A ${before.status} campaign can't be edited.` })
  const { ifMatch, ...rest } = input
  const patch = { ...rest, exclude: normaliseExclude(rest.exclude) }
  if (ifMatch !== undefined && before.updatedAt !== ifMatch)
    return yield* new CampaignStale({
      message: "Someone saved this campaign after you opened it. Reload to see their changes.",
      updatedAt: before.updatedAt,
      updatedBy: before.updatedBy,
    })
  const next = {
    ...before,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    updatedAt: Date.now(),
    updatedBy: actor,
  } as CampaignRow
  const { id: _id, status: _status, createdAt: _createdAt, ...fields } = next
  yield* validate(fields)
  const database = yield* Database
  const row = yield* database.query("campaigns.patch", (db) =>
    db.update(campaigns).set(fields).where(eq(campaigns.id, id)).returning().get(),
  )
  yield* recordAudit({
    actor,
    action: "campaign.update",
    target: id,
    before: describeCampaign(before),
    after: row ? describeCampaign(row) : null,
  })
  return describeCampaign(row ?? next)
})

export const deleteCampaign = Effect.fn("campaigns.delete")(function* (id: string, actor: string) {
  const row = yield* findCampaign(id)
  if (row.status !== "draft")
    return yield* new CampaignLocked({
      message: `A ${row.status} campaign stays for its report; cancel it instead.`,
    })
  const database = yield* Database
  yield* database.query("campaigns.delete", (db) => db.delete(campaigns).where(eq(campaigns.id, id)).run())
  yield* recordAudit({ actor, action: "campaign.delete", target: id, before: describeCampaign(row) })
  return { id, deleted: true }
})

export const listCampaigns = Effect.fn("campaigns.list")(function* (query: {
  readonly status?: CampaignStatus | "active" | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) {
  const database = yield* Database
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const [at, cursorId] = query.cursor ? query.cursor.split(":") : []
  const statusFilter =
    query.status === "active"
      ? or(eq(campaigns.status, "scheduled"), eq(campaigns.status, "sending"), eq(campaigns.status, "paused"))
      : query.status
        ? eq(campaigns.status, query.status)
        : undefined
  const rows = yield* database.query("campaigns.list", (db) =>
    db
      .select()
      .from(campaigns)
      .where(
        and(
          statusFilter,
          at && cursorId
            ? or(
                lt(campaigns.createdAt, Number(at)),
                and(eq(campaigns.createdAt, Number(at)), lt(campaigns.id, cursorId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
      .limit(limit + 1)
      .all(),
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  // Campaigns that have sent carry their numbers, one rollup row each (HAL-3428).
  const started = page.filter((c) => c.startedAt !== null).map((c) => c.id)
  const counts = yield* queryIn("campaigns.listSummaries", started, (db, chunk) =>
    db.select().from(campaignEngagement).where(inArray(campaignEngagement.campaignId, chunk)).all(),
  )
  return {
    campaigns: page.map((c) => {
      const e = counts.find((x) => x.campaignId === c.id)
      return {
        ...describeCampaign(c),
        summary:
          c.startedAt === null
            ? null
            : {
                sent: e?.sent ?? 0,
                delivered: e?.delivered ?? 0,
                opened: e?.uniqueOpens ?? 0,
                clicked: e?.uniqueClicks ?? 0,
                bounced: e?.bounced ?? 0,
                unsubscribed: e?.unsubscribed ?? 0,
              },
      }
    }),
    nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null,
  }
})

/** The message one contact would get (or a stand-in, without a contact), for the editor's preview. */
export const renderCampaign = Effect.fn("campaigns.render")(function* (
  id: string,
  options: {
    readonly contactId?: string | undefined
    readonly variant?: "a" | "b" | undefined
    /** Follow links not checked in the last hour now, rather than only report what's known. */
    readonly checkLinks?: boolean | undefined
  },
  origin: string,
) {
  const campaign = yield* findCampaign(id)
  const database = yield* Database
  const contact = options.contactId
    ? yield* database.query("campaigns.renderContact", (db) =>
        db
          .select()
          .from(contacts)
          .where(eq(contacts.id, options.contactId as string))
          .get(),
      )
    : undefined
  if (options.contactId && !contact)
    return yield* new CampaignInvalid({
      field: "contactId",
      message: `Contact ${options.contactId} not found.`,
    })
  const { message, size, footerAdded } = yield* renderFor(
    campaign,
    contact
      ? { contactId: contact.id, email: contact.email, name: contact.name, fields: contact.fields }
      : { contactId: null, email: "preview@example.com", name: "Preview", fields: {} },
    { origin, variant: options.variant ?? "a" },
  )
  // The same results the links check keeps: a link it followed shows here without a second fetch.
  const links = yield* linkStatuses(
    linksIn(message.html ?? "", origin),
    options.checkLinks ? { followOlderThan: 60 * 60_000 } : {},
  )
  return {
    subject: message.subject,
    html: message.html ?? "",
    text: message.text ?? "",
    headers: message.headers ?? {},
    size,
    footerAdded,
    links,
  }
})

/**
 * Sends the campaign as it stands to up to five addresses, by default the compliance seed list.
 * Marked [Test], recorded as the `test` stream: outside the quota's bulk share and the campaign's numbers.
 */
export const testCampaign = Effect.fn("campaigns.test")(function* (
  id: string,
  to: ReadonlyArray<string> | undefined,
  origin: string,
) {
  const campaign = yield* findCampaign(id)
  const seeds = to?.length ? to : (yield* getCompliance()).seedAddresses
  if (seeds.length === 0)
    return yield* new CampaignInvalid({
      field: "to",
      message: "Name who gets the test, or set seed addresses in compliance settings.",
    })
  if (seeds.length > 5)
    return yield* new CampaignInvalid({ field: "to", message: "Test with at most 5 addresses." })
  for (const s of seeds)
    if (!EMAIL.test(s))
      return yield* new CampaignInvalid({ field: "to", message: `${s} isn't an email address.` })
  const database = yield* Database
  const sent: Array<{ email: string; messageId: string; status: string }> = []
  const stamp = Date.now()
  for (const email of seeds) {
    const contact = yield* database.query("campaigns.testContact", (db) =>
      db.select().from(contacts).where(eq(contacts.email, email.toLowerCase())).get(),
    )
    const { message } = yield* renderFor(
      campaign,
      contact
        ? { contactId: contact.id, email: contact.email, name: contact.name, fields: contact.fields }
        : { contactId: null, email: email.toLowerCase(), name: null, fields: {} },
      { origin, test: true },
    )
    const result = yield* sendBulkMessage({
      stream: "test",
      message,
      contactId: contact?.id ?? null,
      campaignId: campaign.id,
      idempotencyKey: `test:${campaign.id}:${email.toLowerCase()}:${stamp}`,
    })
    sent.push({ email, messageId: result.id, status: result.status })
  }
  // Kept on the campaign, so the editor can say when it was last tested and how (HAL-3428).
  yield* database.query("campaigns.lastTest", (db) =>
    db
      .update(campaigns)
      .set({ lastTest: { at: stamp, results: sent } })
      .where(eq(campaigns.id, campaign.id))
      .run(),
  )
  return { sent }
})

export const campaignChecks = Effect.fn("campaigns.checksFor")(function* (id: string, origin: string) {
  return yield* checkCampaign(yield* findCampaign(id), origin)
})

export const campaignAudience = Effect.fn("campaigns.audience")(function* (id: string) {
  return yield* audiencePreview(yield* findCampaign(id))
})

/** `GET /v1/campaigns/counts`: how many there are in each state, for the list's tabs. */
export const campaignCounts = Effect.fn("campaigns.counts")(function* () {
  const database = yield* Database
  const rows = yield* database.query("campaigns.counts", (db) =>
    db.select({ status: campaigns.status, n: count() }).from(campaigns).groupBy(campaigns.status).all(),
  )
  const of = (s: CampaignStatus) => rows.find((r) => r.status === s)?.n ?? 0
  return {
    draft: of("draft"),
    scheduled: of("scheduled"),
    sending: of("sending"),
    paused: of("paused"),
    sent: of("sent"),
    cancelled: of("cancelled"),
    active: of("scheduled") + of("sending") + of("paused"),
    total: rows.reduce((a, r) => a + r.n, 0),
  }
})

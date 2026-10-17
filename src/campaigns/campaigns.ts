import { and, desc, eq, lt, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { campaigns, contacts, domains, segments, templates, topics } from "../db/schema.ts"
import { recordAudit } from "../domain/audit.ts"
import { parseParty, sendBulkMessage } from "../domain/outbox.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { audiencePreview } from "./audience.ts"
import { checkCampaign } from "./checks.ts"
import { getCompliance } from "./compliance.ts"
import { renderFor } from "./content.ts"

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
  fromAddress: c.fromAddress,
  replyTo: c.replyTo,
  subject: c.subject,
  subjectB: c.subjectB,
  preheader: c.preheader,
  ab: c.ab ?? null,
  sendAt: c.sendAt,
  audienceSize: c.audienceSize,
  pausedReason: c.pausedReason,
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
  readonly fromAddress?: string | undefined
  readonly replyTo?: string | null | undefined
  readonly subject?: string | undefined
  readonly subjectB?: string | null | undefined
  readonly preheader?: string | null | undefined
  readonly ab?: AbTest | null | undefined
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
    if (next.replyTo && !EMAIL.test(parseParty(next.replyTo).email))
      return yield* bad("replyTo", "Not an email address.")
    if (next.templateId && next.bodyHtml) return yield* bad("bodyHtml", "Use a template or a body, not both.")
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
    if (next.ab) {
      if (!next.subjectB) return yield* bad("subjectB", "An A/B test needs a second subject.")
      if (next.ab.percent < 5 || next.ab.percent > 50)
        return yield* bad("ab.percent", "Test with 5% to 50% of the audience.")
      if (next.ab.waitHours < 1 || next.ab.waitHours > 72)
        return yield* bad("ab.waitHours", "Pick the winner after 1 to 72 hours.")
      if (next.ab.metric === "opens")
        return yield* bad("ab.metric", "Opens need tracking, which is off; pick the winner on clicks.")
    }
  })

export const createCampaign = Effect.fn("campaigns.create")(function* (
  input: CampaignInput & { readonly name: string; readonly fromAddress: string; readonly subject: string },
  actor: string,
) {
  const now = Date.now()
  const row = {
    name: input.name.trim(),
    segmentId: input.segmentId ?? null,
    topicId: input.topicId ?? null,
    templateId: input.templateId ?? null,
    templateVersion: null,
    bodyHtml: input.bodyHtml ?? null,
    bodyText: input.bodyText ?? null,
    fromAddress: input.fromAddress.trim(),
    replyTo: input.replyTo ?? null,
    subject: input.subject,
    subjectB: input.subjectB ?? null,
    preheader: input.preheader ?? null,
    ab: input.ab ?? null,
    sendAt: null,
    workflowId: null,
    audienceSize: null,
    pausedReason: null,
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
  input: CampaignInput,
  actor: string,
) {
  const before = yield* findCampaign(id)
  if (before.status !== "draft")
    return yield* new CampaignLocked({ message: `A ${before.status} campaign can't be edited.` })
  const next = {
    ...before,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    updatedAt: Date.now(),
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
  return {
    campaigns: page.map(describeCampaign),
    nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null,
  }
})

/** The message one contact would get (or a stand-in, without a contact), for the editor's preview. */
export const renderCampaign = Effect.fn("campaigns.render")(function* (
  id: string,
  options: { readonly contactId?: string | undefined; readonly variant?: "a" | "b" | undefined },
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
  return {
    subject: message.subject,
    html: message.html ?? "",
    text: message.text ?? "",
    headers: message.headers ?? {},
    size,
    footerAdded,
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
  return { sent }
})

export const campaignChecks = Effect.fn("campaigns.checksFor")(function* (id: string, origin: string) {
  return yield* checkCampaign(yield* findCampaign(id), origin)
})

export const campaignAudience = Effect.fn("campaigns.audience")(function* (id: string) {
  return yield* audiencePreview(yield* findCampaign(id))
})

import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import { campaigns, messagesOut } from "../db/schema.ts"
import { clearAlert } from "../domain/alerts.ts"
import { recordAudit } from "../domain/audit.ts"
import { parseParty, sendBulkMessage } from "../domain/outbox.ts"
import { resolveForSend } from "../domain/templates.ts"
import { emitSafely } from "../domain/webhooks.ts"
import { BlobStore } from "../kit/index.ts"
import { chunksOf, Database } from "../services/Database.ts"
import { Governor } from "../services/Governor.ts"
import { audiencePreview, audienceSql, audienceTooComplex, idSliceFor } from "./audience.ts"
import { CampaignInvalid, CampaignLocked, describeCampaign, findCampaign } from "./campaigns.ts"
import { checkCampaign } from "./checks.ts"
import { trackingOrigin } from "./compliance.ts"
import { prepareRender, renderWith } from "./content.ts"

/**
 * Sending a campaign, step by step, for the CampaignSend Workflow (src/workflows/campaign.ts).
 * The audience is snapshotted into R2 in chunks when sending starts. Each chunk is one Workflow
 * step: recipients still eligible are asked of the governor, the granted ones are rendered and
 * sent, and the step reports when to come back for the rest. Every message carries the key
 * `campaign:<id>:<contact>`, so a retried step never sends twice.
 */

/** Recipients per chunk: small enough that rendering and sending one fits a step's CPU budget. */
export const CHUNK = 200
/** Ids per lookup: D1 binds at most 100 parameters, and the audience condition needs some. */
const ID_SLICE = 80
/** Contacts read per snapshot step. */
const SNAPSHOT_PAGE = 5000

export interface ChunkEntry {
  readonly contactId: string
  readonly domain: string
  readonly variant: "a" | "b" | null
}

export type Group = "test" | "main"
const chunkKey = (campaignId: string, group: Group, n: number) =>
  `campaigns/${campaignId}/audience/${group}/${n}.json`
export const instanceIdOf = (campaignId: string) => `campaign-${campaignId}`

// ---------------------------------------------------------------------------------------------
// Scheduling and control (the API)
// ---------------------------------------------------------------------------------------------

/**
 * Schedules a draft: it must pass its checks and reach someone. The template version is frozen
 * now, so editing the template later doesn't change a campaign already on its way.
 */
export const scheduleCampaign = Effect.fn("campaigns.schedule")(function* (
  id: string,
  input: { readonly sendAt?: number | undefined },
  actor: string,
  origin: string,
) {
  const campaign = yield* findCampaign(id)
  if (campaign.status !== "draft")
    return yield* new CampaignLocked({ message: `A ${campaign.status} campaign can't be scheduled.` })
  const now = Date.now()
  const sendAt = input.sendAt ?? now
  if (sendAt < now - 60_000)
    return yield* new CampaignInvalid({ field: "sendAt", message: "That time has passed." })
  const { checks } = yield* checkCampaign(campaign, origin)
  const failing = checks.filter((c) => c.status === "fail")
  if (failing.length) {
    return yield* new CampaignInvalid({
      field: "checks",
      message: `Fix first: ${failing.map((c) => `${c.title} (${c.detail})`).join("; ")}`,
    })
  }
  const tooComplex = audienceTooComplex(yield* audienceSql(campaign))
  if (tooComplex) return yield* new CampaignInvalid({ field: "exclude", message: tooComplex })
  const audience = yield* audiencePreview(campaign)
  if (audience.sendable === 0)
    return yield* new CampaignInvalid({
      field: "audience",
      message: "Nobody in this audience can be sent to.",
    })
  const version = campaign.templateId
    ? (yield* resolveForSend(campaign.templateId, "published")).version.version
    : null
  const database = yield* Database
  const { CAMPAIGN_WORKFLOW } = yield* Bindings
  const instanceId = instanceIdOf(id)
  yield* database.query("campaigns.schedule", (db) =>
    db
      .update(campaigns)
      .set({
        status: "scheduled",
        sendAt,
        templateVersion: version,
        audienceSize: audience.sendable,
        workflowId: instanceId,
        updatedAt: now,
      })
      .where(eq(campaigns.id, id))
      .run(),
  )
  yield* Effect.tryPromise({
    try: async () => {
      const instance = await CAMPAIGN_WORKFLOW.create({ id: instanceId, params: { campaignId: id, origin } })
      dispose(instance)
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchCause((cause) =>
      // The instance couldn't start: put the campaign back so it can be scheduled again.
      database
        .query("campaigns.unschedule", (db) =>
          db.update(campaigns).set({ status: "draft", workflowId: null }).where(eq(campaigns.id, id)).run(),
        )
        .pipe(Effect.andThen(Effect.die(cause))),
    ),
  )
  yield* recordAudit({
    actor,
    action: "campaign.schedule",
    target: id,
    after: { sendAt, audience: audience.sendable, templateVersion: version },
  })
  return describeCampaign(yield* findCampaign(id))
})

const dispose = (stub: unknown) => {
  const disposer = (stub as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]
  if (typeof disposer === "function") disposer.call(stub)
}

/** Stops a scheduled or sending campaign where it is; what's sent stays sent. */
export const pauseCampaign = Effect.fn("campaigns.pause")(function* (id: string, actor: string) {
  const campaign = yield* findCampaign(id)
  if (campaign.status !== "scheduled" && campaign.status !== "sending") {
    return yield* new CampaignLocked({ message: `A ${campaign.status} campaign can't be paused.` })
  }
  const reason = "Paused by hand."
  yield* (yield* Governor).pause(id, reason)
  yield* Database.use((d) =>
    d.query("campaigns.pause", (db) =>
      db
        .update(campaigns)
        .set({ status: "paused", pausedReason: reason, pausedBy: "admin", updatedAt: Date.now() })
        .where(eq(campaigns.id, id))
        .run(),
    ),
  )
  yield* recordAudit({ actor, action: "campaign.pause", target: id })
  return describeCampaign(yield* findCampaign(id))
})

/** Picks up where it stopped, whether a person or the governor paused it. */
export const resumeCampaign = Effect.fn("campaigns.resume")(function* (id: string, actor: string) {
  const campaign = yield* findCampaign(id)
  if (campaign.status !== "paused")
    return yield* new CampaignLocked({ message: `A ${campaign.status} campaign isn't paused.` })
  yield* (yield* Governor).resume(id)
  const status = campaign.startedAt === null ? "scheduled" : "sending"
  yield* Database.use((d) =>
    d.query("campaigns.resume", (db) =>
      db
        .update(campaigns)
        .set({ status, pausedReason: null, pausedBy: null, updatedAt: Date.now() })
        .where(eq(campaigns.id, id))
        .run(),
    ),
  )
  const { CAMPAIGN_WORKFLOW } = yield* Bindings
  yield* Effect.tryPromise(async () => {
    const instance = await CAMPAIGN_WORKFLOW.get(instanceIdOf(id))
    try {
      await instance.sendEvent({ type: "resume", payload: { by: actor } })
    } finally {
      dispose(instance)
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`campaigns: no running instance to resume for ${id}`, cause),
    ),
  )
  yield* clearAlert(`campaign.paused:${id}`, actor)
  yield* recordAudit({ actor, action: "campaign.resume", target: id })
  return describeCampaign(yield* findCampaign(id))
})

/** Ends a campaign for good. Its report stays; nothing more goes out. */
export const cancelCampaign = Effect.fn("campaigns.cancel")(function* (id: string, actor: string) {
  const campaign = yield* findCampaign(id)
  if (!["scheduled", "sending", "paused"].includes(campaign.status)) {
    return yield* new CampaignLocked({ message: `A ${campaign.status} campaign can't be cancelled.` })
  }
  yield* Database.use((d) =>
    d.query("campaigns.cancel", (db) =>
      db
        .update(campaigns)
        .set({ status: "cancelled", finishedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(campaigns.id, id))
        .run(),
    ),
  )
  yield* (yield* Governor).pause(id, "Cancelled.")
  const { CAMPAIGN_WORKFLOW } = yield* Bindings
  yield* Effect.tryPromise(async () => {
    const instance = await CAMPAIGN_WORKFLOW.get(instanceIdOf(id))
    try {
      await instance.terminate()
    } finally {
      dispose(instance)
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`campaigns: no running instance to stop for ${id}`, cause),
    ),
  )
  yield* clearAlert(`campaign.paused:${id}`, actor)
  yield* recordAudit({ actor, action: "campaign.cancel", target: id })
  return describeCampaign(yield* findCampaign(id))
})

// ---------------------------------------------------------------------------------------------
// The Workflow's steps
// ---------------------------------------------------------------------------------------------

const status = (id: string) =>
  Database.use((d) =>
    d.query("campaigns.status", (db) =>
      db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, id)).get(),
    ),
  ).pipe(Effect.map((r) => r?.status ?? null))

/** When to start, or that the campaign was cancelled before it began. */
export const planSend = Effect.fn("campaignSend.plan")(function* (id: string) {
  const campaign = yield* findCampaign(id)
  return { sendAt: campaign.sendAt ?? Date.now(), status: campaign.status, ab: campaign.ab ?? null }
})

/**
 * One page of the audience, written to R2 in chunks. With an A/B test, every k-th recipient goes
 * to the test group (alternating subjects), so the test sample spreads across the whole audience.
 */
export const snapshotPage = Effect.fn("campaignSend.snapshot")(function* (
  id: string,
  page: {
    readonly after: string | null
    readonly position: number
    readonly test: number
    readonly main: number
  },
) {
  const campaign = yield* findCampaign(id)
  const { DB } = yield* Bindings
  const store = yield* BlobStore
  const a = yield* audienceSql(campaign)
  const rows = yield* Effect.promise(() =>
    DB.prepare(
      `select id, email from contacts where ${a.where}${page.after ? " and contacts.id > ?" : ""} order by contacts.id limit ${SNAPSHOT_PAGE}`,
    )
      .bind(...a.params, ...(page.after ? [page.after] : []))
      .all<{ id: string; email: string }>(),
  )
  const every = campaign.ab ? Math.max(1, Math.round(100 / campaign.ab.percent)) : 0
  const test: Array<ChunkEntry> = []
  const main: Array<ChunkEntry> = []
  let position = page.position
  for (const r of rows.results) {
    const domain = r.email.slice(r.email.lastIndexOf("@") + 1)
    if (every && position % every === 0) {
      test.push({ contactId: r.id, domain, variant: Math.floor(position / every) % 2 === 0 ? "a" : "b" })
    } else {
      main.push({ contactId: r.id, domain, variant: null })
    }
    position++
  }
  let testChunks = page.test
  let mainChunks = page.main
  for (let i = 0; i < test.length; i += CHUNK) {
    yield* store.put(
      chunkKey(id, "test", testChunks++),
      new TextEncoder().encode(JSON.stringify(test.slice(i, i + CHUNK))),
      "application/json",
    )
  }
  for (let i = 0; i < main.length; i += CHUNK) {
    yield* store.put(
      chunkKey(id, "main", mainChunks++),
      new TextEncoder().encode(JSON.stringify(main.slice(i, i + CHUNK))),
      "application/json",
    )
  }
  const last = rows.results.at(-1)
  const done = rows.results.length < SNAPSHOT_PAGE
  if (page.after === null) {
    yield* Database.use((d) =>
      d.query("campaigns.started", (db) =>
        db
          .update(campaigns)
          .set({ status: "sending", startedAt: Date.now(), updatedAt: Date.now() })
          .where(and(eq(campaigns.id, id), eq(campaigns.status, "scheduled")))
          .run(),
      ),
    )
  }
  if (done) {
    yield* Database.use((d) =>
      d.query("campaigns.audienceSize", (db) =>
        db.update(campaigns).set({ audienceSize: position }).where(eq(campaigns.id, id)).run(),
      ),
    )
  }
  return { after: last?.id ?? page.after, position, test: testChunks, main: mainChunks, done }
})

export type ChunkResult =
  | { readonly state: "done"; readonly sent: number; readonly skipped: number }
  | { readonly state: "wait"; readonly retryAt: number; readonly sent: number; readonly skipped: number }
  | { readonly state: "paused" | "cancelled"; readonly sent: number; readonly skipped: number }

/**
 * Sends what it can of one chunk. Already-sent recipients are left out (a retried step), and so are
 * those no longer eligible (unsubscribed, bounced, suppressed, or off the topic since the snapshot).
 * `notBefore` is when the Workflow woke: the governor counts the day from it, never from earlier.
 */
export const sendChunk = Effect.fn("campaignSend.chunk")(function* (
  id: string,
  group: Group,
  n: number,
  options: { readonly origin: string; readonly notBefore: number },
) {
  const now = Math.max(Date.now(), options.notBefore)
  const current = yield* status(id)
  if (current === "cancelled") return { state: "cancelled", sent: 0, skipped: 0 } satisfies ChunkResult
  if (current === "paused") return { state: "paused", sent: 0, skipped: 0 } satisfies ChunkResult
  const store = yield* BlobStore
  const blob = yield* store.get(chunkKey(id, group, n))
  if (blob._tag === "None") return { state: "done", sent: 0, skipped: 0 } satisfies ChunkResult
  const entries = JSON.parse(new TextDecoder().decode(blob.value.body)) as ReadonlyArray<ChunkEntry>
  const database = yield* Database
  const campaign = yield* findCampaign(id)
  const a = yield* audienceSql(campaign)
  const ids = entries.map((e) => e.contactId)
  // D1 binds at most 100 parameters a query: look the chunk up in slices that leave room for the
  // audience's own parameters (a complex segment and its exclusions can carry up to 90).
  const slices = chunksOf(ids, idSliceFor(a, ID_SLICE))
  const sentAlready = new Set<string | null>()
  for (const slice of slices) {
    const rows = yield* database.query("campaignSend.sent", (db) =>
      db
        .select({ contactId: messagesOut.contactId })
        .from(messagesOut)
        .where(and(eq(messagesOut.campaignId, id), inArray(messagesOut.contactId, slice)))
        .all(),
    )
    for (const r of rows) sentAlready.add(r.contactId)
  }
  const { DB } = yield* Bindings
  const eligible = new Map<string, { id: string; email: string; name: string | null; fields: string }>()
  for (const slice of slices) {
    const rows = yield* Effect.promise(() =>
      DB.prepare(
        `select id, email, name, fields from contacts where ${a.where} and contacts.id in (${slice.map(() => "?").join(", ")})`,
      )
        .bind(...a.params, ...slice)
        .all<{ id: string; email: string; name: string | null; fields: string }>(),
    )
    for (const r of rows.results) eligible.set(r.id, r)
  }
  const pending = entries.filter((e) => !sentAlready.has(e.contactId) && eligible.has(e.contactId))
  const skipped = entries.filter((e) => !sentAlready.has(e.contactId) && !eligible.has(e.contactId)).length
  if (pending.length === 0) return { state: "done", sent: 0, skipped } satisfies ChunkResult
  const fromEmail = parseParty(campaign.fromAddress).email
  const fromDomain = fromEmail.slice(fromEmail.lastIndexOf("@") + 1).toLowerCase()
  const grant = yield* (yield* Governor).acquire({
    campaignId: id,
    stream: "campaign",
    sendingDomain: fromDomain,
    recipients: pending.map((e) => ({ key: e.contactId, domain: e.domain })),
    now,
  })
  if (grant.reason === "paused" && grant.granted.length === 0)
    return { state: "paused", sent: 0, skipped } satisfies ChunkResult
  const ctx = yield* prepareRender(campaign)
  const track = {
    opens: campaign.trackOpens,
    clicks: campaign.trackClicks,
    origin: trackingOrigin(ctx.compliance, options.origin),
  }
  const winner = campaign.abWinner ?? "a"
  const byId = new Map(pending.map((e) => [e.contactId, e]))
  let sent = 0
  for (const contactId of grant.granted) {
    const entry = byId.get(contactId)
    const contact = eligible.get(contactId)
    if (!entry || !contact) continue
    const variant = entry.variant ?? (campaign.ab ? winner : "a")
    const { message } = yield* renderWith(
      ctx,
      {
        contactId,
        email: contact.email,
        name: contact.name,
        fields: JSON.parse(contact.fields) as Record<string, unknown>,
      },
      { origin: options.origin, variant },
    )
    yield* sendBulkMessage({
      stream: "campaign",
      message,
      contactId,
      campaignId: id,
      templateId: ctx.templateId,
      templateVersion: ctx.templateVersion,
      variant: campaign.ab ? variant : null,
      track,
      idempotencyKey: `campaign:${id}:${contactId}`,
    })
    sent++
  }
  const retryAt = grant.retryAt ?? now + 60_000
  // A day-long hold (quota or warm-up) shows on the campaign; per-minute provider pacing doesn't.
  const held =
    grant.granted.length < pending.length && (grant.reason === "quota" || grant.reason === "warmup")
      ? { heldUntil: retryAt, heldBy: grant.reason }
      : { heldUntil: null, heldBy: null }
  if (held.heldUntil !== campaign.heldUntil || held.heldBy !== campaign.heldBy)
    yield* database.query("campaigns.held", (db) =>
      db.update(campaigns).set(held).where(eq(campaigns.id, id)).run(),
    )
  if (grant.granted.length === pending.length) return { state: "done", sent, skipped } satisfies ChunkResult
  if (grant.reason === "paused") return { state: "paused", sent, skipped } satisfies ChunkResult
  return { state: "wait", retryAt, sent, skipped } satisfies ChunkResult
})

/**
 * The subject with more human opens or clicks in the test group wins, by the campaign's metric;
 * a tie goes to the first.
 */
export const pickWinner = Effect.fn("campaignSend.pickWinner")(function* (id: string) {
  const campaign = yield* findCampaign(id)
  const database = yield* Database
  const column = campaign.ab?.metric === "opens" ? messagesOut.firstOpenedAt : messagesOut.firstClickedAt
  const rows = yield* database.query("campaignSend.engaged", (db) =>
    db
      .select({ variant: messagesOut.variant, n: count() })
      .from(messagesOut)
      .where(and(eq(messagesOut.campaignId, id), isNotNull(column), isNotNull(messagesOut.variant)))
      .groupBy(messagesOut.variant)
      .all(),
  )
  const tally = { a: 0, b: 0 }
  for (const r of rows) if (r.variant === "a" || r.variant === "b") tally[r.variant] = r.n
  const winner: "a" | "b" = tally.b > tally.a ? "b" : "a"
  yield* recordWinner(id, winner)
  return { winner, metric: campaign.ab?.metric ?? "clicks", tally }
})

export const recordWinner = (id: string, winner: "a" | "b") =>
  Database.use((d) =>
    d.query("campaignSend.winner", (db) =>
      db.update(campaigns).set({ abWinner: winner }).where(eq(campaigns.id, id)).run(),
    ),
  )

export const finishSend = Effect.fn("campaignSend.finish")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("campaignSend.count", (db) =>
    db
      .select({ n: count() })
      .from(messagesOut)
      .where(and(eq(messagesOut.campaignId, id), eq(messagesOut.stream, "campaign")))
      .get(),
  )
  yield* database.query("campaignSend.finish", (db) =>
    db
      .update(campaigns)
      .set({ status: "sent", finishedAt: Date.now(), updatedAt: Date.now(), heldUntil: null, heldBy: null })
      .where(and(eq(campaigns.id, id), sql`${campaigns.status} in ('sending', 'scheduled')`))
      .run(),
  )
  yield* emitSafely("campaign.sent", { campaignId: id, messages: row?.n ?? 0 })
  return { messages: row?.n ?? 0 }
})

/** Campaign messages sent so far, tests not counted. */
export const campaignSentCount = (id: string) =>
  Database.use((d) =>
    d.query("campaigns.sentCount", (db) =>
      db
        .select({ n: count() })
        .from(messagesOut)
        .where(and(eq(messagesOut.campaignId, id), eq(messagesOut.stream, "campaign")))
        .get(),
    ),
  ).pipe(Effect.map((r) => r?.n ?? 0))

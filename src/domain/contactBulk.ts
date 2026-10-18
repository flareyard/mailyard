import { and, asc, count, eq, gt, type SQL } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import { contactBulkJobs, contacts } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { recordAudit } from "./audit.ts"
import { type ContactFilters, filterCondition } from "./contactFilters.ts"
import { BULK_LIMIT, ContactNotFound, type ContactQuery, filterOf } from "./contacts.ts"
import { type BulkAction, bulkContacts } from "./subscriptions.ts"

/** A bulk action's filter: the contacts list's own filters (HAL-3422). */
export type BulkFilter = Omit<ContactQuery, "sort" | "cursor" | "limit"> & ContactFilters

/** Contacts one Workflow step handles. */
export const BULK_PAGE = 500

const conditionOf = (filter: BulkFilter) =>
  Effect.gen(function* () {
    const extra = yield* filterCondition(filter)
    return and(filterOf(filter, Date.now()), extra) as SQL | undefined
  })

const describeJob = (j: typeof contactBulkJobs.$inferSelect) => ({
  id: j.id,
  status: j.status,
  action: j.action,
  filter: j.filter,
  total: j.total,
  processed: j.processed,
  updated: j.updated,
  skipped: j.skipped,
  errors: j.errors,
  error: j.error,
  createdAt: j.createdAt,
  finishedAt: j.finishedAt,
})

/**
 * `POST /v1/contacts/bulk { filter, action }`: up to 1,000 matching contacts are done now; more go to
 * ContactBulkWorkflow, which returns at once with a job to watch (`GET /v1/contacts/bulk/{id}`).
 */
export const bulkByFilter = Effect.fn("contacts.bulkByFilter")(function* (
  filter: BulkFilter,
  action: BulkAction,
  actor: string,
  origin: string | null,
) {
  const database = yield* Database
  const where = yield* conditionOf(filter)
  const [counted] = yield* database.query("bulk.count", (db) =>
    db.select({ n: count() }).from(contacts).where(where).all(),
  )
  const total = counted?.n ?? 0
  if (total <= BULK_LIMIT) {
    const ids = yield* database.query("bulk.ids", (db) =>
      db.select({ id: contacts.id }).from(contacts).where(where).all(),
    )
    const result = yield* bulkContacts(
      ids.map((r) => r.id),
      action,
      actor,
      origin,
    )
    return { mode: "sync" as const, ...result }
  }
  const id = `blk_${yield* (yield* Ids).next}`
  const row = {
    id,
    filter: filter as Record<string, unknown>,
    action: { ...action, origin } as Record<string, unknown>,
    status: "queued" as const,
    total,
    errors: [],
    createdBy: actor,
    createdAt: Date.now(),
  }
  yield* database.query("bulk.insertJob", (db) => db.insert(contactBulkJobs).values(row).run())
  const { CONTACT_BULK_WORKFLOW } = yield* Bindings
  yield* Effect.promise(async () => {
    const instance = await CONTACT_BULK_WORKFLOW.create({ id, params: { jobId: id } })
    ;(instance as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
  })
  yield* recordAudit({
    actor,
    action: `contacts.bulk.${action.action}`,
    target: `job ${id}`,
    after: { filter, total },
  })
  return {
    mode: "async" as const,
    job: describeJob({
      ...row,
      processed: 0,
      updated: 0,
      skipped: 0,
      cursor: null,
      error: null,
      finishedAt: null,
    }),
  }
})

export const getBulkJob = Effect.fn("contacts.bulkJob")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("bulk.job", (db) =>
    db.select().from(contactBulkJobs).where(eq(contactBulkJobs.id, id)).get(),
  )
  if (!row) return yield* new ContactNotFound({ id: `bulk job ${id}` })
  return describeJob(row)
})

/**
 * One Workflow step: the next page of matching contacts after the cursor, by id, through the same
 * per-contact code as a small request. The filter is read again each page, so a contact the action
 * itself takes out of the filter is simply not met again. Idempotent per page: the cursor moves with
 * the counts in one write.
 */
export const processBulkPage = Effect.fn("contacts.bulkPage")(function* (jobId: string) {
  const database = yield* Database
  const job = yield* database.query("bulk.jobForPage", (db) =>
    db.select().from(contactBulkJobs).where(eq(contactBulkJobs.id, jobId)).get(),
  )
  if (!job || job.status === "done" || job.status === "failed") return { done: true }
  const where = yield* conditionOf(job.filter as BulkFilter)
  const page = yield* database.query("bulk.page", (db) =>
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(where, job.cursor ? gt(contacts.id, job.cursor) : undefined))
      .orderBy(asc(contacts.id))
      .limit(BULK_PAGE)
      .all(),
  )
  const { origin, ...action } = job.action as BulkAction & { origin?: string | null }
  const result =
    page.length > 0
      ? yield* bulkContacts(
          page.map((r) => r.id),
          action as BulkAction,
          job.createdBy,
          origin ?? null,
        )
      : { updated: 0, skipped: 0, errors: [] as Array<{ id: string; message: string }> }
  const done = page.length < BULK_PAGE
  yield* database.query("bulk.progress", (db) =>
    db
      .update(contactBulkJobs)
      .set({
        status: done ? "done" : "running",
        processed: job.processed + page.length,
        updated: job.updated + result.updated,
        skipped: job.skipped + result.skipped,
        errors: [...job.errors, ...result.errors].slice(0, 100),
        cursor: page.at(-1)?.id ?? job.cursor,
        ...(done ? { finishedAt: Date.now() } : {}),
      })
      .where(eq(contactBulkJobs.id, jobId))
      .run(),
  )
  return { done }
})

export const failBulkJob = Effect.fn("contacts.bulkFail")(function* (jobId: string, message: string) {
  const database = yield* Database
  yield* database.query("bulk.fail", (db) =>
    db
      .update(contactBulkJobs)
      .set({ status: "failed", error: message, finishedAt: Date.now() })
      .where(eq(contactBulkJobs.id, jobId))
      .run(),
  )
})

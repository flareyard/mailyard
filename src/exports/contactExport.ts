import { and, asc, count, desc, eq, gt, lt, type SQL } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { contacts, exports } from "../db/schema.ts"
import { recordAudit } from "../domain/audit.ts"
import { type ContactFilters, filterCondition } from "../domain/contactFilters.ts"
import { type ContactQuery, describeContact, filterOf, membershipsOf } from "../domain/contacts.ts"
import { BlobStore, Ids } from "../kit/index.ts"
import { fileUrl, signFileToken } from "../mail/files.ts"
import { Database } from "../services/Database.ts"

/**
 * CSV exports of the contacts list (HAL-3316): the same filters as `GET /v1/contacts`, the list's
 * columns plus any custom fields asked for. Up to 10,000 rows the file is written in the request;
 * beyond that ContactExportWorkflow pages by contact id and streams the file to R2 as a multipart
 * upload, so the whole file is never in memory. Either way the answer carries a signed download
 * link (src/mail/files.ts), good for a day.
 *
 * The CSV is RFC 4180 with CRLF line ends and a UTF-8 BOM, so Excel reads it as UTF-8. A cell that
 * starts with = + - @ or a tab gets a leading ' so a spreadsheet shows it rather than running it.
 */

export const INLINE_LIMIT = 10_000
const PAGE = 2_000
/** Pages within a multipart part: small enough that a part stops close to its size. */
const PART_PAGE = 500
/** R2 needs every part but the last to be at least 5 MiB. */
const PART_BYTES = 6 * 1024 * 1024
const LINK_TTL_SECONDS = 24 * 60 * 60
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export class ExportNotFound extends Schema.TaggedError<ExportNotFound>()("ExportNotFound", {
  id: Schema.String,
}) {}
export class ExportInvalid extends Schema.TaggedError<ExportInvalid>()("ExportInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

export type ExportFilter = Omit<ContactQuery, "sort" | "cursor" | "limit"> & ContactFilters

const COLUMNS = [
  "id",
  "email",
  "name",
  "status",
  "engagement",
  "topics",
  "created_at",
  "last_activity_at",
  "last_opened_at",
  "last_clicked_at",
] as const

/** One CSV cell: quoted when it must be, and defused when a spreadsheet would read it as a formula. */
export const csvCell = (value: unknown) => {
  if (value === null || value === undefined) return ""
  let s =
    typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvLine = (cells: ReadonlyArray<unknown>) => `${cells.map(csvCell).join(",")}\r\n`
const iso = (ms: number | null) => (ms === null ? "" : new Date(ms).toISOString())

export const headerLine = (fields: ReadonlyArray<string>) => `﻿${csvLine([...COLUMNS, ...fields])}`

type ContactRow = typeof contacts.$inferSelect

/** The CSV lines for a page of contacts, with their subscribed topics. */
const linesFor = (rows: ReadonlyArray<ContactRow>, fields: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const memberships = new Map<string, ReadonlyArray<{ topicId: string; name: string; state: string }>>()
    for (let i = 0; i < rows.length; i += 90) {
      const part = yield* membershipsOf(rows.slice(i, i + 90).map((r) => r.id))
      for (const [id, list] of part) memberships.set(id, list)
    }
    const now = Date.now()
    return rows
      .map((r) => {
        const c = describeContact(r, (memberships.get(r.id) ?? []) as never, now)
        const topics = c.topics
          .filter((t) => t.state === "subscribed")
          .map((t) => t.name)
          .join("; ")
        return csvLine([
          c.id,
          c.email,
          c.name,
          c.status,
          c.engagement,
          topics,
          iso(c.createdAt),
          iso(c.lastActivityAt),
          iso(c.lastOpenedAt),
          iso(c.lastClickedAt),
          ...fields.map((f) => (r.fields as Record<string, unknown>)[f]),
        ])
      })
      .join("")
  })

/** The export's filter as one condition, the same one `GET /v1/contacts` applies. */
const conditionOf = (filter: ExportFilter) =>
  Effect.gen(function* () {
    const extra = yield* filterCondition(filter)
    return and(filterOf(filter, Date.now()), extra) as SQL | undefined
  })

const page = (condition: SQL | undefined, after: string | null, size = PAGE) =>
  Effect.gen(function* () {
    const database = yield* Database
    return yield* database.query("exports.page", (db) =>
      db
        .select()
        .from(contacts)
        .where(and(condition, after ? gt(contacts.id, after) : undefined))
        .orderBy(asc(contacts.id))
        .limit(size)
        .all(),
    )
  })

type ExportRow = typeof exports.$inferSelect

const describeExport = (row: ExportRow, url: string | null) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  rows: row.rows,
  fields: row.fields,
  filename: row.filename,
  url,
  error: row.error,
  createdAt: row.createdAt,
  finishedAt: row.finishedAt,
})
export type ExportView = ReturnType<typeof describeExport>

const linkFor = (row: ExportRow, origin: string | null) =>
  Effect.gen(function* () {
    if (row.status !== "completed" || !origin) return null
    const token = yield* signFileToken(
      { k: row.key, n: row.filename, t: "text/csv; charset=utf-8", d: "attachment" },
      LINK_TTL_SECONDS,
    )
    return fileUrl(origin, token)
  }).pipe(Effect.orElseSucceed(() => null))

const findExport = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("exports.get", (db) =>
      db.select().from(exports).where(eq(exports.id, id)).get(),
    )
    if (!row) return yield* new ExportNotFound({ id })
    return row
  })

export const getExport = Effect.fn("exports.get")(function* (id: string, origin: string | null) {
  const row = yield* findExport(id)
  return describeExport(row, yield* linkFor(row, origin))
})

export const listExports = Effect.fn("exports.list")(function* (query: {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) {
  const database = yield* Database
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
  const rows = yield* database.query("exports.list", (db) =>
    db
      .select()
      .from(exports)
      .where(query.cursor ? lt(exports.id, query.cursor) : undefined)
      .orderBy(desc(exports.id))
      .limit(limit + 1)
      .all(),
  )
  const slice = rows.slice(0, limit)
  return {
    exports: slice.map((r) => describeExport(r, null)),
    nextCursor: rows.length > limit ? (slice.at(-1)?.id ?? null) : null,
  }
})

/**
 * Starts an export. Up to 10,000 matching contacts it's written now and comes back completed with
 * its link; past that it comes back running, and `startWorkflow` is called with its id.
 */
export const createContactExport = Effect.fn("exports.create")(function* (
  input: { readonly filter: ExportFilter; readonly fields?: ReadonlyArray<string> | undefined },
  actor: string,
  origin: string | null,
  startWorkflow: (exportId: string) => Promise<void>,
) {
  const database = yield* Database
  const fields = [...new Set(input.fields ?? [])]
  if (fields.length > 50)
    return yield* new ExportInvalid({ field: "fields", message: "At most 50 custom fields." })
  const bad = fields.find((f) => !FIELD_NAME.test(f))
  if (bad)
    return yield* new ExportInvalid({ field: "fields", message: `"${bad}" isn't a custom field name.` })
  const condition = yield* conditionOf(input.filter)
  const matching = yield* database.query("exports.count", (db) =>
    db.select({ n: count() }).from(contacts).where(condition).get(),
  )
  const id = `exp_${yield* (yield* Ids).next}`
  const stamp = new Date().toISOString().slice(0, 10)
  const row = yield* database.query("exports.insert", (db) =>
    db
      .insert(exports)
      .values({
        id,
        kind: "contacts",
        filter: { ...input.filter } as Record<string, unknown>,
        fields,
        key: `exports/${id}.csv`,
        filename: `contacts-${stamp}.csv`,
        createdBy: actor,
      })
      .returning()
      .get(),
  )
  yield* recordAudit({
    actor,
    action: "contacts.export",
    target: id,
    after: { matching: matching?.n ?? 0, fields },
  })

  if ((matching?.n ?? 0) > INLINE_LIMIT) {
    yield* Effect.tryPromise({ try: () => startWorkflow(id), catch: (cause) => cause }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("exports: workflow did not start", cause).pipe(
          Effect.andThen(failExport(id, "The export couldn't start; try again.")),
        ),
      ),
    )
    const now = yield* findExport(id)
    return describeExport(now, null)
  }

  let body = headerLine(fields)
  let after: string | null = null
  let rows = 0
  for (;;) {
    const batch: ReadonlyArray<ContactRow> = yield* page(condition, after)
    if (batch.length === 0) break
    body += yield* linesFor(batch, fields)
    rows += batch.length
    after = batch.at(-1)?.id ?? null
    if (batch.length < PAGE) break
  }
  yield* (yield* BlobStore).put(row.key, new TextEncoder().encode(body), "text/csv; charset=utf-8")
  const done = yield* database.query("exports.done", (db) =>
    db
      .update(exports)
      .set({ status: "completed", rows, finishedAt: Date.now() })
      .where(eq(exports.id, id))
      .returning()
      .get(),
  )
  return describeExport(done ?? row, yield* linkFor(done ?? row, origin))
})

const failExport = (id: string, message: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.query("exports.fail", (db) =>
      db
        .update(exports)
        .set({ status: "failed", error: message, finishedAt: Date.now() })
        .where(eq(exports.id, id))
        .run(),
    )
  })

// ---------------------------------------------------------------------------------------------
// The Workflow's steps, for exports past INLINE_LIMIT
// ---------------------------------------------------------------------------------------------

/** Opens the multipart upload (once) and returns where writing resumes. */
export const beginLargeExport = Effect.fn("exports.begin")(function* (id: string) {
  const database = yield* Database
  const { STORE } = yield* Bindings
  const row = yield* findExport(id)
  if (row.status !== "running") return { done: true }
  if (!row.uploadId) {
    const upload = yield* Effect.promise(() =>
      STORE.createMultipartUpload(row.key, { httpMetadata: { contentType: "text/csv; charset=utf-8" } }),
    )
    yield* database.query("exports.multipart", (db) =>
      db.update(exports).set({ uploadId: upload.uploadId }).where(eq(exports.id, id)).run(),
    )
  }
  return { done: false }
})

/**
 * One step: reads pages of contacts after the last one written until it has a part's worth (at least
 * 5 MiB, or the end), uploads it as the next part, and records the part and the new position
 * together. A retry of a step that already recorded its part changes nothing.
 */
export const writeExportPart = Effect.fn("exports.part")(function* (id: string, partNumber: number) {
  const database = yield* Database
  const { STORE } = yield* Bindings
  const row = yield* findExport(id)
  if (row.status !== "running" || !row.uploadId) return { done: true }
  if (row.parts.some((p) => p.partNumber === partNumber)) return { done: false }
  const condition = yield* conditionOf(row.filter as ExportFilter)
  // Tests set the part size to R2's 5 MiB minimum to keep their files small.
  const partBytes = Number((yield* Bindings).MAILYARD_EXPORT_PART_BYTES ?? PART_BYTES) || PART_BYTES
  let text = partNumber === 1 ? headerLine(row.fields) : ""
  let after = row.after
  let rows = 0
  let ended = false
  while (new TextEncoder().encode(text).byteLength < partBytes) {
    const batch: ReadonlyArray<ContactRow> = yield* page(condition, after, PART_PAGE)
    if (batch.length > 0) {
      text += yield* linesFor(batch, row.fields)
      rows += batch.length
      after = batch.at(-1)?.id ?? after
    }
    if (batch.length < PART_PAGE) {
      ended = true
      break
    }
  }
  if (text.length > 0) {
    const upload = STORE.resumeMultipartUpload(row.key, row.uploadId)
    const part = yield* Effect.promise(() => upload.uploadPart(partNumber, new TextEncoder().encode(text)))
    yield* database.query("exports.partDone", (db) =>
      db
        .update(exports)
        .set({ parts: [...row.parts, { partNumber, etag: part.etag }], after, rows: row.rows + rows })
        .where(eq(exports.id, id))
        .run(),
    )
  }
  return { done: ended }
})

/** Completes the multipart upload and marks the export completed. */
export const finishLargeExport = Effect.fn("exports.finish")(function* (id: string) {
  const database = yield* Database
  const { STORE } = yield* Bindings
  const row = yield* findExport(id)
  if (row.status !== "running" || !row.uploadId) return { rows: row.rows }
  const upload = STORE.resumeMultipartUpload(row.key, row.uploadId)
  yield* Effect.promise(() => upload.complete([...row.parts].sort((a, b) => a.partNumber - b.partNumber)))
  yield* database.query("exports.complete", (db) =>
    db.update(exports).set({ status: "completed", finishedAt: Date.now() }).where(eq(exports.id, id)).run(),
  )
  return { rows: row.rows }
})

export const failLargeExport = (id: string, message: string) => failExport(id, message)

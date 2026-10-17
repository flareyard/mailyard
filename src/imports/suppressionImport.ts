import { desc, eq, inArray, lt } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Bindings } from "../Bindings.ts"
import { suppressionImports, suppressions, uploads } from "../db/schema.ts"
import { raiseAlert } from "../domain/alerts.ts"
import { recordAudit } from "../domain/audit.ts"
import { EMAIL, normalizeEmail } from "../domain/contacts.ts"
import type { Reason } from "../domain/suppressions.ts"
import { BlobStore, Ids } from "../kit/index.ts"
import { CloudflareEmail } from "../services/CloudflareEmail.ts"
import { Database } from "../services/Database.ts"
import { ImportInvalid, ImportNotFound, UploadNotFound } from "./contactImport.ts"
import { BOM, byteLength, parseCsv } from "./csv.ts"

/**
 * Suppression-list CSV imports (HAL-3372): another provider's bounces, complaints and unsubscribes,
 * so moving to Mailyard doesn't mail them again. Read like a contact import: an R2 upload, then
 * SuppressionImportWorkflow takes 5,000 rows a step from a byte offset on the import row, and each
 * step's writes and counts go in one D1 batch guarded by that offset.
 *
 * - The email column is the one the caller names, else a header called email, e-mail or address.
 * - An optional reason column takes other providers' words (bounced, spam, unsubscribed, …); rows
 *   without one get the import's reason.
 * - An address already on the list keeps its reason. Contacts are blocked as `add` does: an
 *   unsubscribe sets `unsubscribed` and only stops bulk mail, anything else sets `suppressed`.
 * - With `push`, each new address that blocks every stream also goes to Cloudflare's list, in bulk
 *   calls of up to 1,000, before the step commits. A retried step pushes again, which Cloudflare
 *   de-duplicates.
 */

export const CHUNK_ROWS = 5_000
const READ_BYTES = 4 * 1024 * 1024
const SLICE = 1_000
const MAX_ERRORS = 100

type Row = typeof suppressionImports.$inferSelect

export const describeSuppressionImport = (r: Row) => ({
  id: r.id,
  uploadId: r.uploadId,
  status: r.status,
  reason: r.reason,
  note: r.note,
  emailColumn: r.emailColumn,
  reasonColumn: r.reasonColumn,
  noteColumn: r.noteColumn,
  push: r.push,
  headers: r.headers ?? null,
  rows: r.rows,
  added: r.added,
  existing: r.existing,
  invalid: r.invalid,
  duplicates: r.duplicates,
  pushed: r.pushed,
  errors: r.errors,
  error: r.error,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
})

/** Other providers' words for why an address is suppressed. */
const REASON_WORDS: Record<string, Reason> = {
  hard_bounce: "hard_bounce",
  "hard bounce": "hard_bounce",
  hardbounce: "hard_bounce",
  bounce: "hard_bounce",
  bounced: "hard_bounce",
  invalid: "hard_bounce",
  complaint: "complaint",
  complained: "complaint",
  spam: "complaint",
  spam_complaint: "complaint",
  abuse: "complaint",
  unsubscribe: "unsubscribe",
  unsubscribed: "unsubscribe",
  optout: "unsubscribe",
  "opt-out": "unsubscribe",
  opted_out: "unsubscribe",
  manual: "manual",
  blocked: "manual",
  blocklisted: "manual",
  suppressed: "manual",
}
export const reasonOf = (word: string): Reason | undefined =>
  REASON_WORDS[word.trim().toLowerCase().replace(/\s+/g, " ")]

export type SuppressionImportInput = {
  readonly uploadId: string
  readonly reason?: Reason | undefined
  readonly note?: string | null | undefined
  readonly emailColumn?: string | undefined
  readonly reasonColumn?: string | undefined
  readonly noteColumn?: string | undefined
  readonly push?: boolean | undefined
}

const findUpload = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("uploads.get", (db) =>
      db.select().from(uploads).where(eq(uploads.id, id)).get(),
    )
    if (!row) return yield* new UploadNotFound({ id })
    return row
  })

const findImport = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("suppressionImports.get", (db) =>
      db.select().from(suppressionImports).where(eq(suppressionImports.id, id)).get(),
    )
    if (!row) return yield* new ImportNotFound({ id })
    return row
  })

export const workflowIdOf = (importId: string) => `suppression-import-${importId}`

/** Records the import and starts its Workflow; if the Workflow can't start, the import is marked failed. */
export const startSuppressionImport = Effect.fn("suppressionImports.start")(function* (
  input: SuppressionImportInput,
  actor: string,
) {
  yield* findUpload(input.uploadId)
  if (input.push) {
    const cf = yield* CloudflareEmail
    if (!cf.suppressions.canWrite)
      return yield* new ImportInvalid({
        field: "push",
        message:
          "Pushing needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_WRITE_TOKEN (Email Sending: Edit).",
      })
  }
  const database = yield* Database
  const id = `sim_${yield* (yield* Ids).next}`
  const row = yield* database.query("suppressionImports.insert", (db) =>
    db
      .insert(suppressionImports)
      .values({
        id,
        uploadId: input.uploadId,
        reason: input.reason ?? "manual",
        note: input.note?.trim().slice(0, 1000) || null,
        emailColumn: input.emailColumn?.trim() || null,
        reasonColumn: input.reasonColumn?.trim() || null,
        noteColumn: input.noteColumn?.trim() || null,
        push: input.push === true,
        createdBy: actor,
      })
      .returning()
      .get(),
  )
  yield* recordAudit({
    actor,
    action: "suppressions.import",
    target: id,
    after: { uploadId: input.uploadId, reason: row.reason, push: row.push },
  })
  const { SUPPRESSION_IMPORT_WORKFLOW } = yield* Bindings
  const started = yield* Effect.tryPromise({
    try: async () => {
      const instance = await SUPPRESSION_IMPORT_WORKFLOW.create({
        id: workflowIdOf(id),
        params: { importId: id },
      })
      ;(instance as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.logError("suppression imports: workflow did not start", cause).pipe(Effect.as(false)),
    ),
  )
  if (!started) {
    yield* fail(id, "The import couldn't start; try again.")
    return describeSuppressionImport(yield* findImport(id))
  }
  return describeSuppressionImport(row)
})

export const getSuppressionImport = Effect.fn("suppressionImports.get")(function* (id: string) {
  return describeSuppressionImport(yield* findImport(id))
})

export const listSuppressionImports = Effect.fn("suppressionImports.list")(function* (query: {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) {
  const database = yield* Database
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
  const rows = yield* database.query("suppressionImports.list", (db) =>
    db
      .select()
      .from(suppressionImports)
      .where(query.cursor ? lt(suppressionImports.id, query.cursor) : undefined)
      .orderBy(desc(suppressionImports.id))
      .limit(limit + 1)
      .all(),
  )
  const page = rows.slice(0, limit)
  return {
    imports: page.map(describeSuppressionImport),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  }
})

// ---------------------------------------------------------------------------------------------
// The Workflow's steps
// ---------------------------------------------------------------------------------------------

const fail = (id: string, message: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.query("suppressionImports.fail", (db) =>
      db
        .update(suppressionImports)
        .set({ status: "failed", error: message, finishedAt: Date.now() })
        .where(eq(suppressionImports.id, id))
        .run(),
    )
    yield* raiseAlert({
      key: `import_failed:${id}`,
      kind: "import_failed",
      severity: "warning",
      title: "A suppression import failed",
      detail: message.slice(0, 500),
      subject: { type: "suppression_import", id },
    })
    return { done: true as const, failed: true, offset: -1 }
  })

const readRange = (key: string, offset: number, length: number) =>
  Effect.gen(function* () {
    const blob = yield* (yield* BlobStore).getRange(key, offset, length)
    return Option.map(blob, (bytes) =>
      new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes),
    )
  })

const EMAIL_HEADERS = ["email", "e-mail", "email address", "email_address", "address", "recipient"]

/** Step 1: the header row; which columns hold the email, reason and note; the start offset. */
export const startImport = Effect.fn("suppressionImports.header")(function* (id: string) {
  const database = yield* Database
  const row = yield* findImport(id)
  if (row.status !== "queued") return { failed: row.status === "failed", offset: row.offset }
  const upload = yield* findUpload(row.uploadId)
  const head = yield* readRange(upload.key, 0, Math.min(upload.size, 256 * 1024))
  if (Option.isNone(head)) return yield* fail(id, "The uploaded file is gone from storage.")
  const text = head.value
  const bom = text.startsWith(BOM)
  const parsed = parseCsv(bom ? text.slice(1) : text, { maxRecords: 1, final: upload.size <= 256 * 1024 })
  const header = parsed.records[0]
  if (!header) return yield* fail(id, "The file has no header row (or its first row is longer than 256 KB).")
  const headers = header.fields.map((h) => h.trim())
  const emailColumn = row.emailColumn ?? headers.find((h) => EMAIL_HEADERS.includes(h.toLowerCase())) ?? null
  if (!emailColumn)
    return yield* fail(id, `No email column: name one with emailColumn (the file has ${headers.join(", ")}).`)
  for (const [name, column] of [
    ["emailColumn", emailColumn],
    ["reasonColumn", row.reasonColumn],
    ["noteColumn", row.noteColumn],
  ] as const)
    if (column && !headers.includes(column))
      return yield* fail(id, `${name} "${column}" isn't a column in the file.`)
  const offset =
    (bom ? byteLength(BOM) : 0) + byteLength((bom ? text.slice(1) : text).slice(0, parsed.consumed))
  yield* database.query("suppressionImports.started", (db) =>
    db
      .update(suppressionImports)
      .set({ status: "running", headers, emailColumn, offset, line: parsed.nextLine })
      .where(eq(suppressionImports.id, id))
      .run(),
  )
  return { failed: false, offset }
})

/** One step: up to 5,000 rows from `from`, written and counted in a single batch. */
export const importChunk = Effect.fn("suppressionImports.chunk")(function* (id: string, from: number) {
  const database = yield* Database
  const row = yield* findImport(id)
  const upload = yield* findUpload(row.uploadId)
  if (row.status !== "running") return { done: true, failed: row.status === "failed", offset: row.offset }
  if (row.offset !== from) return { done: row.offset >= upload.size, failed: false, offset: row.offset }
  if (from >= upload.size) return { done: true, failed: false, offset: from }

  const length = Math.min(READ_BYTES, upload.size - from)
  const text = yield* readRange(upload.key, from, length)
  if (Option.isNone(text)) return yield* fail(id, "The uploaded file is gone from storage.")
  const final = from + length >= upload.size
  const parsed = parseCsv(text.value, { maxRecords: CHUNK_ROWS, final, startLine: row.line })
  if (parsed.records.length === 0 && parsed.partial)
    return yield* fail(
      id,
      final
        ? `Line ${row.line}: a quoted field is never closed.`
        : `Line ${row.line}: a row is longer than ${READ_BYTES / 1024 / 1024} MB.`,
    )
  const next = from + byteLength(text.value.slice(0, parsed.consumed))
  const done = next >= upload.size || (final && !parsed.partial && parsed.records.length < CHUNK_ROWS)

  const headers = row.headers ?? []
  const emailAt = headers.indexOf(row.emailColumn ?? "")
  const reasonAt = row.reasonColumn ? headers.indexOf(row.reasonColumn) : -1
  const noteAt = row.noteColumn ? headers.indexOf(row.noteColumn) : -1
  const errors: Array<{ line: number; message: string }> = []
  const byEmail = new Map<string, { email: string; reason: Reason; note: string | null }>()
  let invalid = 0
  let duplicates = 0
  for (const record of parsed.records) {
    const raw = (record.fields[emailAt] ?? "").trim()
    const email = normalizeEmail(raw)
    if (!EMAIL.test(email)) {
      invalid++
      errors.push({
        line: record.line,
        message: raw ? `Not an email address: ${raw.slice(0, 100)}` : "No email.",
      })
      continue
    }
    const word = reasonAt >= 0 ? (record.fields[reasonAt] ?? "").trim() : ""
    const reason = word ? reasonOf(word) : row.reason
    if (!reason) {
      invalid++
      errors.push({
        line: record.line,
        message: `Unknown reason "${word.slice(0, 40)}": use hard_bounce, complaint, unsubscribe or manual.`,
      })
      continue
    }
    const note = (noteAt >= 0 ? (record.fields[noteAt] ?? "").trim().slice(0, 1000) : "") || row.note
    const seen = byEmail.get(email)
    if (seen) {
      duplicates++
      // The stronger reason wins: a complaint over a bounce over anything else.
      const rank = (r: Reason) => ({ complaint: 3, hard_bounce: 2, manual: 1, unsubscribe: 0 })[r]
      if (rank(reason) > rank(seen.reason)) byEmail.set(email, { email, reason, note: note ?? seen.note })
    } else byEmail.set(email, { email, reason, note })
  }

  const emails = [...byEmail.keys()]
  const existing = new Set<string>()
  for (let i = 0; i < emails.length; i += 90) {
    const found = yield* database.query("suppressionImports.existing", (db) =>
      db
        .select({ email: suppressions.email })
        .from(suppressions)
        .where(inArray(suppressions.email, emails.slice(i, i + 90)))
        .all(),
    )
    for (const f of found) existing.add(f.email)
  }
  const adds = [...byEmail.values()]
    .filter((r) => !existing.has(r.email))
    .map((r) => ({ ...r, bulkOnly: r.reason === "unsubscribe", cloudflareId: null as string | null }))

  // Push first, so the commit can record Cloudflare's ids; a retry pushes again, which Cloudflare de-duplicates.
  let pushed = 0
  if (row.push) {
    const cf = yield* CloudflareEmail
    const toPush = adds.filter((a) => !a.bulkOnly)
    for (let i = 0; i < toPush.length; i += 1_000) {
      const part = toPush.slice(i, i + 1_000)
      const result = yield* cf.suppressions.bulk(
        part.map((a) => ({ email: a.email, note: `Mailyard import ${id}: ${a.reason}` })),
      )
      if (!result.ok) {
        errors.push({ line: row.line, message: `Cloudflare refused the push: ${result.message}` })
        break
      }
      const ids = new Map(result.value.map((r) => [normalizeEmail(r.email), r]))
      for (const a of part) {
        const got = ids.get(a.email)
        if (got?.id) {
          a.cloudflareId = got.id
          pushed++
        }
      }
    }
  }

  const now = Date.now()
  const guard = `exists (select 1 from suppression_imports where id = ? and "offset" = ?)`
  const g = [id, from]
  const statements: Array<{ readonly sql: string; readonly params: ReadonlyArray<unknown> }> = []
  for (let i = 0; i < adds.length; i += SLICE) {
    const json = JSON.stringify(adds.slice(i, i + SLICE))
    statements.push(
      {
        sql: `insert into suppressions (email, reason, source, note, bulk_only, contact_status_before,
            cloudflare_id, synced_to_cloudflare, cloudflare_checked_at, at, updated_at)
          select json_extract(j.value, '$.email'), json_extract(j.value, '$.reason'), 'import',
            json_extract(j.value, '$.note'), json_extract(j.value, '$.bulkOnly'),
            (select c.status from contacts c where c.email = json_extract(j.value, '$.email')
              and c.status not in ('bounced', 'complained', 'suppressed')),
            json_extract(j.value, '$.cloudflareId'), json_extract(j.value, '$.cloudflareId') is not null,
            case when json_extract(j.value, '$.cloudflareId') is not null then ? end, ?, ?
          from json_each(?) as j where ${guard}
          on conflict(email) do nothing`,
        params: [now, now, now, json, ...g],
      },
      {
        sql: `update contacts set status = case json_extract(j.value, '$.reason') when 'unsubscribe' then 'unsubscribed' else 'suppressed' end
          from json_each(?) as j
          where contacts.email = json_extract(j.value, '$.email')
            and contacts.status not in ('bounced', 'complained', 'suppressed')
            and not (json_extract(j.value, '$.reason') = 'unsubscribe' and contacts.status = 'unsubscribed')
            and ${guard}`,
        params: [json, ...g],
      },
    )
  }
  statements.push({
    sql: `update suppression_imports set
        "offset" = ?, line = ?,
        rows = rows + ?, added = added + ?, existing = existing + ?, invalid = invalid + ?,
        duplicates = duplicates + ?, pushed = pushed + ?,
        errors = (select json_group_array(json(value)) from (
          select value from json_each(errors)
          union all select value from json_each(?)
          limit ${MAX_ERRORS}))
      where id = ? and "offset" = ?`,
    params: [
      next,
      parsed.nextLine,
      parsed.records.length,
      adds.length,
      byEmail.size - adds.length,
      invalid,
      duplicates,
      pushed,
      JSON.stringify(errors),
      ...g,
    ],
  })
  const { DB } = yield* Bindings
  yield* database.query("suppressionImports.batch", () =>
    DB.batch(statements.map((x) => DB.prepare(x.sql).bind(...x.params))),
  )
  return { done, failed: false, offset: next }
})

/** Last step: mark it completed and audit the totals. */
export const finishImport = Effect.fn("suppressionImports.finish")(function* (id: string) {
  const database = yield* Database
  const row = yield* findImport(id)
  if (row.status !== "running") return describeSuppressionImport(row)
  const done = yield* database.query("suppressionImports.finish", (db) =>
    db
      .update(suppressionImports)
      .set({ status: "completed", finishedAt: Date.now() })
      .where(eq(suppressionImports.id, id))
      .returning()
      .get(),
  )
  if (!done) return describeSuppressionImport(row)
  yield* recordAudit({
    actor: row.createdBy,
    action: "suppressions.imported",
    target: id,
    after: {
      rows: done.rows,
      added: done.added,
      existing: done.existing,
      invalid: done.invalid,
      pushed: done.pushed,
    },
  })
  return describeSuppressionImport(done)
})

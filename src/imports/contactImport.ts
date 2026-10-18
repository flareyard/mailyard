import { desc, eq, inArray, lt } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { contactImports, contacts, subscriptions, suppressions, topics, uploads } from "../db/schema.ts"
import { raiseAlert } from "../domain/alerts.ts"
import { recordAudit } from "../domain/audit.ts"
import { normalizeEmail } from "../domain/contacts.ts"
import { sha256Hex } from "../inbound/parse.ts"
import { BlobStore, Ids } from "../kit/index.ts"
import { Database, queryIn } from "../services/Database.ts"
import { BOM, byteLength, parseCsv } from "./csv.ts"

/**
 * Contact CSV imports (HAL-3291). A file is uploaded to R2, then ContactImportWorkflow reads it in
 * steps of 5,000 rows from a byte offset kept on the import row. Each step's writes and its counts
 * go in one D1 batch, guarded by that offset, so a retried step can neither write twice nor count
 * twice. Rows are passed to SQL as one JSON parameter and expanded with `json_each`, so a step is a
 * handful of statements however many rows it holds.
 *
 * Consent rules: a suppressed address joins as `suppressed` with no topics; an existing contact who
 * unsubscribed, bounced or complained is never resubscribed by an import; a topic someone left
 * stays left. Imports don't send per-contact webhooks: 50,000 `contact.created` events would bury
 * every other delivery.
 */

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const CHUNK_ROWS = 5_000
/** How much of the file one step reads; a step stops at the last whole record within it. */
const READ_BYTES = 4 * 1024 * 1024
/** Rows per JSON parameter, to keep each well under D1's 2 MB value limit. */
const SLICE = 1_000
const MAX_ERRORS = 100
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export class UploadNotFound extends Schema.TaggedError<UploadNotFound>()("UploadNotFound", {
  id: Schema.String,
}) {}
export class ImportNotFound extends Schema.TaggedError<ImportNotFound>()("ImportNotFound", {
  id: Schema.String,
}) {}
export class ImportInvalid extends Schema.TaggedError<ImportInvalid>()("ImportInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

type ImportRow = typeof contactImports.$inferSelect

export const describeImport = (r: ImportRow) => ({
  id: r.id,
  uploadId: r.uploadId,
  status: r.status,
  mapping: r.mapping,
  topicIds: r.topicIds,
  onConflict: r.onConflict,
  defaultStatus: r.defaultStatus,
  headers: r.headers ?? null,
  rows: r.rows,
  created: r.created,
  updated: r.updated,
  skipped: r.skipped,
  invalid: r.invalid,
  duplicates: r.duplicates,
  suppressed: r.suppressed,
  errors: r.errors,
  error: r.error,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
})
export type ImportView = ReturnType<typeof describeImport>

// ---------------------------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------------------------

export const createUpload = Effect.fn("uploads.create")(function* (
  input: { readonly bytes: Uint8Array; readonly filename: string; readonly mimeType: string },
  actor: string,
) {
  const database = yield* Database
  const id = `upl_${yield* (yield* Ids).next}`
  const key = `uploads/${id}`
  yield* (yield* BlobStore).put(key, input.bytes, input.mimeType)
  const sha256 = yield* Effect.promise(() => sha256Hex(input.bytes))
  const row = yield* database.query("uploads.insert", (db) =>
    db
      .insert(uploads)
      .values({
        id,
        key,
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.bytes.byteLength,
        sha256,
        createdBy: actor,
      })
      .returning()
      .get(),
  )
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.createdAt,
  }
})

const findUpload = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("uploads.get", (db) =>
      db.select().from(uploads).where(eq(uploads.id, id)).get(),
    )
    if (!row) return yield* new UploadNotFound({ id })
    return row
  })

// ---------------------------------------------------------------------------------------------
// Starting, reading
// ---------------------------------------------------------------------------------------------

export type ImportInput = {
  readonly uploadId: string
  readonly mapping: Readonly<Record<string, string>>
  readonly topicIds?: ReadonlyArray<string> | undefined
  readonly onConflict?: "update" | "skip" | undefined
  readonly defaultStatus?: "subscribed" | "unsubscribed" | undefined
}

/** What a mapping target must look like: `email`, `name`, `status`, `fields.<name>` or `ignore`. */
const checkMapping = (mapping: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const targets = Object.values(mapping)
    if (targets.filter((t) => t === "email").length !== 1)
      return yield* new ImportInvalid({ field: "mapping", message: "Map exactly one column to email." })
    for (const t of ["name", "status"])
      if (targets.filter((x) => x === t).length > 1)
        return yield* new ImportInvalid({ field: "mapping", message: `Map at most one column to ${t}.` })
    const fieldNames = new Set<string>()
    for (const [column, target] of Object.entries(mapping)) {
      if (["email", "name", "status", "ignore"].includes(target)) continue
      const name = target.startsWith("fields.") ? target.slice(7) : null
      if (!name || !FIELD_NAME.test(name))
        return yield* new ImportInvalid({
          field: `mapping.${column}`,
          message: `"${target}" isn't email, name, status, ignore or fields.<name> (letters, digits, underscores).`,
        })
      if (fieldNames.has(name))
        return yield* new ImportInvalid({
          field: `mapping.${column}`,
          message: `Two columns map to fields.${name}.`,
        })
      fieldNames.add(name)
    }
    if (fieldNames.size > 50)
      return yield* new ImportInvalid({ field: "mapping", message: "At most 50 custom fields." })
  })

/** Records the import; the caller starts its Workflow under `workflowIdOf(id)`. */
export const createContactImport = Effect.fn("imports.create")(function* (input: ImportInput, actor: string) {
  const database = yield* Database
  yield* findUpload(input.uploadId)
  yield* checkMapping(input.mapping)
  const topicIds = [...new Set(input.topicIds ?? [])]
  if (topicIds.length > 0) {
    const found = yield* queryIn("imports.topics", topicIds, (db, chunk) =>
      db.select({ id: topics.id }).from(topics).where(inArray(topics.id, chunk)).all(),
    )
    const missing = topicIds.filter((t) => !found.some((f) => f.id === t))
    if (missing.length > 0)
      return yield* new ImportInvalid({ field: "topicIds", message: `No such topic: ${missing.join(", ")}.` })
  }
  const id = `imp_${yield* (yield* Ids).next}`
  const row = yield* database.query("imports.insert", (db) =>
    db
      .insert(contactImports)
      .values({
        id,
        uploadId: input.uploadId,
        mapping: { ...input.mapping },
        topicIds,
        onConflict: input.onConflict ?? "update",
        defaultStatus: input.defaultStatus ?? "subscribed",
        createdBy: actor,
      })
      .returning()
      .get(),
  )
  yield* recordAudit({
    actor,
    action: "contacts.import",
    target: id,
    after: { uploadId: input.uploadId, topicIds },
  })
  return describeImport(row)
})

export const workflowIdOf = (importId: string) => `contact-import-${importId}`

/** Records the import and starts its Workflow; if the Workflow can't start, the import is marked failed. */
export const startContactImport = Effect.fn("imports.startWorkflow")(function* (
  input: ImportInput,
  actor: string,
) {
  const view = yield* createContactImport(input, actor)
  const { CONTACT_IMPORT_WORKFLOW } = yield* Bindings
  const started = yield* Effect.tryPromise({
    try: async () => {
      const instance = await CONTACT_IMPORT_WORKFLOW.create({
        id: workflowIdOf(view.id),
        params: { importId: view.id },
      })
      ;(instance as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.logError("imports: workflow did not start", cause).pipe(Effect.as(false)),
    ),
  )
  if (!started) {
    yield* fail(view.id, "The import couldn't start; try again.")
    return describeImport(yield* findImport(view.id))
  }
  return view
})

const findImport = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("imports.get", (db) =>
      db.select().from(contactImports).where(eq(contactImports.id, id)).get(),
    )
    if (!row) return yield* new ImportNotFound({ id })
    return row
  })

export const getContactImport = Effect.fn("imports.get")(function* (id: string) {
  return describeImport(yield* findImport(id))
})

export const listContactImports = Effect.fn("imports.list")(function* (query: {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) {
  const database = yield* Database
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
  const rows = yield* database.query("imports.list", (db) =>
    db
      .select()
      .from(contactImports)
      .where(query.cursor ? lt(contactImports.id, query.cursor) : undefined)
      .orderBy(desc(contactImports.id))
      .limit(limit + 1)
      .all(),
  )
  const page = rows.slice(0, limit)
  return {
    imports: page.map(describeImport),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  }
})

// ---------------------------------------------------------------------------------------------
// The Workflow's steps
// ---------------------------------------------------------------------------------------------

const fail = (id: string, message: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.query("imports.fail", (db) =>
      db
        .update(contactImports)
        .set({ status: "failed", error: message, finishedAt: Date.now() })
        .where(eq(contactImports.id, id))
        .run(),
    )
    yield* raiseAlert({
      key: `import_failed:${id}`,
      kind: "import_failed",
      severity: "warning",
      title: "A contact import failed",
      detail: message.slice(0, 500),
      subject: { type: "contact_import", id },
    })
    return { done: true as const, failed: true, offset: -1 }
  })

const readRange = (key: string, offset: number, length: number) =>
  Effect.gen(function* () {
    const store = yield* BlobStore
    const blob = yield* store.getRange(key, offset, length)
    return Option.map(blob, (bytes) =>
      new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes),
    )
  })

/** Step 1: read the header row, check the mapping names columns that exist, and set the start offset. */
export const startImport = Effect.fn("imports.start")(function* (id: string) {
  const database = yield* Database
  const row = yield* findImport(id)
  if (row.status !== "queued") return { failed: row.status === "failed", offset: row.offset }
  const upload = yield* findUpload(row.uploadId)
  const head = yield* readRange(upload.key, 0, Math.min(upload.size, 256 * 1024))
  if (Option.isNone(head)) return yield* fail(id, "The uploaded file is gone from storage.")
  const text = head.value
  const bom = text.startsWith(BOM)
  const parsed = parseCsv(bom ? text.slice(1) : text, {
    maxRecords: 1,
    final: upload.size <= 256 * 1024,
  })
  const header = parsed.records[0]
  if (!header) return yield* fail(id, "The file has no header row (or its first row is longer than 256 KB).")
  const headers = header.fields.map((h) => h.trim())
  const unknown = Object.keys(row.mapping).filter((c) => !headers.includes(c))
  if (unknown.length > 0)
    return yield* fail(id, `The mapping names columns the file doesn't have: ${unknown.join(", ")}.`)
  const offset =
    (bom ? byteLength(BOM) : 0) + byteLength((bom ? text.slice(1) : text).slice(0, parsed.consumed))
  yield* database.query("imports.started", (db) =>
    db
      .update(contactImports)
      .set({ status: "running", headers, offset, line: parsed.nextLine })
      .where(eq(contactImports.id, id))
      .run(),
  )
  return { failed: false, offset }
})

type Parsed = {
  email: string
  name: string | null
  status: "subscribed" | "unsubscribed" | null
  fields: Record<string, string>
}

const BLOCKED_OR_LEFT = ["bounced", "complained", "suppressed", "unsubscribed"]

const slices = <T>(items: ReadonlyArray<T>, size: number) => {
  const out: Array<ReadonlyArray<T>> = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * One step: up to 5,000 rows from `from`, written and counted in a single batch. Returns where the
 * next step starts, or `done`. Re-running a step that already committed changes nothing.
 */
export const importChunk = Effect.fn("imports.chunk")(function* (id: string, from: number) {
  const database = yield* Database
  const row = yield* findImport(id)
  const upload = yield* findUpload(row.uploadId)
  if (row.status !== "running") return { done: true, failed: row.status === "failed", offset: row.offset }
  // Already done by an earlier attempt whose result was lost.
  if (row.offset !== from) return { done: row.offset >= upload.size, failed: false, offset: row.offset }
  if (from >= upload.size) return { done: true, failed: false, offset: from }

  const length = Math.min(READ_BYTES, upload.size - from)
  const text = yield* readRange(upload.key, from, length)
  if (Option.isNone(text)) return yield* fail(id, "The uploaded file is gone from storage.")
  const final = from + length >= upload.size
  const parsed = parseCsv(text.value, { maxRecords: CHUNK_ROWS, final, startLine: row.line })
  if (parsed.records.length === 0) {
    if (parsed.partial)
      return yield* fail(
        id,
        final
          ? `Line ${row.line}: a quoted field is never closed.`
          : `Line ${row.line}: a row is longer than ${READ_BYTES / 1024 / 1024} MB.`,
      )
    // Only blank lines left.
  }
  const next = from + byteLength(text.value.slice(0, parsed.consumed))
  const done = next >= upload.size || (final && !parsed.partial && parsed.records.length < CHUNK_ROWS)

  // Map, validate and merge the file's own duplicates.
  const headers = row.headers ?? []
  const column = (target: string) => headers.findIndex((h) => row.mapping[h] === target)
  const emailAt = column("email")
  const nameAt = column("name")
  const statusAt = column("status")
  const fieldColumns = headers.flatMap((h, i) => {
    const target = row.mapping[h]
    return target?.startsWith("fields.") ? [{ i, key: target.slice(7) }] : []
  })
  const errors: Array<{ line: number; message: string }> = []
  const byEmail = new Map<string, Parsed>()
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
    const statusRaw = statusAt >= 0 ? (record.fields[statusAt] ?? "").trim().toLowerCase() : ""
    if (statusRaw && statusRaw !== "subscribed" && statusRaw !== "unsubscribed") {
      invalid++
      errors.push({
        line: record.line,
        message: `Status must be subscribed or unsubscribed, not "${statusRaw.slice(0, 40)}".`,
      })
      continue
    }
    const fields: Record<string, string> = {}
    for (const f of fieldColumns) {
      const value = (record.fields[f.i] ?? "").trim()
      // An empty cell leaves the field as it was.
      if (value) fields[f.key] = value.slice(0, 2000)
    }
    const name = nameAt >= 0 ? (record.fields[nameAt] ?? "").trim().slice(0, 200) || null : null
    const status = (statusRaw || null) as Parsed["status"]
    const seen = byEmail.get(email)
    if (seen) {
      duplicates++
      byEmail.set(email, {
        email,
        name: name ?? seen.name,
        status: status ?? seen.status,
        fields: { ...seen.fields, ...fields },
      })
    } else byEmail.set(email, { email, name, status, fields })
  }

  // Who is already a contact, who is suppressed, and which topic memberships exist.
  const emails = [...byEmail.keys()]
  const existing = new Map<string, { id: string; status: string }>()
  const suppressed = new Set<string>()
  for (const part of slices(emails, 90)) {
    const found = yield* database.query("imports.existing", (db) =>
      db
        .select({ id: contacts.id, email: contacts.email, status: contacts.status })
        .from(contacts)
        .where(inArray(contacts.email, [...part]))
        .all(),
    )
    for (const c of found) existing.set(c.email, c)
    const blocked = yield* database.query("imports.suppressed", (db) =>
      db
        .select({ email: suppressions.email })
        .from(suppressions)
        .where(inArray(suppressions.email, [...part]))
        .all(),
    )
    for (const s of blocked) suppressed.add(s.email)
  }
  const memberships = new Set<string>()
  if (row.topicIds.length > 0) {
    const ids = [...existing.values()].map((c) => c.id)
    for (const part of slices(ids, 90)) {
      const found = yield* database.query("imports.memberships", (db) =>
        db
          .select({ contactId: subscriptions.contactId, topicId: subscriptions.topicId })
          .from(subscriptions)
          .where(inArray(subscriptions.contactId, [...part]))
          .all(),
      )
      for (const m of found) memberships.add(`${m.contactId}:${m.topicId}`)
    }
  }

  const ids = yield* Ids
  const now = Date.now()
  const inserts: Array<{ id: string; email: string; name: string | null; fields: string; status: string }> =
    []
  const updates: Array<{ id: string; name: string | null; fields: string; status: string | null }> = []
  const joins: Array<{ email: string; topicId: string }> = []
  let created = 0
  let updated = 0
  let skipped = 0
  let suppressedCount = 0
  for (const p of byEmail.values()) {
    const current = existing.get(p.email)
    if (!current) {
      const isSuppressed = suppressed.has(p.email)
      const status = isSuppressed ? "suppressed" : (p.status ?? row.defaultStatus)
      inserts.push({
        id: yield* ids.next,
        email: p.email,
        name: p.name,
        fields: JSON.stringify(p.fields),
        status,
      })
      created++
      if (isSuppressed) suppressedCount++
      if (status === "subscribed") for (const topicId of row.topicIds) joins.push({ email: p.email, topicId })
      continue
    }
    if (row.onConflict === "skip") {
      skipped++
      continue
    }
    const keeps = BLOCKED_OR_LEFT.includes(current.status)
    const status = keeps ? current.status : (p.status ?? current.status)
    updates.push({
      id: current.id,
      name: p.name,
      fields: JSON.stringify(p.fields),
      status: keeps ? null : p.status,
    })
    updated++
    if (status === "subscribed")
      for (const topicId of row.topicIds)
        if (!memberships.has(`${current.id}:${topicId}`)) joins.push({ email: p.email, topicId })
  }

  // One batch: every write is guarded by the offset this step started from, and the import row's
  // counts and offset move last. If an earlier attempt already committed, nothing here applies.
  const guard = `exists (select 1 from contact_imports where id = ? and "offset" = ?)`
  const g = [id, from]
  const statements: Array<{ readonly sql: string; readonly params: ReadonlyArray<unknown> }> = [
    ...slices(inserts, SLICE).map((part) => ({
      sql: `insert into contacts (id, email, name, fields, status, last_activity_at)
        select json_extract(value, '$.id'), json_extract(value, '$.email'), json_extract(value, '$.name'),
          json_extract(value, '$.fields'), json_extract(value, '$.status'), ?
        from json_each(?) where ${guard}
        on conflict(email) do nothing`,
      params: [now, JSON.stringify(part), ...g],
    })),
    ...slices(updates, SLICE).map((part) => ({
      sql: `update contacts set
          name = coalesce(j.name, contacts.name),
          fields = json_patch(contacts.fields, j.fields),
          status = coalesce(j.status, contacts.status),
          last_activity_at = ?
        from (select json_extract(value, '$.id') as id, json_extract(value, '$.name') as name,
                json_extract(value, '$.fields') as fields, json_extract(value, '$.status') as status
              from json_each(?)) as j
        where contacts.id = j.id and ${guard}`,
      params: [now, JSON.stringify(part), ...g],
    })),
    ...slices(joins, SLICE).flatMap((part) => {
      const json = JSON.stringify(part)
      return [
        {
          sql: `insert into subscription_changes (id, contact_id, topic_id, "from", "to", source, at)
            select 'chg_' || lower(hex(randomblob(12))), c.id, json_extract(j.value, '$.topicId'), null, 'subscribed', 'import', ?
            from json_each(?) as j join contacts c on c.email = json_extract(j.value, '$.email')
            where ${guard} and not exists (select 1 from subscriptions s
              where s.contact_id = c.id and s.topic_id = json_extract(j.value, '$.topicId'))`,
          params: [now, json, ...g],
        },
        {
          sql: `insert into subscriptions (contact_id, topic_id, state, source, changed_at)
            select c.id, json_extract(j.value, '$.topicId'), 'subscribed', 'import', ?
            from json_each(?) as j join contacts c on c.email = json_extract(j.value, '$.email')
            where ${guard}
            on conflict(contact_id, topic_id) do nothing`,
          params: [now, json, ...g],
        },
      ]
    }),
    {
      sql: `update contact_imports set
          "offset" = ?, line = ?,
          rows = rows + ?, created = created + ?, updated = updated + ?, skipped = skipped + ?,
          invalid = invalid + ?, duplicates = duplicates + ?, suppressed = suppressed + ?,
          errors = (select json_group_array(json(value)) from (
            select value from json_each(errors)
            union all select value from json_each(?)
            limit ${MAX_ERRORS}))
        where id = ? and "offset" = ?`,
      params: [
        next,
        parsed.nextLine,
        parsed.records.length,
        created,
        updated,
        skipped,
        invalid,
        duplicates,
        suppressedCount,
        JSON.stringify(errors),
        ...g,
      ],
    },
  ]
  const { DB } = yield* Bindings
  yield* database.query("imports.batch", () =>
    DB.batch(statements.map((x) => DB.prepare(x.sql).bind(...x.params))),
  )
  return { done, failed: false, offset: next }
})

/** Last step: mark it completed and audit the totals. */
export const finishImport = Effect.fn("imports.finish")(function* (id: string) {
  const database = yield* Database
  const row = yield* findImport(id)
  if (row.status !== "running") return describeImport(row)
  const done = yield* database.query("imports.finish", (db) =>
    db
      .update(contactImports)
      .set({ status: "completed", finishedAt: Date.now() })
      .where(eq(contactImports.id, id))
      .returning()
      .get(),
  )
  if (!done) return describeImport(row)
  yield* recordAudit({
    actor: row.createdBy,
    action: "contacts.imported",
    target: id,
    after: { rows: done.rows, created: done.created, updated: done.updated, invalid: done.invalid },
  })
  return describeImport(done)
})

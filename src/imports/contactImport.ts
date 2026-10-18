import { desc, eq, inArray, lt } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import {
  contactFields,
  contactImports,
  contacts,
  type ImportRowError,
  subscriptions,
  suppressions,
  topics,
  uploads,
} from "../db/schema.ts"
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

/** Where one step's rejected rows are kept; the offset is padded so the keys sort in file order. */
export const errorsKeyOf = (id: string, from: number) =>
  `imports/${id}/errors/${String(from).padStart(12, "0")}.csv`
export const ERRORS_HEADER = "line,column,value,code,message\r\n"
const errorCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const errorLine = (e: ImportRowError) =>
  `${[e.line, e.column, e.value, e.code, e.message].map(errorCell).join(",")}\r\n`
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

type UploadRow = typeof uploads.$inferSelect

/**
 * An import as the API shows it. Progress (HAL-3371): `bytesRead` of `size` is exact from the start,
 * since rows aren't known until the end; `processed` is rows read so far (`rows` is the same number);
 * `ratePerMinute` and `etaAt` come from the bytes read since it started. `skipped` includes neither
 * `duplicates` (repeats within the file, merged into one row) nor `suppressed` (created, but blocked);
 * rows written before a failure or a cancel are kept.
 */
export const describeImport = (
  r: ImportRow,
  upload: Pick<UploadRow, "filename" | "size"> | null,
  now = Date.now(),
) => {
  const size = upload?.size ?? null
  const bytesRead = size === null ? r.offset : Math.min(r.offset, size)
  const running = r.status === "running" && r.startedAt !== null
  const minutes = running ? Math.max((now - (r.startedAt ?? now)) / 60_000, 1 / 60) : null
  const bytesPerMs = running && now > (r.startedAt ?? now) ? bytesRead / (now - (r.startedAt ?? now)) : 0
  return {
    id: r.id,
    uploadId: r.uploadId,
    fileName: upload?.filename ?? null,
    fileSize: size,
    status: r.status,
    mapping: r.mapping,
    topicIds: r.topicIds,
    onConflict: r.onConflict,
    defaultStatus: r.defaultStatus,
    headers: r.headers ?? null,
    rows: r.rows,
    processed: r.rows,
    bytesRead,
    size,
    ratePerMinute: minutes === null ? null : Math.round(r.rows / minutes),
    etaAt:
      running && size !== null && bytesPerMs > 0 ? Math.round(now + (size - bytesRead) / bytesPerMs) : null,
    created: r.created,
    updated: r.updated,
    skipped: r.skipped,
    invalid: r.invalid,
    duplicates: r.duplicates,
    suppressed: r.suppressed,
    errors: r.errors.map((e) => ({
      line: e.line,
      message: e.message,
      column: e.column ?? null,
      value: e.value ?? null,
      code: e.code ?? null,
    })),
    errorsTotal: r.errorsTotal,
    consent: r.attestedBy
      ? {
          attested: true as const,
          statement: r.consentStatement,
          attestedBy: r.attestedBy,
          attestedAt: r.attestedAt,
        }
      : null,
    error: r.error,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  }
}
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
  /** The person's word that these contacts agreed to hear from the sender (HAL-3371). */
  readonly consent?: { readonly attested: boolean; readonly statement?: string | undefined } | undefined
}

/**
 * What a mapping target must look like: `email`, `name`, `name.first` and `name.last` (joined with a
 * space into the one name), `status` (a column of subscribed or unsubscribed), `fields.<name>` (an
 * existing typed field is read as its type; a new name is stored as text) or `ignore`.
 */
export const MAPPING_TARGETS = ["email", "name", "name.first", "name.last", "status", "ignore"] as const

const checkMapping = (mapping: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const targets = Object.values(mapping)
    if (targets.filter((t) => t === "email").length !== 1)
      return yield* new ImportInvalid({ field: "mapping", message: "Map exactly one column to email." })
    for (const t of ["name", "name.first", "name.last", "status"])
      if (targets.filter((x) => x === t).length > 1)
        return yield* new ImportInvalid({ field: "mapping", message: `Map at most one column to ${t}.` })
    if (targets.includes("name") && (targets.includes("name.first") || targets.includes("name.last")))
      return yield* new ImportInvalid({
        field: "mapping",
        message: "Map a column to name, or columns to name.first and name.last, not both.",
      })
    const fieldNames = new Set<string>()
    for (const [column, target] of Object.entries(mapping)) {
      if ((MAPPING_TARGETS as ReadonlyArray<string>).includes(target)) continue
      const name = target.startsWith("fields.") ? target.slice(7) : null
      if (!name || !FIELD_NAME.test(name))
        return yield* new ImportInvalid({
          field: `mapping.${column}`,
          message: `"${target}" isn't email, name, name.first, name.last, status, ignore or fields.<name> (letters, digits, underscores).`,
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
  if (input.consent && !input.consent.attested)
    return yield* new ImportInvalid({
      field: "consent.attested",
      message: "Leave consent out, or attest it with attested: true.",
    })
  const statement = input.consent?.statement?.trim().slice(0, 1000) || null
  const now = Date.now()
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
        ...(input.consent?.attested
          ? { attestedBy: actor, attestedAt: now, consentStatement: statement }
          : {}),
      })
      .returning()
      .get(),
  )
  yield* recordAudit({
    actor,
    action: "contacts.import",
    target: id,
    after: {
      uploadId: input.uploadId,
      topicIds,
      consent: input.consent?.attested ? { attested: true, statement } : null,
    },
  })
  return describeImport(row, yield* findUpload(input.uploadId))
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
    return yield* getContactImport(view.id)
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
  const row = yield* findImport(id)
  const upload = yield* findUpload(row.uploadId).pipe(Effect.orElseSucceed(() => null))
  return describeImport(row, upload)
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
  const files = yield* queryIn(
    "imports.listUploads",
    [...new Set(page.map((r) => r.uploadId))],
    (db, chunk) =>
      db
        .select({ id: uploads.id, filename: uploads.filename, size: uploads.size })
        .from(uploads)
        .where(inArray(uploads.id, chunk))
        .all(),
  )
  const byId = new Map(files.map((f) => [f.id, f]))
  return {
    imports: page.map((r) => describeImport(r, byId.get(r.uploadId) ?? null)),
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
      .set({ status: "running", headers, offset, line: parsed.nextLine, startedAt: Date.now() })
      .where(eq(contactImports.id, id))
      .run(),
  )
  return { failed: false, offset }
})

type Parsed = {
  email: string
  name: string | null
  status: "subscribed" | "unsubscribed" | null
  fields: Record<string, unknown>
}

/** A cell as its registered field type: a number, a boolean, an ISO date; undefined when it isn't one. */
export const typedValue = (type: string | undefined, value: string): unknown => {
  if (!type || type === "string") return value.slice(0, 2000)
  if (type === "number") {
    const n = Number(value.replace(/,/g, ""))
    return Number.isFinite(n) ? n : undefined
  }
  if (type === "boolean") {
    const v = value.toLowerCase()
    return ["true", "yes", "y", "1"].includes(v)
      ? true
      : ["false", "no", "n", "0"].includes(v)
        ? false
        : undefined
  }
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
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
  const firstAt = column("name.first")
  const lastAt = column("name.last")
  const statusAt = column("status")
  const fieldColumns = headers.flatMap((h, i) => {
    const target = row.mapping[h]
    return target?.startsWith("fields.") ? [{ i, key: target.slice(7), column: h }] : []
  })
  // Typed fields (the registry, HAL-3422) are read as their type; a cell that isn't one is rejected.
  const registry = fieldColumns.length
    ? yield* queryIn(
        "imports.fieldTypes",
        fieldColumns.map((f) => f.key),
        (db, chunk) =>
          db
            .select({ key: contactFields.key, type: contactFields.type })
            .from(contactFields)
            .where(inArray(contactFields.key, chunk))
            .all(),
      )
    : []
  const typeOf = new Map(registry.map((r) => [r.key, r.type]))
  const errors: Array<ImportRowError> = []
  const byEmail = new Map<string, Parsed>()
  let invalid = 0
  let duplicates = 0
  const emailColumn = headers[emailAt] ?? null
  for (const record of parsed.records) {
    // More cells than the header has columns: the row's cells can't be matched to columns, so it's
    // rejected rather than guessed at. Trailing empty cells (a spreadsheet's extra commas) are fine.
    if (record.fields.length > headers.length && record.fields.slice(headers.length).some((c) => c.trim())) {
      invalid++
      errors.push({
        line: record.line,
        message: `This row has ${record.fields.length} cells; the header has ${headers.length} columns.`,
        column: null,
        value: null,
        code: "parse_error",
      })
      continue
    }
    const raw = (record.fields[emailAt] ?? "").trim()
    const email = normalizeEmail(raw)
    if (!EMAIL.test(email)) {
      invalid++
      errors.push(
        raw
          ? {
              line: record.line,
              message: `Not an email address: ${raw.slice(0, 100)}`,
              column: emailColumn,
              value: raw.slice(0, 200),
              code: "invalid_email",
            }
          : {
              line: record.line,
              message: "No email.",
              column: emailColumn,
              value: null,
              code: "missing_email",
            },
      )
      continue
    }
    const statusRaw = statusAt >= 0 ? (record.fields[statusAt] ?? "").trim().toLowerCase() : ""
    if (statusRaw && statusRaw !== "subscribed" && statusRaw !== "unsubscribed") {
      invalid++
      errors.push({
        line: record.line,
        message: `Status must be subscribed or unsubscribed, not "${statusRaw.slice(0, 40)}".`,
        column: headers[statusAt] ?? null,
        value: statusRaw.slice(0, 200),
        code: "invalid_value",
      })
      continue
    }
    const fields: Record<string, unknown> = {}
    let bad: ImportRowError | null = null
    for (const f of fieldColumns) {
      const value = (record.fields[f.i] ?? "").trim()
      // An empty cell leaves the field as it was.
      if (!value) continue
      const typed = typedValue(typeOf.get(f.key), value)
      if (typed === undefined) {
        bad = {
          line: record.line,
          message: `"${f.column}" is a ${typeOf.get(f.key)} field; "${value.slice(0, 40)}" isn't one.`,
          column: f.column,
          value: value.slice(0, 200),
          code: "invalid_value",
        }
        break
      }
      fields[f.key] = typed
    }
    if (bad) {
      invalid++
      errors.push(bad)
      continue
    }
    const cell = (at: number) => (at >= 0 ? (record.fields[at] ?? "").trim() : "")
    const joined = [cell(firstAt), cell(lastAt)].filter(Boolean).join(" ")
    const name = (nameAt >= 0 ? cell(nameAt) : joined).slice(0, 200) || null
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

  // Each change carries what consent the import was given: the attestation, or just which import.
  const evidence = JSON.stringify({
    importId: id,
    ...(row.attestedBy
      ? { attestedBy: row.attestedBy, attestedAt: row.attestedAt, statement: row.consentStatement }
      : {}),
  })
  // Every rejected row of this step, as CSV under a key named by where the step started: a retry
  // overwrites its own file, and errors.csv reads them in order.
  if (errors.length > 0)
    yield* (yield* BlobStore).put(
      errorsKeyOf(id, from),
      new TextEncoder().encode(errors.map(errorLine).join("")),
      "text/csv; charset=utf-8",
    )

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
          sql: `insert into subscription_changes (id, contact_id, topic_id, "from", "to", source, evidence, at)
            select 'chg_' || lower(hex(randomblob(12))), c.id, json_extract(j.value, '$.topicId'), null, 'subscribed', 'import', ?, ?
            from json_each(?) as j join contacts c on c.email = json_extract(j.value, '$.email')
            where ${guard} and not exists (select 1 from subscriptions s
              where s.contact_id = c.id and s.topic_id = json_extract(j.value, '$.topicId'))`,
          params: [evidence, now, json, ...g],
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
          errors_total = errors_total + ?,
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
        errors.length,
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
  if (row.status !== "running") return { status: row.status, rows: row.rows, created: row.created }
  const done = yield* database.query("imports.finish", (db) =>
    db
      .update(contactImports)
      .set({ status: "completed", finishedAt: Date.now() })
      .where(eq(contactImports.id, id))
      .returning()
      .get(),
  )
  if (!done) return { status: row.status, rows: row.rows, created: row.created }
  yield* recordAudit({
    actor: row.createdBy,
    action: "contacts.imported",
    target: id,
    after: { rows: done.rows, created: done.created, updated: done.updated, invalid: done.invalid },
  })
  return { status: done.status, rows: done.rows, created: done.created }
})

// ---------------------------------------------------------------------------------------------
// Cancelling, and the full error list
// ---------------------------------------------------------------------------------------------

/**
 * Stops an import (HAL-3371): the Workflow is terminated and the import marked cancelled. Rows the
 * steps already wrote stay written; nothing is undone.
 */
export const cancelContactImport = Effect.fn("imports.cancel")(function* (id: string, actor: string) {
  const row = yield* findImport(id)
  if (row.status !== "queued" && row.status !== "running")
    return yield* new ImportInvalid({
      field: "status",
      message: `A ${row.status} import can't be cancelled.`,
    })
  const database = yield* Database
  yield* database.query("imports.cancel", (db) =>
    db
      .update(contactImports)
      .set({ status: "cancelled", finishedAt: Date.now() })
      .where(eq(contactImports.id, id))
      .run(),
  )
  const { CONTACT_IMPORT_WORKFLOW } = yield* Bindings
  yield* Effect.tryPromise(async () => {
    const instance = await CONTACT_IMPORT_WORKFLOW.get(workflowIdOf(id))
    await instance.terminate()
  }).pipe(
    // Already finished, or never started: the status above is what the steps check anyway.
    Effect.catchCause((cause) => Effect.logWarning("imports: could not terminate the workflow", cause)),
  )
  yield* recordAudit({ actor, action: "contacts.import.cancel", target: id, after: { rows: row.rows } })
  return yield* getContactImport(id)
})

/** Every rejected row of an import as CSV, in file order: the step files written as it ran. */
export const importErrorsCsv = Effect.fn("imports.errorsCsv")(function* (id: string) {
  yield* findImport(id)
  const { STORE } = yield* Bindings
  const chunks: Array<string> = [ERRORS_HEADER]
  let cursor: string | undefined
  do {
    const page = yield* Effect.promise(() =>
      STORE.list({ prefix: `imports/${id}/errors/`, ...(cursor ? { cursor } : {}) }),
    )
    for (const object of page.objects) {
      const body = yield* Effect.promise(() => STORE.get(object.key))
      if (body) chunks.push(yield* Effect.promise(() => body.text()))
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return `\uFEFF${chunks.join("")}`
})

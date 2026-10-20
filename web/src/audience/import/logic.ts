/**
 * Contact import, as pure functions, shared by Audience → Imports and the first run's CSV step (HAL-3310,
 * HAL-3291, HAL-3371). The browser reads the file's header and first rows itself (the importer is one step:
 * `POST /v1/uploads?filename=` then `POST /v1/imports/contacts`), so the column mapping, its rules and the
 * cell checks mirror the importer exactly (`src/imports/contactImport.ts`): the same targets, the same
 * "never name and first/last" rule, the same typed-cell parsing, the same messages.
 */
import { fmtInt, num } from "../../lib/format.ts"

type N = number | string | null | undefined

// ---------------------------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------------------------

export const MAX_CSV_BYTES = 50 * 1024 * 1024
const HEADER_LIMIT = 256 * 1024

/** One data row as read, with the file line it starts on (the header is line 1). */
export type SampleRow = { line: number; cells: string[] }
export type CsvPreview = { headers: string[]; firstRow: string[]; rows: number; sample?: SampleRow[] }

/**
 * Reads the header, the first data row and the number of data rows, the way the importer does (RFC 4180:
 * quoted fields may hold commas, "" and line breaks; CRLF or LF; blank lines skipped; a BOM dropped; headers
 * trimmed). With `sample`, also keeps that many data rows with their line numbers, for the mapping preview.
 * Returns the importer's own wording when the file can't be imported.
 */
export function previewCsv(text: string, opts: { sample?: number } = {}): CsvPreview | { error: string } {
  const src = text.startsWith("﻿") ? text.slice(1) : text
  const want = opts.sample ?? 0
  const sample: SampleRow[] = []
  let headers: string[] | null = null
  let firstRow: string[] = []
  let rows = 0
  let field = ""
  let record: string[] = []
  let quoted = false
  let fieldStarted = false
  let headerEnd = -1
  let line = 1
  let recordLine = 1

  const endRecord = () => {
    record.push(field)
    field = ""
    fieldStarted = false
    const blank = record.length === 1 && record[0] === ""
    if (!blank) {
      if (!headers) headers = record.map((h) => h.trim())
      else {
        if (rows === 0) firstRow = record
        if (sample.length < want) sample.push({ line: recordLine, cells: record })
        rows++
      }
    }
    record = []
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else {
        if (ch === "\n") line++
        field += ch
      }
      continue
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true
      fieldStarted = true
    } else if (ch === ",") {
      record.push(field)
      field = ""
      fieldStarted = false
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++
      const hadHeader = headers !== null
      endRecord()
      line++
      recordLine = line
      if (!hadHeader && headers !== null) headerEnd = i
    } else {
      field += ch
      fieldStarted = true
    }
  }
  if (field !== "" || record.length) {
    const hadHeader = headers !== null
    endRecord()
    if (!hadHeader && headers !== null) headerEnd = src.length
  }

  const hs = headers as string[] | null
  if (!hs || (headerEnd > HEADER_LIMIT && headerEnd !== -1))
    return { error: "The file has no header row (or its first row is longer than 256 KB)." }
  const empty = hs.indexOf("")
  if (empty >= 0)
    return {
      error: `Column ${empty + 1} in the header row has no name. Every column needs one to be mapped.`,
    }
  const seen = new Set<string>()
  for (const h of hs) {
    if (seen.has(h))
      return { error: `Two columns are both named “${h}”. Rename one so each column can be mapped.` }
    seen.add(h)
  }
  return want ? { headers: hs, firstRow, rows, sample } : { headers: hs, firstRow, rows }
}

/**
 * Whether a picked file can be read as a CSV before anything is sent, in the importer's words. Excel
 * workbooks and other binaries are caught by name and type, so nothing uploads and there's no request id.
 */
export function checkCsvFile(f: { name: string; type: string; size: number }): string | null {
  if (/\.(xlsx|xlsm|xls|ods|numbers)$/i.test(f.name) || /spreadsheetml|ms-excel|opendocument/.test(f.type))
    return `${f.name} is a spreadsheet workbook, not a CSV.`
  if (!/\.(csv|txt)$/i.test(f.name) && !/csv|plain/.test(f.type)) return `${f.name} isn’t a CSV.`
  if (f.size === 0) return `${f.name} is empty.`
  if (f.size > MAX_CSV_BYTES) return `${f.name} is ${fmtBytes(f.size)}; the limit is 50 MiB.`
  return null
}

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

export type Target = "email" | "name" | "name.first" | "name.last" | "status" | "fields" | "ignore"
export const TARGET_LABELS: Record<Target, string> = {
  email: "Email",
  name: "Name",
  "name.first": "First name",
  "name.last": "Last name",
  status: "Status",
  fields: "Custom field",
  ignore: "Ignore",
}
export type MappingRow = { column: string; target: Target; fieldKey: string }

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/** A field key from a column name: letters, digits and underscores, starting with a letter or underscore. */
export function fieldKeyFor(column: string): string {
  const k = column
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase()
    .slice(0, 64)
  if (!k) return "field"
  return /^[0-9]/.test(k) ? `_${k}`.slice(0, 64) : k
}

/**
 * A first guess at the mapping: the obvious columns by name, columns that match an existing typed field to that
 * field (by key or by its registry label), the rest ignored (the person opts each one in). Never both a name
 * and first/last.
 */
export function guessMapping(
  headers: readonly string[],
  fieldKeys: readonly string[],
  labels: Readonly<Record<string, string>> = {},
): MappingRow[] {
  const used = new Set<Target>()
  const take = (t: Target): Target | null => {
    if (used.has(t)) return null
    used.add(t)
    return t
  }
  const keys = new Map(fieldKeys.map((k) => [squash(k), k]))
  for (const [k, label] of Object.entries(labels)) if (!keys.has(squash(label))) keys.set(squash(label), k)
  const rows = headers.map((column): MappingRow => {
    const s = squash(column)
    let t: Target | null = null
    if (["email", "emailaddress", "mail", "emailaddr"].includes(s)) t = take("email")
    else if (["name", "fullname", "displayname", "contactname"].includes(s)) t = take("name")
    else if (["firstname", "first", "givenname", "forename"].includes(s)) t = take("name.first")
    else if (["lastname", "last", "surname", "familyname"].includes(s)) t = take("name.last")
    else if (["status", "subscriptionstatus", "subscribed"].includes(s)) t = take("status")
    const field = keys.get(s)
    if (!t && field) return { column, target: "fields", fieldKey: field }
    return { column, target: t ?? "ignore", fieldKey: fieldKeyFor(column) }
  })
  if (used.has("name") && (used.has("name.first") || used.has("name.last")))
    for (const r of rows) if (r.target === "name.first" || r.target === "name.last") r.target = "ignore"
  return rows
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export type MappingError = { column?: string; message: string }

/** The importer's mapping rules, checked before the round trip so the person sees them next to the column. */
export function validateMapping(rows: readonly MappingRow[]): MappingError[] {
  const errors: MappingError[] = []
  const of = (t: Target) => rows.filter((r) => r.target === t)
  const email = of("email")
  if (email.length === 0) errors.push({ message: "Map one column to Email." })
  if (email.length > 1)
    errors.push({ message: `Only one column can be Email: ${email.map((r) => r.column).join(", ")}.` })
  for (const t of ["name", "name.first", "name.last", "status"] as const) {
    const list = of(t)
    if (list.length > 1)
      errors.push({
        message: `Only one column can be ${TARGET_LABELS[t]}: ${list.map((r) => r.column).join(", ")}.`,
      })
  }
  if (of("name").length && (of("name.first").length || of("name.last").length))
    errors.push({
      message: "A name comes from one column, or from a first-name and a last-name column, not both.",
    })
  const seen = new Map<string, string>()
  for (const r of of("fields")) {
    const key = r.fieldKey.trim()
    if (!FIELD_NAME.test(key)) {
      errors.push({
        column: r.column,
        message:
          "A field name uses letters, digits and underscores, starts with a letter or underscore, 64 at most.",
      })
      continue
    }
    const other = seen.get(key)
    if (other)
      errors.push({
        column: r.column,
        message: `“${other}” already maps to ${key}. Two columns can’t share a field.`,
      })
    else seen.set(key, r.column)
  }
  if (seen.size > 50) errors.push({ message: `At most 50 custom fields; ${seen.size} are mapped.` })
  return errors
}

/** The `mapping` body for `POST /v1/imports/contacts`: every column, `fields.<key>` for custom fields. */
export function toImportMapping(rows: readonly MappingRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.map((r) => [r.column, r.target === "fields" ? `fields.${r.fieldKey.trim()}` : r.target]),
  )
}

/** The wire target for a row, as the "Sends …" hint shows it. */
export const wireTarget = (r: MappingRow) =>
  r.target === "fields" ? `fields.${r.fieldKey.trim()}` : r.target

export type FieldType = "string" | "number" | "boolean" | "date"
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  string: "text",
  number: "number",
  boolean: "yes/no",
  date: "date",
}
export const FIELD_TYPE_HINT: Record<FieldType, string> = {
  string: "Any text.",
  number: "Numbers, like 1,250 or 3.5. A cell that isn’t one rejects the row.",
  boolean: "Yes or no: yes/no, true/false, y/n or 1/0. A cell that isn’t one rejects the row.",
  date: "Dates, ISO preferred, like 2026-08-14. A cell that isn’t one rejects the row.",
}

/** A cell read as its registered type, exactly as the importer reads it; undefined when it isn't one. */
export function typedValue(type: FieldType | string | undefined, value: string): unknown {
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

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/

/**
 * What the importer would say about one cell under a mapping, or null when it fits: a missing or malformed
 * email, a status that isn't subscribed or unsubscribed, a value that doesn't parse as its field's type.
 */
export function cellIssue(
  row: Pick<MappingRow, "column" | "target" | "fieldKey">,
  type: FieldType | string | undefined,
  raw: string,
): string | null {
  const value = raw.trim()
  if (row.target === "email") {
    if (!value) return "No email."
    return EMAIL.test(value.toLowerCase()) ? null : `Not an email address: ${value.slice(0, 100)}`
  }
  if (row.target === "status") {
    const v = value.toLowerCase()
    return !v || v === "subscribed" || v === "unsubscribed"
      ? null
      : `Status must be subscribed or unsubscribed, not "${v.slice(0, 40)}".`
  }
  if (row.target === "fields" && value) {
    return typedValue(type, value) === undefined
      ? `"${row.column}" is a ${type} field; "${value.slice(0, 40)}" isn't one.`
      : null
  }
  return null
}

/** Every bad cell in the sample under a mapping: `"<sample index>:<column index>"` → the importer's message. */
export function sampleIssues(
  mapping: readonly MappingRow[],
  sample: readonly SampleRow[],
  typeOf: (key: string) => FieldType | string | undefined,
): Map<string, string> {
  const out = new Map<string, string>()
  sample.forEach((s, ri) => {
    mapping.forEach((m, ci) => {
      if (m.target === "ignore") return
      const msg = cellIssue(
        m,
        m.target === "fields" ? typeOf(m.fieldKey.trim()) : undefined,
        s.cells[ci] ?? "",
      )
      if (msg) out.set(`${ri}:${ci}`, msg)
    })
  })
  return out
}

/** The first three non-empty values of a column, for the mapping's sample line. */
export function samplesOf(sample: readonly SampleRow[], ci: number, n = 3): string[] {
  const out: string[] = []
  for (const s of sample) {
    const v = (s.cells[ci] ?? "").trim()
    if (v) out.push(v)
    if (out.length >= n) break
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Progress, rate and ETA
// ---------------------------------------------------------------------------------------------

export function fmtBytes(v: N): string {
  const b = num(v)
  if (b === null) return "—"
  if (b < 1024) return `${fmtInt(b)} B`
  if (b < 1024 * 1024) return `${fmtInt(Math.round(b / 1024))} KB`
  const mib = b / (1024 * 1024)
  return `${mib < 10 ? mib.toFixed(1) : fmtInt(Math.round(mib))} MiB`
}

/** Share of the file read, 0–100, exact to a tenth for the bar's width. Null without a size. */
export function progressPct(bytesRead: N, size: N): number | null {
  const r = num(bytesRead)
  const s = num(size)
  if (r === null || s === null || s <= 0) return null
  return Math.min(100, Math.max(0, Math.round((r / s) * 1000) / 10))
}

/** "about 30 seconds left", "about 6 minutes left", "about 2 hours left". */
export function fmtLeft(etaAt: N, now: number): string | null {
  const t = num(etaAt)
  if (t === null) return null
  const s = Math.round((t - now) / 1000)
  if (s <= 5) return "almost done"
  if (s < 60) return `about ${Math.max(10, Math.round(s / 10) * 10)} seconds left`
  const m = Math.round(s / 60)
  if (m < 60) return `about ${m} minute${m === 1 ? "" : "s"} left`
  const h = Math.round(m / 60)
  return `about ${h} hour${h === 1 ? "" : "s"} left`
}

/** "17:46 UTC". */
export function fmtUtc(v: N): string {
  const t = num(v)
  if (t === null) return "—"
  const d = new Date(t)
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`
}

export type ContactProgress = {
  bytesRead: N
  size: N
  fileSize?: N
  processed: N
  ratePerMinute: N
  etaAt: N
  startedAt: N
}

/** The line under the contact-import bar: bytes read, rows, rate, time left, when it started. */
export function contactProgressLine(p: ContactProgress, now: number): string {
  const size = num(p.size) ?? num(p.fileSize)
  const parts = [
    size === null ? `${fmtBytes(p.bytesRead)} read` : `${fmtBytes(p.bytesRead)} of ${fmtBytes(size)} read`,
  ]
  parts.push(`${fmtInt(p.processed)} rows`)
  const rate = num(p.ratePerMinute)
  if (rate !== null) parts.push(`${fmtInt(rate)} rows a minute`)
  const left = fmtLeft(p.etaAt, now)
  if (left) parts.push(left)
  if (num(p.startedAt) !== null) parts.push(`started ${fmtUtc(p.startedAt)}`)
  return parts.join(" · ")
}

export type ImportCounts = {
  rows: N
  created: N
  updated: N
  skipped: N
  invalid: N
  duplicates: N
  suppressed: N
}

/** Created (including suppressed) + updated + skipped + invalid + duplicates = rows, as the hint spells it. */
export function countsSentence(c: ImportCounts) {
  return `${fmtInt(c.created)} created (including ${fmtInt(c.suppressed)} suppressed) + ${fmtInt(c.updated)} updated + ${fmtInt(c.skipped)} skipped + ${fmtInt(c.invalid)} invalid + ${fmtInt(c.duplicates)} duplicates = ${fmtInt(c.rows)} rows.`
}

/**
 * The arithmetic line under the import tiles, as the Audience report writes it (decision 3): "1,802 created
 * (incl. 9 suppressed) + 431 updated + … = 2,418 rows". The suppressed note only when there are some.
 */
export function arithmeticLine(c: ImportCounts): string {
  const sup = num(c.suppressed) ?? 0
  return `${fmtInt(c.created)} created${sup > 0 ? ` (incl. ${fmtInt(sup)} suppressed)` : ""} + ${fmtInt(c.updated)} updated + ${fmtInt(c.skipped)} skipped + ${fmtInt(c.invalid)} invalid + ${fmtInt(c.duplicates)} duplicates = ${fmtInt(c.rows)} rows`
}

export const ERROR_CODE_LABEL: Record<string, string> = {
  missing_email: "Missing email",
  invalid_email: "Invalid email",
  invalid_value: "Invalid value",
  parse_error: "Can’t read the row",
}

export type ImportStatus = "queued" | "running" | "completed" | "failed" | "cancelled"
export const isActiveImport = (s: ImportStatus) => s === "queued" || s === "running"

/** Which of the five import steps a status is on: choose, map, options, import, report. */
export function importStep(status: ImportStatus | null): 1 | 2 | 3 | 4 | 5 {
  if (status === null) return 1
  return isActiveImport(status) ? 4 : 5
}

/** The pill an import wears in Past imports. */
export function importResult(i: { status: ImportStatus; invalid: N }): {
  cls: string
  label: string
} {
  if (i.status === "failed") return { cls: "pill-fail", label: "Failed" }
  if (i.status === "cancelled") return { cls: "pill-neutral", label: "Cancelled" }
  if (i.status === "queued") return { cls: "pill-neutral", label: "Queued" }
  if (i.status === "running") return { cls: "pill-info", label: "Running" }
  const bad = num(i.invalid) ?? 0
  return bad > 0
    ? { cls: "pill-warn", label: `${fmtInt(bad)} row${bad === 1 ? "" : "s"} invalid` }
    : { cls: "pill-pass", label: "Completed" }
}

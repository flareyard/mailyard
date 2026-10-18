/**
 * First run, as pure functions (design: screens/first-run/*, HANDOFF §1 step 7, GAPS §4). Everything the
 * checklist decides is here, so it can be tested without a browser: which steps are done (derived from live
 * data, never from a flag), which one is current, whether `/` is the checklist or the Overview, the CSV header
 * read in the browser, the column mapping and its rules (the same ones `POST /v1/imports/contacts` enforces),
 * and how progress, rate and ETA read.
 */
import { fmtInt, num } from "../lib/format.ts"

type N = number | string | null | undefined

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

export type StepId = "domain" | "enable" | "mailbox" | "test" | "imap" | "csv"
export const STEP_IDS: readonly StepId[] = ["domain", "enable", "mailbox", "test", "imap", "csv"]
export const REQUIRED_STEPS: readonly StepId[] = ["domain", "enable", "mailbox", "test"]
export const OPTIONAL_STEPS: readonly StepId[] = ["imap", "csv"]
export const isStepId = (v: unknown): v is StepId =>
  typeof v === "string" && (STEP_IDS as readonly string[]).includes(v)

export const STEP_TITLES: Record<StepId, string> = {
  domain: "Add a domain",
  enable: "Turn on mail",
  mailbox: "Create your first mailbox",
  test: "Send yourself a test",
  imap: "Bring your old mail",
  csv: "Bring your contacts",
}

export type StepStatus = "todo" | "running" | "done" | "fail" | "skipped"
export type Step = {
  id: StepId
  n: number
  title: string
  optional: boolean
  status: StepStatus
  /** What the stepper shows under the title once there's something to say (done, skipped). */
  summary: string | null
}

// Minimal shapes of the API responses, so the schema's types are assignable and tests stay small.
export type DomainCheck = {
  id: string
  status: "pass" | "warn" | "fail" | "error" | "checking"
  actual: readonly string[]
}
export type DomainLike = {
  id: string
  name: string
  receiving: boolean
  sending: boolean
  checkStatus: "pass" | "warn" | "fail" | "error" | "checking" | null
  createdAt: N
  zoneStatus?: string | null
  currentNameservers?: readonly string[] | null
  checks?: readonly DomainCheck[]
}
export type MailboxLike = {
  id: string
  address: string
  domainId: string
  kind: string
  holdsMail: boolean
  createdAt: N
}
export type Auth = {
  spf: string | null
  dkim: string | null
  dmarc: string | null
  spfDomain?: string | null
  dkimDomain?: string | null
  dmarcPolicy?: string | null
}
export type TestLike = {
  status: "sending" | "sent" | "delivered" | "received" | "failed"
  probe: boolean
  deliveryTimeMs: N
  authentication: Auth | null
  error: string | null
}
export type MessageLike = { source: string; stream: string; status: string }
export type MailImportLike = {
  status: "pending" | "running" | "paused" | "complete" | "failed" | "cancelled"
  accountedFor: boolean
  totals: { source: N; imported: N; duplicates: N; failed: N }
  createdAt: N
}
export type ContactImportLike = {
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  created: N
  updated: N
  createdAt: N
}
export type Routing = "clear" | "replaced" | "unchecked"

/**
 * The domain the checklist is about. A workspace usually has one when it runs setup; with several, the one
 * furthest along wins, and among equals the first one added.
 */
export function pickDomain<D extends DomainLike>(domains: readonly D[] | undefined): D | undefined {
  if (!domains?.length) return undefined
  const score = (d: D) =>
    d.receiving && d.sending ? (d.checkStatus === "pass" ? 3 : 2) : d.receiving || d.sending ? 1 : 0
  return [...domains].sort(
    (a, b) => score(b) - score(a) || (num(a.createdAt) ?? 0) - (num(b.createdAt) ?? 0),
  )[0]
}

/** True or false when public DNS answered with nameservers; null when there's nothing to judge. */
export function nameserversOnCloudflare(ns: readonly string[] | null | undefined): boolean | null {
  if (!ns?.length) return null
  return ns.every((n) => /\.ns\.cloudflare\.com\.?$/i.test(n.trim()))
}

/** Step 1: a domain in the workspace whose zone has reached Cloudflare. */
export function domainStatus(d: DomainLike | undefined): StepStatus {
  if (!d) return "todo"
  if (d.zoneStatus === "pending" || nameserversOnCloudflare(d.currentNameservers) === false) return "running"
  return "done"
}

/** How long after mail is turned on missing records count as "not seen yet" rather than failing. */
export const ENABLE_WATCH_MS = 10 * 60_000

export type EnablePhase = "idle" | "progress" | "fail" | "pass"

/**
 * Step 2's state. Records the resolver hasn't seen yet are waiting while the watch window runs (DNS on
 * Cloudflare usually settles within a minute); a record that's there with the wrong value, a warning (two SPF
 * records) or a lookup error fails at once, because waiting won't fix it.
 */
export function enablePhase(
  d: DomainLike | undefined,
  opts: { turnedOnAt?: number | undefined; now: number },
): EnablePhase {
  if (!d?.receiving || !d.sending) return "idle"
  const checks = d.checks ?? []
  if (!checks.length) return d.checkStatus === "pass" ? "pass" : "progress"
  if (checks.every((c) => c.status === "pass")) return "pass"
  if (
    checks.some(
      (c) => c.status === "warn" || c.status === "error" || (c.status === "fail" && c.actual.length > 0),
    )
  )
    return "fail"
  if (checks.some((c) => c.status === "checking")) return "progress"
  const watching = opts.turnedOnAt !== undefined && opts.now - opts.turnedOnAt < ENABLE_WATCH_MS
  return watching ? "progress" : "fail"
}

export type RowState = "pass" | "warn" | "fail" | "error" | "checking" | "waiting" | "idle"

/** One DNS row's look, from its check, the step's phase, and whether a recheck is in flight right now. */
export function rowState(c: DomainCheck | undefined, phase: EnablePhase, rechecking: boolean): RowState {
  if (phase === "idle" || !c) return "idle"
  if (c.status === "pass" || c.status === "warn" || c.status === "error" || c.status === "checking")
    return c.status
  if (rechecking) return "checking"
  return phase === "progress" && c.actual.length === 0 ? "waiting" : "fail"
}

export function checksPassing(checks: readonly DomainCheck[] | undefined) {
  const list = checks ?? []
  return { passing: list.filter((c) => c.status === "pass").length, total: list.length }
}

/** The mailbox the later steps use: the first one on the setup domain that holds mail. */
export function pickMailbox<M extends MailboxLike>(
  mailboxes: readonly M[] | undefined,
  domainId?: string,
): M | undefined {
  const holding = (mailboxes ?? []).filter((m) => m.holdsMail && m.kind !== "alias")
  const onDomain = domainId ? holding.filter((m) => m.domainId === domainId) : []
  const pool = onDomain.length ? onDomain : holding
  return [...pool].sort((a, b) => (num(a.createdAt) ?? 0) - (num(b.createdAt) ?? 0))[0]
}

export const authPasses = (a: Auth | null | undefined) =>
  Boolean(a && a.spf === "pass" && a.dkim === "pass" && a.dmarc === "pass")

export type TestVerdict = "waiting" | "pass" | "auth-fail" | "delivered" | "failed"

/** A test send's outcome. Received at the probe passes only when SPF, DKIM and DMARC all pass. */
export function testVerdict(t: TestLike): TestVerdict {
  if (t.status === "failed") return "failed"
  if (t.status === "delivered") return "delivered"
  if (t.status === "received") return !t.authentication || authPasses(t.authentication) ? "pass" : "auth-fail"
  return "waiting"
}

export const isFinalTest = (t: TestLike) => testVerdict(t) !== "waiting"

const GOOD_MESSAGE = new Set(["sent", "delivered"])

/**
 * Step 4. The test this browser sent is the authority when there is one; otherwise a test-stream message that
 * went out, or any delivered mail at all (a workspace already sending doesn't need to prove it can).
 */
export function testStatus(
  last: TestLike | undefined,
  testMessages: readonly MessageLike[],
  delivered: readonly MessageLike[],
): StepStatus {
  if (last) {
    const v = testVerdict(last)
    return v === "waiting" ? "running" : v === "pass" || v === "delivered" ? "done" : "fail"
  }
  const sentTest = testMessages.some(
    (m) => (m.source === "test" || m.stream === "test") && GOOD_MESSAGE.has(m.status),
  )
  const anyDelivered = delivered.some((m) => m.status === "delivered")
  return sentTest || anyDelivered ? "done" : "todo"
}

export function testSummary(last: TestLike | undefined): string {
  if (!last) return "A test went out"
  const ms = num(last.deliveryTimeMs)
  if (testVerdict(last) === "delivered") return ms === null ? "Delivered" : `Delivered in ${fmtInt(ms)} ms`
  if (ms === null) return "Arrived · SPF, DKIM, DMARC pass"
  return `Arrived in ${fmtInt(ms)} ms · SPF, DKIM, DMARC pass`
}

export function latest<T extends { createdAt: N }>(list: readonly T[] | undefined): T | undefined {
  return [...(list ?? [])].sort((a, b) => (num(b.createdAt) ?? 0) - (num(a.createdAt) ?? 0))[0]
}

export function imapStatus(imp: MailImportLike | undefined, skipped: boolean): StepStatus {
  if (imp?.status === "complete") return "done"
  if (imp && (imp.status === "running" || imp.status === "pending" || imp.status === "paused"))
    return "running"
  if (imp?.status === "failed") return "fail"
  return skipped ? "skipped" : "todo"
}

export function csvStatus(imp: ContactImportLike | undefined, skipped: boolean): StepStatus {
  if (imp?.status === "completed") return "done"
  if (imp && (imp.status === "queued" || imp.status === "running")) return "running"
  if (imp?.status === "failed") return "fail"
  return skipped ? "skipped" : "todo"
}

export const ROUTING_SUMMARY: Record<Routing, string> = {
  unchecked: "routing not checked",
  clear: "routed to Mailyard",
  replaced: "routing rule replaced",
}

export type SetupFacts = {
  domain: DomainLike | undefined
  turnedOnAt?: number | undefined
  now: number
  mailbox: MailboxLike | undefined
  mailboxRouting?: Routing | undefined
  lastTest?: TestLike | undefined
  testMessages: readonly MessageLike[]
  delivered: readonly MessageLike[]
  mailImport?: MailImportLike | undefined
  contactImport?: ContactImportLike | undefined
  skipped: { imap?: boolean; csv?: boolean }
}

/** Every step's status and summary, from live data. */
export function deriveSteps(f: SetupFacts): Step[] {
  const status: Record<StepId, StepStatus> = {
    domain: domainStatus(f.domain),
    enable: (() => {
      const p = enablePhase(f.domain, { turnedOnAt: f.turnedOnAt, now: f.now })
      return p === "idle" ? "todo" : p === "progress" ? "running" : p === "fail" ? "fail" : "done"
    })(),
    mailbox: f.mailbox ? "done" : "todo",
    test: testStatus(f.lastTest, f.testMessages, f.delivered),
    imap: imapStatus(f.mailImport, Boolean(f.skipped.imap)),
    csv: csvStatus(f.contactImport, Boolean(f.skipped.csv)),
  }
  const { passing, total } = checksPassing(f.domain?.checks)
  const summary: Record<StepId, string | null> = {
    domain: f.domain?.name ?? null,
    enable: total ? `${passing} of ${total} records passing` : "Records passing",
    mailbox: f.mailbox
      ? f.mailboxRouting
        ? `${f.mailbox.address} · ${ROUTING_SUMMARY[f.mailboxRouting]}`
        : f.mailbox.address
      : null,
    test: testSummary(f.lastTest),
    imap: f.mailImport
      ? `${fmtInt(f.mailImport.accountedFor ? f.mailImport.totals.source : f.mailImport.totals.imported)} messages copied`
      : null,
    csv: f.contactImport
      ? `${fmtInt(f.contactImport.created)} added · ${fmtInt(f.contactImport.updated)} updated`
      : null,
  }
  return STEP_IDS.map((id, i) => ({
    id,
    n: i + 1,
    title: STEP_TITLES[id],
    optional: OPTIONAL_STEPS.includes(id),
    status: status[id],
    summary: status[id] === "done" ? summary[id] : status[id] === "skipped" ? "Skipped" : null,
  }))
}

export const requiredDone = (steps: readonly Step[]) =>
  steps.filter((s) => !s.optional).every((s) => s.status === "done")

export const doneCount = (steps: readonly Step[]) => steps.filter((s) => s.status === "done").length

/** Where the checklist opens: the first required step not done, then the first optional one left, then none. */
export function currentStep(steps: readonly Step[]): StepId | null {
  const req = steps.find((s) => !s.optional && s.status !== "done")
  if (req) return req.id
  const opt = steps.find((s) => s.optional && s.status !== "done" && s.status !== "skipped")
  return opt?.id ?? null
}

/** The stepper's second line for a step, as the designs word it. */
export function stepSub(s: Step, isCurrent: boolean): string {
  if (s.status === "done" || s.status === "skipped")
    return s.summary ?? (s.status === "done" ? "Done" : "Skipped")
  if (s.status === "running") return "In progress"
  if (s.status === "fail") return "Needs a fix"
  return isCurrent ? "Not started" : "Up next"
}

/**
 * Whether `/` shows the checklist. It's the checklist until the four required steps pass; a setup started in
 * this browser stays open until its hand-over is acknowledged, so the optional steps get their turn; and
 * `?setup=1` opens it on purpose. A workspace already set up opens straight on the Overview.
 */
export function showChecklist(o: {
  requiredDone: boolean
  started: boolean
  handedOver: boolean
  forced: boolean
}) {
  return o.forced || !o.requiredDone || (o.started && !o.handedOver)
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** A typed domain, normalised the way people paste them: a URL, an address, a trailing dot. */
export function normalizeDomain(input: string): { name: string } | { error: string } {
  let v = input.trim().toLowerCase()
  if (!v) return { error: "Type the domain your mail will live on, like coursified.app." }
  v = v
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "")
  if (v.includes("@"))
    return {
      error: `That’s an address. Type the domain itself: ${v.slice(v.lastIndexOf("@") + 1) || "the part after @"}.`,
    }
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(v))
    return { error: `“${input.trim()}” isn’t a domain name. It should look like coursified.app.` }
  return { name: v }
}

/** The part before @ for a new mailbox. */
export function validateLocalPart(v: string): string | null {
  const s = v.trim()
  if (!s) return "Type the part before the @, like hello."
  if (s.includes("@")) return "Only the part before the @: the domain is added for you."
  if (s.length > 64) return "The part before the @ can be 64 characters at most."
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(s))
    return "Use letters, digits, dots, hyphens or underscores, with no spaces."
  return null
}

export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

/** What a DMARC policy means for the test result, in the designs' words. */
export function dmarcPolicyCopy(policy: string | null | undefined): string | null {
  if (!policy) return null
  if (policy === "reject") return "mail that fails DMARC is refused. The strongest setting."
  if (policy === "quarantine") return "mail that fails DMARC goes to spam."
  if (policy === "none") return "mail that fails DMARC is delivered anyway, so nobody blocks a forgery."
  return null
}

// ---------------------------------------------------------------------------------------------
// IMAP folders
// ---------------------------------------------------------------------------------------------

export type ProbeFolder = {
  name: string
  messages: N
  folder: string | null
  label: string | null
  skipped: boolean
}

/** Folders ticked to start with: the inbox, sent mail and the archive; spam, trash and labels are opt-in. */
export function defaultFolderSelection(folders: readonly ProbeFolder[]): string[] {
  return folders
    .filter(
      (f) =>
        !f.skipped &&
        f.label === null &&
        (f.folder === "inbox" || f.folder === "sent" || f.folder === "archive"),
    )
    .map((f) => f.name)
}

export function selectedMessages(folders: readonly ProbeFolder[], selected: readonly string[]): number {
  return folders
    .filter((f) => !f.skipped && selected.includes(f.name))
    .reduce((n, f) => n + (num(f.messages) ?? 0), 0)
}

const FOLDER_NAMES: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  archive: "Archive",
  spam: "Spam",
  trash: "Trash",
  drafts: "Drafts",
}
export function landsIn(f: Pick<ProbeFolder, "folder" | "label">): string {
  const base = f.folder ? (FOLDER_NAMES[f.folder] ?? f.folder) : "—"
  return f.label ? `${base} · label “${f.label}”` : base
}

// ---------------------------------------------------------------------------------------------
// Contacts CSV
// ---------------------------------------------------------------------------------------------

export const MAX_CSV_BYTES = 50 * 1024 * 1024
const HEADER_LIMIT = 256 * 1024

export type CsvPreview = { headers: string[]; firstRow: string[]; rows: number }

/**
 * Reads the header, the first data row and the number of data rows, the way the importer does (RFC 4180:
 * quoted fields may hold commas, "" and line breaks; CRLF or LF; blank lines skipped; a BOM dropped; headers
 * trimmed). Returns the importer's own wording when the file can't be imported.
 */
export function previewCsv(text: string): CsvPreview | { error: string } {
  const src = text.startsWith("﻿") ? text.slice(1) : text
  let headers: string[] | null = null
  let firstRow: string[] = []
  let rows = 0
  let field = ""
  let record: string[] = []
  let quoted = false
  let fieldStarted = false
  let headerEnd = -1

  const endRecord = () => {
    record.push(field)
    field = ""
    fieldStarted = false
    const blank = record.length === 1 && record[0] === ""
    if (!blank) {
      if (!headers) headers = record.map((h) => h.trim())
      else {
        if (rows === 0) firstRow = record
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
      } else field += ch
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
  return { headers: hs, firstRow, rows }
}

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
 * field, the rest ignored (the person opts each one in). Never both a name and first/last.
 */
export function guessMapping(headers: readonly string[], fieldKeys: readonly string[]): MappingRow[] {
  const used = new Set<Target>()
  const take = (t: Target): Target | null => {
    if (used.has(t)) return null
    used.add(t)
    return t
  }
  const keys = new Map(fieldKeys.map((k) => [squash(k), k]))
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

/** "780 a minute, done in about 6 minutes (17:54 UTC)" for a mail import. */
export function mailRateLine(ratePerMinute: N, etaAt: N, now: number): string | null {
  const rate = num(ratePerMinute)
  if (rate === null) return null
  const left = fmtLeft(etaAt, now)
  if (!left) return `${fmtInt(rate)} a minute`
  const done = left === "almost done" ? "almost done" : `done in ${left.replace(/ left$/, "")}`
  return `${fmtInt(rate)} a minute, ${done} (${fmtUtc(etaAt)})`
}

/** Created (including suppressed) + updated + skipped + invalid + duplicates = rows, as the hint spells it. */
export function countsSentence(c: {
  rows: N
  created: N
  updated: N
  skipped: N
  invalid: N
  duplicates: N
  suppressed: N
}) {
  return `${fmtInt(c.created)} created (including ${fmtInt(c.suppressed)} suppressed) + ${fmtInt(c.updated)} updated + ${fmtInt(c.skipped)} skipped + ${fmtInt(c.invalid)} invalid + ${fmtInt(c.duplicates)} duplicates = ${fmtInt(c.rows)} rows.`
}

export const ERROR_CODE_LABEL: Record<string, string> = {
  missing_email: "Missing email",
  invalid_email: "Invalid email",
  invalid_value: "Invalid value",
  parse_error: "Can’t read the row",
}

// ---------------------------------------------------------------------------------------------
// What this browser remembers (a per-viewer convenience; parsed defensively)
// ---------------------------------------------------------------------------------------------

export type SetupMemory = {
  started?: boolean
  handedOver?: boolean
  skipped?: { imap?: boolean; csv?: boolean }
  lastTestId?: string
  turnedOnAt?: number
  mailboxRouting?: { mailboxId: string; routing: Routing }
}

export function parseSetupMemory(raw: string | null): SetupMemory {
  if (!raw) return {}
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!v || typeof v !== "object") return {}
  const o = v as Record<string, unknown>
  const out: SetupMemory = {}
  if (o.started === true) out.started = true
  if (o.handedOver === true) out.handedOver = true
  if (o.skipped && typeof o.skipped === "object") {
    const s = o.skipped as Record<string, unknown>
    out.skipped = { ...(s.imap === true ? { imap: true } : {}), ...(s.csv === true ? { csv: true } : {}) }
  }
  if (typeof o.lastTestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(o.lastTestId))
    out.lastTestId = o.lastTestId
  if (typeof o.turnedOnAt === "number" && Number.isFinite(o.turnedOnAt)) out.turnedOnAt = o.turnedOnAt
  const r = o.mailboxRouting as Record<string, unknown> | undefined
  if (
    r &&
    typeof r.mailboxId === "string" &&
    (r.routing === "clear" || r.routing === "replaced" || r.routing === "unchecked")
  )
    out.mailboxRouting = { mailboxId: r.mailboxId, routing: r.routing }
  return out
}

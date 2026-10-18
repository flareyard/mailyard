/**
 * The contacts list as pure functions (design: contacts*.html; HANDOFF-audience §3, §6 "Contacts filters";
 * GAPS-audience A1). The app's URL mirrors `GET /v1/contacts` one to one: `q`, `status` and `engagement` as one
 * comma list each, `topicId`, `segmentId`, `field` and `event` repeated, `sort`, `cursor`; `cols` is the app's
 * own. A chip is one value; removing it removes only that value. `field=key:op[:value]` and
 * `event=[!]name[:days]` are written and read exactly as the API parses them (`src/domain/contactFilters.ts`).
 */

export const STATUSES = [
  "subscribed",
  "unconfirmed",
  "unsubscribed",
  "bounced",
  "complained",
  "suppressed",
] as const
export type Status = (typeof STATUSES)[number]
export const ENGAGEMENTS = ["active", "cooling", "dormant"] as const
export type Engagement = (typeof ENGAGEMENTS)[number]
export const SORTS = [
  "-lastActivityAt",
  "lastActivityAt",
  "-createdAt",
  "createdAt",
  "email",
  "-email",
] as const
export type Sort = (typeof SORTS)[number]
export const DEFAULT_SORT: Sort = "-lastActivityAt"

export const FIELD_OPS = [
  "eq",
  "neq",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "missing",
] as const
export type FieldOp = (typeof FIELD_OPS)[number]

/** How each op reads in a chip and in the filter sheet. */
export const OP_WORDS: Record<FieldOp, string> = {
  eq: "is",
  neq: "isn’t",
  contains: "contains",
  notContains: "doesn’t contain",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: "more than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  exists: "is set",
  missing: "is empty",
}
export const needsValue = (op: FieldOp) => op !== "exists" && op !== "missing"

export type ContactsSearch = {
  q?: string
  status?: string
  engagement?: string
  topicId?: string
  segmentId?: string
  field?: string[]
  event?: string[]
  sort?: Sort
  cols?: string
  cursor?: string
  /** Which sheet is open: the filter sheet or the export sheet. */
  sheet?: "filter" | "export" | "new"
  /** A bulk job being watched (`bulk_…`), so its progress stays on the list across reloads. */
  job?: string
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined)
const strs = (v: unknown): string[] | undefined => {
  const a = (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).filter(
    (x): x is string => typeof x === "string" && x !== "",
  )
  return a.length ? a : undefined
}

/** Reads the route's search params, keeping only what the list understands. */
export function parseContactsSearch(s: Record<string, unknown>): ContactsSearch {
  const out: ContactsSearch = {}
  const q = str(s.q)
  if (q) out.q = q
  for (const k of ["status", "engagement", "topicId", "segmentId", "cols", "cursor", "job"] as const) {
    const v = str(s[k])
    if (v) out[k] = v
  }
  const field = strs(s.field)
  if (field) out.field = field
  const event = strs(s.event)
  if (event) out.event = event
  if (typeof s.sort === "string" && (SORTS as readonly string[]).includes(s.sort)) out.sort = s.sort as Sort
  if (s.sheet === "filter" || s.sheet === "export" || s.sheet === "new") out.sheet = s.sheet
  return out
}

export const splitList = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

/** The `GET /v1/contacts` query for a view (without `limit`). */
export function apiQuery(s: ContactsSearch) {
  return {
    ...(s.q ? { q: s.q } : {}),
    ...(s.status ? { status: s.status } : {}),
    ...(s.engagement ? { engagement: s.engagement } : {}),
    ...(s.topicId ? { topicId: s.topicId } : {}),
    ...(s.segmentId ? { segmentId: s.segmentId } : {}),
    ...(s.field?.length ? { field: s.field } : {}),
    ...(s.event?.length ? { event: s.event } : {}),
    sort: s.sort ?? DEFAULT_SORT,
    ...(s.cursor ? { cursor: s.cursor } : {}),
  }
}

/** The filter part of a view: what bulk actions and exports take (no sort, cursor or columns). */
export function viewFilter(s: ContactsSearch) {
  return {
    ...(s.q ? { q: s.q } : {}),
    ...(s.status ? { status: s.status } : {}),
    ...(s.engagement ? { engagement: s.engagement } : {}),
    ...(s.topicId ? { topicId: s.topicId } : {}),
    ...(s.segmentId ? { segmentId: s.segmentId } : {}),
    ...(s.field?.length ? { field: s.field } : {}),
    ...(s.event?.length ? { event: s.event } : {}),
  }
}

export const hasFilters = (s: ContactsSearch) =>
  Boolean(s.q || s.status || s.engagement || s.topicId || s.segmentId || s.field?.length || s.event?.length)

// ---------------------------------------------------------------------------------------------
// field= and event=, read the way the API reads them
// ---------------------------------------------------------------------------------------------

export type FieldFilter = { key: string; op: FieldOp; value?: string }

/** `key:op[:value]`; the value is everything after the second colon. The API's own error words otherwise. */
export function parseFieldFilter(raw: string): FieldFilter | { error: string } {
  const first = raw.indexOf(":")
  const second = first < 0 ? -1 : raw.indexOf(":", first + 1)
  const key = (first < 0 ? raw : raw.slice(0, first)).trim()
  const op = (first < 0 ? "" : second < 0 ? raw.slice(first + 1) : raw.slice(first + 1, second)).trim()
  const value = second < 0 ? undefined : raw.slice(second + 1)
  if (!key || !(FIELD_OPS as readonly string[]).includes(op))
    return { error: `Write a field filter as key:op:value, with op one of ${FIELD_OPS.join(", ")}.` }
  if (needsValue(op as FieldOp) && value === undefined)
    return { error: `The ${op} filter on ${key} needs a value.` }
  return { key, op: op as FieldOp, ...(needsValue(op as FieldOp) && value !== undefined ? { value } : {}) }
}

export function writeFieldFilter(f: FieldFilter): string {
  return needsValue(f.op) ? `${f.key}:${f.op}:${f.value ?? ""}` : `${f.key}:${f.op}`
}

export type EventFilter = { name: string; did: boolean; days?: number }

export function parseEventFilter(raw: string): EventFilter | { error: string } {
  const negated = raw.startsWith("!")
  const body = negated ? raw.slice(1) : raw
  const at = body.lastIndexOf(":")
  const days = at >= 0 && /^\d+$/.test(body.slice(at + 1)) ? Number(body.slice(at + 1)) : undefined
  const name = (days === undefined ? body : body.slice(0, at)).trim()
  if (!name) return { error: "Write an event filter as [!]name[:days]." }
  if (days !== undefined && (days < 1 || days > 3650)) return { error: "Days are 1 to 3650." }
  return { name, did: !negated, ...(days !== undefined ? { days } : {}) }
}

export function writeEventFilter(e: EventFilter): string {
  return `${e.did ? "" : "!"}${e.name}${e.days !== undefined ? `:${e.days}` : ""}`
}

// ---------------------------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------------------------

export type ChipKey = "status" | "engagement" | "topicId" | "segmentId" | "field" | "event"
export type Chip = {
  key: ChipKey
  /** The raw value this chip carries in the URL (one of `field`'s values, the whole comma list for status). */
  value: string
  /** “Status is any of”, “Plan is”, “Did”. */
  label: string
  /** The bold part: “subscribed, unconfirmed”, “pro”, “lesson_completed in 30 d”. */
  text: string
  /** The query parameter as it appears in the link, for the chip's title. */
  param: string
  multi: boolean
  /** The client-side reading of a field/event value the API would refuse, in the API's words. */
  invalid: string | null
}

export type Names = {
  topic: (id: string) => string
  segment: (id: string) => string
  /** A field's label (the registry label, or the key itself while it isn't named). */
  field: (key: string) => string
}

export function chipsOf(s: ContactsSearch, names: Names): Chip[] {
  const chips: Chip[] = []
  if (s.segmentId)
    chips.push({
      key: "segmentId",
      value: s.segmentId,
      label: "In segment",
      text: names.segment(s.segmentId),
      param: `segmentId=${s.segmentId}`,
      multi: false,
      invalid: null,
    })
  for (const k of ["status", "engagement"] as const) {
    const vals = splitList(s[k])
    if (!vals.length) continue
    chips.push({
      key: k,
      value: s[k] as string,
      label: `${k === "status" ? "Status" : "Engagement"} is${vals.length > 1 ? " any of" : ""}`,
      text: vals.join(", "),
      param: `${k}=${vals.join(",")}`,
      multi: true,
      invalid: null,
    })
  }
  if (s.topicId)
    chips.push({
      key: "topicId",
      value: s.topicId,
      label: "Topic is",
      text: names.topic(s.topicId),
      param: `topicId=${s.topicId}`,
      multi: false,
      invalid: null,
    })
  for (const raw of s.field ?? []) {
    const f = parseFieldFilter(raw)
    if ("error" in f) {
      const loose = raw.split(":")
      const op = loose[1] as FieldOp | undefined
      chips.push({
        key: "field",
        value: raw,
        label: `${names.field(loose[0] ?? raw)}${op && OP_WORDS[op] ? ` ${OP_WORDS[op]}` : ""}`,
        text: "no value",
        param: `field=${raw}`,
        multi: false,
        invalid: f.error,
      })
      continue
    }
    chips.push({
      key: "field",
      value: raw,
      label: `${names.field(f.key)} ${OP_WORDS[f.op]}`,
      text: needsValue(f.op) ? f.value || "empty" : "",
      param: `field=${raw}`,
      multi: false,
      invalid: null,
    })
  }
  for (const raw of s.event ?? []) {
    const e = parseEventFilter(raw)
    chips.push(
      "error" in e
        ? {
            key: "event",
            value: raw,
            label: "Event",
            text: raw,
            param: `event=${raw}`,
            multi: false,
            invalid: e.error,
          }
        : {
            key: "event",
            value: raw,
            label: e.did ? "Did" : "Didn’t",
            text: `${e.name} ${e.days !== undefined ? `in ${e.days} d` : "ever"}`,
            param: `event=${raw}`,
            multi: false,
            invalid: null,
          },
    )
  }
  return chips
}

/** The view without one chip: a multi chip clears its whole list; a field or event chip drops only its value. */
export function withoutChip(s: ContactsSearch, chip: Pick<Chip, "key" | "value">): ContactsSearch {
  const next: ContactsSearch = { ...s }
  delete next.cursor
  if (chip.key === "field" || chip.key === "event") {
    const left = (s[chip.key] ?? []).filter((v) => v !== chip.value)
    if (left.length) next[chip.key] = left
    else delete next[chip.key]
  } else delete next[chip.key]
  return next
}

/** The view with one multi-value chip set to exactly these values (in the canonical order), or cleared. */
export function withList(
  s: ContactsSearch,
  key: "status" | "engagement",
  values: readonly string[],
): ContactsSearch {
  const order = (key === "status" ? STATUSES : ENGAGEMENTS) as readonly string[]
  const sorted = order.filter((v) => values.includes(v))
  const next: ContactsSearch = { ...s }
  delete next.cursor
  if (sorted.length) next[key] = sorted.join(",")
  else delete next[key]
  return next
}

/** Adds a field or event filter, once. */
export function withAdded(s: ContactsSearch, key: "field" | "event", value: string): ContactsSearch {
  const list = s[key] ?? []
  const next: ContactsSearch = { ...s, [key]: list.includes(value) ? list : [...list, value] }
  delete next.cursor
  return next
}

/** Which chips a 400 marks: the locally invalid ones of the kind its `field` names, else every one of that kind. */
export function invalidChips(chips: readonly Chip[], apiField: string | null): Set<string> {
  const marked = new Set(chips.filter((c) => c.invalid).map((c) => `${c.key}:${c.value}`))
  if (apiField && !marked.size) {
    for (const c of chips) if (c.key === apiField) marked.add(`${c.key}:${c.value}`)
  }
  return marked
}

/** The view as a sentence, for sheet titles: “status is subscribed, topic is Product updates, plan is pro”. */
export function describeView(s: ContactsSearch, names: Names): string {
  const parts = chipsOf(s, names).map((c) => {
    if (c.key === "segmentId") return `in ${c.text}`
    if (c.key === "event") return `${c.label.toLowerCase()} ${c.text.replace(/ in (\d+) d$/, " in $1 days")}`
    return `${c.label.toLowerCase()} ${c.text}`.trim()
  })
  if (s.q) parts.unshift(`matching “${s.q}”`)
  return parts.length ? parts.join(", ") : "every contact"
}

// ---------------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------------

export const BUILTIN_COLUMNS = [
  "status",
  "topics",
  "engagement",
  "lastActivityAt",
  "lastOpenedAt",
  "createdAt",
  "lastClickedAt",
] as const
export type BuiltinColumn = (typeof BUILTIN_COLUMNS)[number]
export const COLUMN_LABEL: Record<BuiltinColumn, string> = {
  status: "Status",
  topics: "Topics",
  engagement: "Engagement",
  lastActivityAt: "Last activity",
  lastOpenedAt: "Last opened",
  createdAt: "Created",
  lastClickedAt: "Last clicked",
}
export const DEFAULT_COLUMNS: readonly string[] = [
  "status",
  "topics",
  "engagement",
  "lastActivityAt",
  "lastOpenedAt",
  "createdAt",
]

/**
 * The columns a view shows, in order: `cols` is a comma list of built-in column ids and `f.<key>` custom fields.
 * Without `cols`, the defaults; unknown ids are dropped.
 */
export function columnsOf(cols: string | undefined, fieldKeys: readonly string[]): string[] {
  if (!cols) return [...DEFAULT_COLUMNS]
  return splitList(cols).filter(
    (c) =>
      (BUILTIN_COLUMNS as readonly string[]).includes(c) ||
      (c.startsWith("f.") && fieldKeys.includes(c.slice(2))),
  )
}

/** `cols` for a column set: undefined (left out of the URL) when it's the default set. */
export function colsParam(columns: readonly string[]): string | undefined {
  const same = columns.length === DEFAULT_COLUMNS.length && columns.every((c, i) => c === DEFAULT_COLUMNS[i])
  return same ? undefined : columns.join(",")
}

export function toggleColumn(columns: readonly string[], id: string, on: boolean): string[] {
  if (on) return columns.includes(id) ? [...columns] : [...columns, id]
  return columns.filter((c) => c !== id)
}

export function moveColumn(columns: readonly string[], id: string, by: -1 | 1): string[] {
  const i = columns.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= columns.length) return [...columns]
  const out = [...columns]
  ;[out[i], out[j]] = [out[j] as string, out[i] as string]
  return out
}

/** The sort a column header toggles to: descending first, then ascending. Only sortable columns sort. */
export const SORTABLE: Partial<Record<string, { asc: Sort; desc: Sort }>> = {
  contact: { asc: "email", desc: "-email" },
  lastActivityAt: { asc: "lastActivityAt", desc: "-lastActivityAt" },
  createdAt: { asc: "createdAt", desc: "-createdAt" },
}

export function nextSort(current: Sort, column: string): Sort | null {
  const s = SORTABLE[column]
  if (!s) return null
  if (column === "contact") return current === s.asc ? s.desc : s.asc
  return current === s.desc ? s.asc : s.desc
}

export function ariaSort(current: Sort, column: string): "ascending" | "descending" | undefined {
  const s = SORTABLE[column]
  if (!s) return undefined
  return current === s.asc ? "ascending" : current === s.desc ? "descending" : undefined
}

export const SORT_WORDS: Record<Sort, string> = {
  "-lastActivityAt": "last activity",
  lastActivityAt: "last activity, oldest first",
  "-createdAt": "newest",
  createdAt: "oldest",
  email: "email, A to Z",
  "-email": "email, Z to A",
}

// ---------------------------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------------------------

/** Ids cap at 1,000 a request (“At most 1000 contacts per request.”), so select-all always sends the filter. */
export const MAX_BULK_IDS = 1000

export type BulkAction =
  | { action: "addTopic"; topicId: string }
  | { action: "removeTopic"; topicId: string }
  | { action: "setStatus"; status: "subscribed" | "unsubscribed" }
  | { action: "delete" }

export type BulkTarget = { kind: "ids"; ids: string[] } | { kind: "filter"; search: ContactsSearch }

export function bulkBody(target: BulkTarget, action: BulkAction) {
  return target.kind === "ids" ? { ids: target.ids, action } : { filter: viewFilter(target.search), action }
}

/** “Add 3 contacts to a topic”, “Unsubscribe all 4,486”. */
export function bulkVerb(
  a: BulkAction["action"] | "setStatus:subscribed" | "setStatus:unsubscribed",
): string {
  switch (a) {
    case "addTopic":
      return "Add to topic"
    case "removeTopic":
      return "Remove from topic"
    case "setStatus":
    case "setStatus:unsubscribed":
      return "Unsubscribe"
    case "setStatus:subscribed":
      return "Resubscribe"
    case "delete":
      return "Delete"
  }
}

/** What a finished bulk action says: “Added 2 of 3 to Live sessions”. */
export function bulkDoneTitle(action: BulkAction, updated: number, of: number, topic?: string): string {
  const n = `${updated.toLocaleString("en")} of ${of.toLocaleString("en")}`
  switch (action.action) {
    case "addTopic":
      return `Added ${n} to ${topic ?? "the topic"}`
    case "removeTopic":
      return `Removed ${n} from ${topic ?? "the topic"}`
    case "setStatus":
      return `${action.status === "unsubscribed" ? "Unsubscribed" : "Resubscribed"} ${n}`
    case "delete":
      return `Deleted ${n}`
  }
}

/** What a running job says: “Adding to Live sessions”. */
export function bulkDoing(action: BulkAction | null, topic?: string): string {
  if (!action) return "Working"
  switch (action.action) {
    case "addTopic":
      return `Adding to ${topic ?? "the topic"}`
    case "removeTopic":
      return `Removing from ${topic ?? "the topic"}`
    case "setStatus":
      return action.status === "unsubscribed" ? "Unsubscribing" : "Resubscribing"
    case "delete":
      return "Deleting"
  }
}

/** A job's stored action, read defensively (the schema types it as an open record). */
export function readAction(v: unknown): BulkAction | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if ((o.action === "addTopic" || o.action === "removeTopic") && typeof o.topicId === "string")
    return { action: o.action, topicId: o.topicId }
  if (o.action === "setStatus" && (o.status === "subscribed" || o.status === "unsubscribed"))
    return { action: "setStatus", status: o.status }
  if (o.action === "delete") return { action: "delete" }
  return null
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export const ALWAYS_EXPORTED = [
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
]

/**
 * The export request's filter. The export takes one status and one engagement (its filter is single-valued,
 * unlike the list's comma lists), so a view with several of either can't be exported as it is: null, with why.
 */
export function exportFilter(
  s: ContactsSearch,
): { filter: ReturnType<typeof viewFilter> } | { refused: string } {
  for (const k of ["status", "engagement"] as const) {
    if (splitList(s[k]).length > 1)
      return {
        refused: `An export takes one ${k} at a time, and this view has ${splitList(s[k]).length}. Pick one ${k}, or save the view as a segment and export that (HAL-3504).`,
      }
  }
  return { filter: viewFilter(s) }
}

/** A view with any key possibly set to undefined (cleared); `clean` drops those before it goes in the URL. */
export type SearchPatch = { [K in keyof ContactsSearch]?: ContactsSearch[K] | undefined }

export function clean<T extends Record<string, unknown>>(s: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== "")) as never
}

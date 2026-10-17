import { FOLDERS, type Folder } from "./types.ts"

/** Wraps a match in search results. Control characters, so the UI can escape the text, then mark it. */
export const HIGHLIGHT_START = "\u0002"
export const HIGHLIGHT_END = "\u0003"

/** FTS5 columns, in table order, and their bm25 weights: a subject match outranks a body match. */
export const SEARCH_COLUMNS = ["subject", "sender", "recipients", "body"] as const
export const SEARCH_WEIGHTS = [10, 5, 2, 1] as const

const COLUMN_OPERATORS: Record<string, (typeof SEARCH_COLUMNS)[number]> = {
  from: "sender",
  to: "recipients",
  cc: "recipients",
  subject: "subject",
  body: "body",
}

export interface SearchFilters {
  readonly folder: Folder | null
  readonly labelName: string | null
  readonly unread: boolean
  readonly starred: boolean
  readonly hasAttachment: boolean
  /** received_at bounds from before: and after: (UTC days): after is inclusive, before exclusive. */
  readonly before: number | null
  readonly after: number | null
}

/** What the query was understood as, for the search bar to show (HAL-3406). */
export interface SearchUnderstanding {
  readonly operators: ReadonlyArray<{ readonly op: string; readonly value: string }>
  readonly terms: ReadonlyArray<string>
  /** Operators Mailyard doesn't know: searched for as plain words instead, and said so. */
  readonly unsupported: ReadonlyArray<{ readonly op: string; readonly value: string }>
}

export interface ParsedSearch {
  /** An FTS5 MATCH expression, or null when the query is only filters. */
  readonly match: string | null
  readonly filters: SearchFilters
  readonly parsed: SearchUnderstanding
}

/** YYYY-MM-DD or YYYY/MM/DD, as midnight UTC; null when it isn't a date. */
const dayOf = (value: string): number | null => {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(t) ? t : null
}

/** Words as the unicode61 tokenizer sees them. */
const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? []

const quote = (word: string) => `"${word.replace(/"/g, '""')}"`

/**
 * Turns what a person types into an FTS5 expression, so no input can be a syntax error or an
 * injection. Words are prefix matches ("ada" finds "Adalyn"); "quoted text" is an exact phrase;
 * from:, to:, cc:, subject: and body: restrict a term to a column; in:, label:, is:unread,
 * is:starred and has:attachment become filters. Everything else is ANDed together.
 */
export const parseSearch = (input: string): ParsedSearch => {
  const terms: Array<string> = []
  const filters = {
    folder: null as Folder | null,
    labelName: null as string | null,
    unread: false,
    starred: false,
    hasAttachment: false,
    before: null as number | null,
    after: null as number | null,
  }
  const operators: Array<{ op: string; value: string }> = []
  const plain: Array<string> = []
  const unsupported: Array<{ op: string; value: string }> = []
  const pattern = /([a-z]+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/giu
  for (const match of input.matchAll(pattern)) {
    const [, operator, quotedValue, bareValue, phrase, bare] = match
    if (operator) {
      const op = operator.toLowerCase()
      const value = quotedValue ?? bareValue ?? ""
      const lower = value.toLowerCase()
      if (op === "in" && (FOLDERS as ReadonlyArray<string>).includes(lower)) {
        filters.folder = lower as Folder
        operators.push({ op, value: lower })
        continue
      }
      if (op === "label") {
        filters.labelName = value
        operators.push({ op, value })
        continue
      }
      if (op === "is" && (lower === "unread" || lower === "starred")) {
        filters[lower] = true
        operators.push({ op, value: lower })
        continue
      }
      if (op === "has" && (lower === "attachment" || lower === "attachments")) {
        filters.hasAttachment = true
        operators.push({ op, value: "attachment" })
        continue
      }
      if (op === "before" || op === "after") {
        const day = dayOf(value)
        if (day !== null) {
          // As Gmail reads them: after:2026/10/16 before:2026/10/17 is that one day.
          if (op === "before") filters.before = day
          else filters.after = day
          operators.push({ op, value })
          continue
        }
      }
      const column = COLUMN_OPERATORS[op]
      if (column) {
        const ws = words(value)
        if (ws.length === 0) continue
        const expr =
          quotedValue !== undefined ? quote(ws.join(" ")) : ws.map((w) => `${quote(w)}*`).join(" AND ")
        terms.push(`${column} : (${expr})`)
        operators.push({ op, value })
        continue
      }
      // An unknown operator is just text: "re:budget" searches for "re" and "budget", and says so.
      unsupported.push({ op, value })
      for (const w of words(match[0])) {
        terms.push(`${quote(w)}*`)
        plain.push(w)
      }
      continue
    }
    if (phrase !== undefined) {
      const ws = words(phrase)
      if (ws.length > 0) {
        terms.push(quote(ws.join(" ")))
        plain.push(ws.join(" "))
      }
      continue
    }
    for (const w of words(bare ?? "")) {
      terms.push(`${quote(w)}*`)
      plain.push(w)
    }
  }
  return {
    match: terms.length > 0 ? terms.join(" AND ") : null,
    filters,
    parsed: { operators, terms: plain, unsupported },
  }
}

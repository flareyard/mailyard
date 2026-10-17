/**
 * An RFC 4180 CSV reader that can stop and resume: it parses what it has, returns the records that
 * are complete and how much text they used, and leaves a record cut off at the end of the buffer for
 * the next call. Quoted fields may hold commas, quotes ("") and line breaks; lines end in CRLF or LF.
 * A quote in the middle of an unquoted field is kept as text, as most spreadsheets write it.
 */

export type CsvRecord = { readonly line: number; readonly fields: ReadonlyArray<string> }

export type CsvParse = {
  readonly records: ReadonlyArray<CsvRecord>
  /** Characters of `text` the returned records used, up to and including the last one's line end. */
  readonly consumed: number
  /** The line number the next record starts on. */
  readonly nextLine: number
  /** Whether the text ran out mid-record (only possible when `final` is false). */
  readonly partial: boolean
}

export const BOM = "﻿"

/**
 * Parses at most `maxRecords` complete records from `text`. With `final`, the end of `text` ends
 * the last record; without, a record that reaches the end is left for the next call. Blank lines
 * are skipped. `startLine` numbers the first line of `text`.
 */
export const parseCsv = (
  text: string,
  options: { readonly maxRecords: number; readonly final: boolean; readonly startLine?: number },
): CsvParse => {
  const records: Array<CsvRecord> = []
  let line = options.startLine ?? 1
  let i = 0
  let consumed = 0
  let nextLine = line
  const n = text.length

  while (i < n && records.length < options.maxRecords) {
    const recordLine = line
    const fields: Array<string> = []
    let field = ""
    let quoted = false
    let complete = false
    let fieldStart = true
    while (i < n) {
      const ch = text[i] as string
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          if (i + 1 >= n && !options.final) break // can't tell an escaped quote from the closing one yet
          quoted = false
          i++
          continue
        }
        if (ch === "\n") line++
        field += ch
        i++
        continue
      }
      if (ch === '"' && fieldStart) {
        quoted = true
        fieldStart = false
        i++
        continue
      }
      if (ch === ",") {
        fields.push(field)
        field = ""
        fieldStart = true
        i++
        continue
      }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r") {
          if (i + 1 >= n && !options.final) break // a CR at the end may be half of a CRLF
          i += text[i + 1] === "\n" ? 2 : 1
        } else i++
        line++
        complete = true
        break
      }
      field += ch
      fieldStart = false
      i++
    }
    if (!complete) {
      if (!options.final || quoted) {
        // Cut off: leave it for the next call (or, at the very end, an unclosed quote is the caller's to report).
        return { records, consumed, nextLine, partial: true }
      }
      if (i >= n) complete = true
    }
    fields.push(field)
    consumed = i
    nextLine = line
    // A blank line is one empty field; skip it.
    if (!(fields.length === 1 && fields[0] === "")) records.push({ line: recordLine, fields })
  }
  return { records, consumed, nextLine, partial: false }
}

/** UTF-8 byte length of a string, for turning characters consumed into a byte offset. */
export const byteLength = (s: string) => new TextEncoder().encode(s).byteLength

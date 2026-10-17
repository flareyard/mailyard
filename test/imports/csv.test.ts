import { describe, expect, it } from "vitest"
import { byteLength, parseCsv } from "../../src/imports/csv.ts"

const all = (text: string) => parseCsv(text, { maxRecords: Number.MAX_SAFE_INTEGER, final: true })
const fieldsOf = (text: string) => all(text).records.map((r) => r.fields)

/** Parses `text` in pieces cut at `cuts`, the way the importer reads a file from successive offsets. */
const inPieces = (text: string, size: number, maxRecords = Number.MAX_SAFE_INTEGER) => {
  const out: Array<{ line: number; fields: ReadonlyArray<string> }> = []
  let offset = 0
  let line = 1
  for (let guard = 0; offset < text.length && guard < 10_000; guard++) {
    let take = size
    for (;;) {
      const piece = text.slice(offset, offset + take)
      const final = offset + take >= text.length
      const r = parseCsv(piece, { maxRecords, final, startLine: line })
      if (r.records.length === 0 && r.partial && !final) {
        take *= 2 // a record longer than the window: read more, as the importer would fail instead
        continue
      }
      out.push(...r.records)
      offset += r.consumed
      line = r.nextLine
      if (r.consumed === 0) offset = text.length
      break
    }
  }
  return out
}

describe("parseCsv (RFC 4180)", () => {
  it("reads quoted commas, escaped quotes, line breaks inside quotes, CRLF and LF", () => {
    const text = 'email,name,note\r\na@x.co,"Doe, Jane","said ""hi"""\r\nb@x.co,Bo,"two\r\nlines"\nc@x.co,,\n'
    expect(fieldsOf(text)).toEqual([
      ["email", "name", "note"],
      ["a@x.co", "Doe, Jane", 'said "hi"'],
      ["b@x.co", "Bo", "two\r\nlines"],
      ["c@x.co", "", ""],
    ])
    // Line numbers count physical lines, so a quoted line break moves the next record down.
    expect(all(text).records.map((r) => r.line)).toEqual([1, 2, 3, 5])
  })

  it("skips blank lines, keeps a last line without a line end, and keeps a stray quote mid-field as text", () => {
    expect(fieldsOf('a,b\n\n\r\nc,d"e\nf,g')).toEqual([
      ["a", "b"],
      ["c", 'd"e'],
      ["f", "g"],
    ])
  })

  it("stops at maxRecords and reports how much it used", () => {
    const r = parseCsv("a\nb\nc\n", { maxRecords: 2, final: true })
    expect(r.records.map((x) => x.fields[0])).toEqual(["a", "b"])
    expect(r.consumed).toBe(4)
    expect(r.nextLine).toBe(3)
  })

  it("leaves a record cut off at the end for the next read, including a CR that may be half a CRLF", () => {
    expect(parseCsv('a,b\nc,"d', { maxRecords: 10, final: false })).toMatchObject({
      consumed: 4,
      partial: true,
    })
    expect(parseCsv("a,b\r", { maxRecords: 10, final: false })).toMatchObject({ consumed: 0, partial: true })
    expect(parseCsv('a,"b"', { maxRecords: 10, final: false })).toMatchObject({ consumed: 0, partial: true })
    // At the very end, an unclosed quote is reported as partial for the caller to fail on.
    expect(parseCsv('a,"b', { maxRecords: 10, final: true })).toMatchObject({ records: [], partial: true })
  })

  it("parses the same however the file is cut into reads", () => {
    const rows = ['email,name,"note, with comma"']
    for (let i = 0; i < 40; i++)
      rows.push(`u${i}@x.co,"Name ${i}","${i % 3 === 0 ? 'multi\r\nline ""quoted""' : "plain"}"`)
    const csv = `${rows.join("\r\n")}\r\n`
    const whole = all(csv).records
    for (const size of [1, 2, 3, 7, 16, 64, 333]) expect(inPieces(csv, size)).toEqual(whole)
    expect(inPieces(csv, 50, 3)).toEqual(whole)
  })

  it("turns characters used into UTF-8 bytes for the next offset", () => {
    const text = "é,ü\n漢,字\n"
    const r = parseCsv(text, { maxRecords: 1, final: true })
    expect(byteLength(text.slice(0, r.consumed))).toBe(6)
  })
})

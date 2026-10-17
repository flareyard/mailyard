import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { centralDirectory, crc32, localEntry } from "../../src/exports/zip.ts"
import { mapFolder } from "../../src/imports/folders.ts"
import { mboxEntry, mboxRanges, parseMbox } from "../../src/imports/mbox.ts"

const enc = new TextEncoder()
const dec = new TextDecoder()

describe("mboxrd", () => {
  it("round-trips CRLF messages byte for byte, quoting and unquoting From lines", () => {
    const tricky = [
      "From: a@example.org\r\nSubject: one\r\n\r\nFrom the start of a line\r\n>From already quoted\r\n>>From twice\r\nend\r\n",
      "From: b@example.org\r\nSubject: two\r\n\r\nNo trailing newline at all",
      "From: c@example.org\r\nSubject: three\r\n\r\n\r\n\r\nblank lines above\r\n",
    ].map((s) => enc.encode(s))
    const mbox = new Uint8Array(
      tricky.flatMap((raw, i) => [
        ...mboxEntry(raw, `sender${i}@example.org`, Date.parse("2026-10-17T09:00:00Z")),
      ]),
    )
    const text = dec.decode(mbox)
    expect(text.startsWith("From sender0@example.org Sat Oct 17 09:00:00 2026\n")).toBe(true)
    expect(text).toContain("\n>From the start of a line\n")
    expect(text).toContain("\n>>From already quoted\n")
    expect(text).toContain("\n>>>From twice\n")
    expect(text).not.toContain("\r")
    const back = parseMbox(mbox)
    expect(back).toHaveLength(3)
    expect(dec.decode(back[0])).toBe(dec.decode(tricky[0]))
    expect(dec.decode(back[2])).toBe(dec.decode(tricky[2]))
    // A message with no final newline gains one, as every mbox writer does.
    expect(dec.decode(back[1])).toBe(`${dec.decode(tricky[1])}\r\n`)
    expect(mboxRanges(mbox)).toHaveLength(3)
  })
})

describe("zip", () => {
  it("writes stored entries any unzipper reads back, with ZIP64 end records", () => {
    const files = [
      { name: "inbox/2026-10-17-inb_1.eml", content: enc.encode("Subject: one\r\n\r\nhello\r\n") },
      { name: "sent/2026-10-17-snt_2.eml", content: enc.encode("Subject: two\r\n\r\nrésumé\r\n") },
      { name: "archive/naïve-ünïcode.eml", content: new Uint8Array(70_000).fill(65) },
    ]
    const parts: Array<Uint8Array> = []
    const entries = []
    let offset = 0
    for (const f of files) {
      const local = localEntry(f.name, f.content, offset, Date.parse("2026-10-17T09:00:00Z"))
      parts.push(local.bytes)
      entries.push(local.entry)
      offset += local.bytes.length
    }
    parts.push(centralDirectory(entries, offset))
    const zip = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let p = 0
    for (const part of parts) {
      zip.set(part, p)
      p += part.length
    }
    const unzipped = unzipSync(zip)
    expect(Object.keys(unzipped).sort()).toEqual(files.map((f) => f.name).sort())
    for (const f of files) expect(unzipped[f.name]).toEqual(f.content)
    expect(Object.keys(unzipSync(centralDirectory([], 0)))).toEqual([])
  })

  it("computes the standard CRC-32", () => {
    expect(crc32(enc.encode("123456789")).toString(16)).toBe("cbf43926")
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe("folder mapping", () => {
  it.each([
    ["INBOX", [], { skip: null, folder: "inbox", label: null }],
    ["Sent", ["\\Sent"], { skip: null, folder: "sent", label: null }],
    ["Sent Items", [], { skip: null, folder: "sent", label: null }],
    ["INBOX.Trash", [], { skip: null, folder: "trash", label: null }],
    ["Spam", ["\\Junk"], { skip: null, folder: "spam", label: null }],
    ["Archive", ["\\Archive"], { skip: null, folder: "archive", label: null }],
    ["Projects/Acme", [], { skip: null, folder: "archive", label: "Projects/Acme" }],
    ["INBOX.Receipts", [], { skip: null, folder: "archive", label: "Receipts" }],
  ] as const)("%s → %o", (name, flags, mapping) => {
    expect(mapFolder(name, flags)).toEqual(mapping)
  })

  it("skips drafts, virtual views and unselectable folders", () => {
    expect(mapFolder("Drafts", ["\\Drafts"]).skip).toBe("drafts aren't imported")
    expect(mapFolder("[Gmail]/All Mail", ["\\All"]).skip).toBe("a view of every folder")
    expect(mapFolder("[Gmail]/Starred", ["\\Flagged"]).skip).toBe("a view of starred mail")
    expect(mapFolder("[Gmail]", ["\\Noselect"]).skip).toBe("holds no mail")
  })
})

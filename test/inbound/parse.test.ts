import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { parseMessage, snippetOf } from "../../src/inbound/parse.ts"
import attachments from "../fixtures/eml/attachments.eml?raw"
import broken from "../fixtures/eml/broken-mime.eml?raw"
import koi8 from "../fixtures/eml/charset-koi8r.eml?raw"
import latin1 from "../fixtures/eml/charset-latin1.eml?raw"
import sjis from "../fixtures/eml/charset-shift-jis.eml?raw"
import inline from "../fixtures/eml/inline-image.eml?raw"
import alternative from "../fixtures/eml/multipart-alternative.eml?raw"
import { deepMessage, largeMessage } from "./messages.ts"

const parse = (raw: string | Uint8Array) =>
  Effect.runPromise(parseMessage(typeof raw === "string" ? new TextEncoder().encode(raw) : raw))
const parseExit = (raw: Uint8Array) => Effect.runPromise(Effect.exit(parseMessage(raw)))

describe("parseMessage: golden fixtures", () => {
  it("multipart/alternative: headers, both bodies, threading ids and auth results", async () => {
    const m = await parse(alternative)
    expect(m.messageId).toBe("<reply-2@example.org>")
    expect(m.inReplyTo).toBe("<note-1@acme.test>")
    expect(m.references).toEqual(["<thread-0@acme.test>", "<note-1@acme.test>"])
    expect(m.subject).toBe("Re: Engine design notes")
    expect(m.date).toBe(Date.parse("2026-10-16T20:59:58Z"))
    expect(m.from).toEqual({ name: "Ada Lovelace", address: "ada@example.org" })
    expect(m.to).toEqual([
      { name: "Sam", address: "sam@acme.test" },
      { name: null, address: "team@acme.test" },
    ])
    expect(m.cc).toEqual([{ name: null, address: "grace@example.org" }])
    expect(m.replyTo).toEqual([{ name: null, address: "replies@example.org" }])
    expect(m.text).toContain("the diagrams help — more below")
    expect(m.html).toContain("<blockquote>Here are the notes.</blockquote>")
    // The snippet is the new text only: no attribution line, no quote.
    expect(m.snippet).toBe("Thanks, the diagrams help — more below.")
    expect(m.attachments).toEqual([])
    expect(m.automated).toBe(false)
    expect(m.auth).toEqual({
      source: "authentication-results",
      authservId: "mx.cloudflare.net",
      spf: "pass",
      spfDomain: "example.org",
      dkim: [{ result: "pass", domain: "example.org", selector: "s1" }],
      dmarc: "pass",
      dmarcDomain: "example.org",
      arc: "none",
    })
  })

  it("inline images: the cid part is a related attachment, list headers are read", async () => {
    const m = await parse(inline)
    expect(m.html).toContain('src="cid:logo@example.org"')
    expect(m.attachments).toHaveLength(1)
    const [logo] = m.attachments
    expect(logo).toMatchObject({
      filename: "logo.png",
      mimeType: "image/png",
      disposition: "inline",
      contentId: "logo@example.org",
      related: true,
      size: 67,
    })
    expect(logo?.content.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    expect(logo?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(m.text).toContain("Hello")
    expect(m.listId).toBe("Example News <news.example.org>")
    expect(m.listUnsubscribe).toBe("<https://example.org/u/1>, <mailto:unsub@example.org>")
    expect(m.automated).toBe(true)
    expect(m.auth.source).toBe("none")
  })

  it("attachments: bytes intact, RFC 2231 UTF-8 filenames decoded, content hashed", async () => {
    const m = await parse(attachments)
    expect(m.to).toEqual([{ name: null, address: "sam+invoices@acme.test" }])
    expect(m.text.trim()).toBe("Your invoice and the usage export are attached.")
    expect(m.attachments.map((a) => [a.filename, a.mimeType, a.disposition, a.related])).toEqual([
      ["résumé invoice.pdf", "application/pdf", "attachment", false],
      ["usage.csv", "text/csv", "attachment", false],
    ])
    const [pdf, csv] = m.attachments
    expect(new TextDecoder().decode(pdf?.content)).toMatch(/^%PDF-1\.4\n[\s\S]*%%EOF\n$/)
    expect(new TextDecoder().decode(csv?.content)).toBe("name,amount\r\nAda,10\r\nGrace,20")
    const digest = await crypto.subtle.digest("SHA-256", pdf?.content ?? new Uint8Array())
    expect(pdf?.sha256).toBe(
      Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
    )
  })

  it("non-UTF-8 charsets: ISO-8859-1 and Windows-1252 headers and quoted-printable body", async () => {
    const m = await parse(latin1)
    expect(m.from).toEqual({ name: "Renée", address: "renee@example.fr" })
    expect(m.subject).toBe("Façade – révision")
    expect(m.text.trim()).toBe("Le café est prêt à 8h.")
  })

  it("non-UTF-8 charsets: ISO-2022-JP subject and a Shift_JIS base64 body", async () => {
    const m = await parse(sjis)
    expect(m.subject).toBe("会議の件")
    expect(m.text.trim()).toBe("明日の会議は十時からです。")
  })

  it("non-UTF-8 charsets: KOI8-R subject and body", async () => {
    const m = await parse(koi8)
    expect(m.subject).toBe("Привет")
    expect(m.text.trim()).toBe("Добрый день, отчёт готов.")
  })

  it("non-UTF-8 charsets: 8-bit Latin-1 bytes sent without any transfer encoding", async () => {
    const head =
      "From: a@example.org\r\nTo: sam@acme.test\r\nSubject: raw\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
    const body = Uint8Array.from(
      [...("Na" as string)].map((c) => c.charCodeAt(0)).concat([0xef, 0x76, 0x65, 0x0d, 0x0a]),
    )
    const raw = new Uint8Array([...new TextEncoder().encode(head), ...body])
    const m = await parse(raw)
    expect(m.text.trim()).toBe("Naïve")
  })

  it("broken MIME: still yields what can be read rather than failing", async () => {
    const m = await parse(broken)
    expect(m.subject).toBe("Broken but readable")
    expect(m.messageId).toBe("<broken-without-brackets@example.net>")
    expect(m.date).toBeNull()
    expect(m.text).toContain("The body still reads.")
    expect(m.attachments.map((a) => a.filename)).toEqual(["data.bin"])
    expect(m.from).toEqual({ name: null, address: "broken@example.net" })
  })

  it("a near-25 MiB message: parses, and the large attachment comes through byte for byte", async () => {
    const { raw, payload } = largeMessage(24.5 * 1024 * 1024)
    expect(raw.byteLength).toBeGreaterThan(24 * 1024 * 1024)
    expect(raw.byteLength).toBeLessThan(25 * 1024 * 1024)
    const m = await parse(raw)
    expect(m.attachments).toHaveLength(1)
    const [big] = m.attachments
    expect(big?.size).toBe(payload.byteLength)
    expect(big?.content[0]).toBe(payload[0])
    expect(big?.content[payload.byteLength - 1]).toBe(payload[payload.byteLength - 1])
  }, 60_000)

  it("a message nested past the limit fails as ParseFailed instead of throwing", async () => {
    const exit = await parseExit(deepMessage(80))
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("ParseFailed")
  })
})

describe("snippetOf", () => {
  it("drops quotes and attribution, collapses whitespace and caps the length", () => {
    expect(snippetOf("Hi there,\n\n  see below.\n> old\n> older")).toBe("Hi there, see below.")
    expect(snippetOf("Top\n-----Original Message-----\nFrom: x")).toBe("Top")
    const long = snippetOf("word ".repeat(100))
    expect(long.length).toBe(200)
    expect(long.endsWith("…")).toBe(true)
  })
})

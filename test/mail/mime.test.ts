import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { parseMessage } from "../../src/inbound/parse.ts"
import { buildMime, foldHeader, quotedPrintable } from "../../src/mail/mime.ts"

const parse = (bytes: Uint8Array) => Effect.runPromise(parseMessage(bytes))

describe("buildMime", () => {
  it("round-trips through the parser: addresses, encoded subject, both bodies, attachments", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 fake\n")
    const raw = buildMime(
      {
        from: { email: "sam@acme.test", name: "Sam O'Brien, Ops" },
        to: [{ email: "ada@example.org", name: "Ada Lovelace" }],
        cc: [{ email: "grace@example.org" }],
        bcc: [{ email: "secret@example.org" }],
        subject: "Re: Café plans — résumé attached",
        text: `Hi Ada,\n\n${"a long line ".repeat(20)}\n= equals sign`,
        html: "<p>Hi <b>Ada</b></p>",
        headers: { "In-Reply-To": "<x@example.org>", References: "<root@example.org> <x@example.org>" },
        attachments: [
          { filename: "résumé.pdf", type: "application/pdf", content: pdf, disposition: "attachment" },
        ],
      },
      { messageId: "<sent-1@acme.test>", date: new Date("2026-10-17T10:00:00Z") },
    )
    const text = new TextDecoder().decode(raw)
    expect(text).not.toContain("secret@example.org")
    expect(text.split("\r\n").every((line) => line.length <= 998)).toBe(true)
    const m = await parse(raw)
    expect(m.from).toEqual({ name: "Sam O'Brien, Ops", address: "sam@acme.test" })
    expect(m.to).toEqual([{ name: "Ada Lovelace", address: "ada@example.org" }])
    expect(m.cc).toEqual([{ name: null, address: "grace@example.org" }])
    expect(m.subject).toBe("Re: Café plans — résumé attached")
    expect(m.messageId).toBe("<sent-1@acme.test>")
    expect(m.inReplyTo).toBe("<x@example.org>")
    expect(m.references).toEqual(["<root@example.org>", "<x@example.org>"])
    expect(m.date).toBe(Date.parse("2026-10-17T10:00:00Z"))
    expect(m.text).toContain("= equals sign")
    expect(m.text).toContain("a long line a long line")
    expect(m.html).toContain("<b>Ada</b>")
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0]).toMatchObject({
      filename: "résumé.pdf",
      mimeType: "application/pdf",
      disposition: "attachment",
    })
    expect(new TextDecoder().decode(m.attachments[0]?.content)).toBe("%PDF-1.4 fake\n")
  })

  it("keeps Bcc only in the sender's own copy when asked", async () => {
    const raw = buildMime(
      {
        from: { email: "a@x.test" },
        to: [{ email: "b@x.test" }],
        bcc: [{ email: "c@x.test" }],
        subject: "s",
        text: "t",
      },
      { bccInHeaders: true },
    )
    expect(new TextDecoder().decode(raw)).toContain("Bcc: c@x.test")
  })

  it("folds long headers and quoted-printables long or 8-bit text", () => {
    const folded = foldHeader(
      "References",
      Array.from({ length: 12 }, (_, i) => `<message-${i}@example.org>`).join(" "),
    )
    expect(folded.split("\r\n").every((l) => l.length <= 78)).toBe(true)
    expect(
      folded
        .split("\r\n")
        .slice(1)
        .every((l) => l.startsWith(" ")),
    ).toBe(true)
    const qp = quotedPrintable(`${"x".repeat(100)}\nnaïve = ok `)
    expect(qp.split("\r\n").every((l) => l.length <= 76)).toBe(true)
    expect(qp).toContain("na=C3=AFve =3D ok=20")
  })
})

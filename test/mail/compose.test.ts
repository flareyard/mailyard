import { describe, expect, it } from "vitest"
import {
  MAX_REFERENCES,
  quoteBody,
  referencesFor,
  replyRecipients,
  replySubject,
} from "../../src/mail/compose.ts"
import type { StoredMessage } from "../../src/mailbox/types.ts"

const message = (fields: Partial<StoredMessage>): StoredMessage =>
  ({
    id: "inb_1",
    threadId: "thr_1",
    folder: "inbox",
    seen: false,
    starred: false,
    answered: false,
    labelIds: [],
    receivedAt: Date.parse("2026-10-16T09:00:00Z"),
    storedAt: 0,
    envelopeFrom: "ada@example.org",
    envelopeTo: "sam@acme.test",
    via: "mailbox",
    tag: null,
    rawKey: "raw",
    bodyKey: "body",
    size: 1,
    messageId: "<m1@example.org>",
    inReplyTo: null,
    references: [],
    subject: "Plans",
    date: Date.parse("2026-10-16T09:00:00Z"),
    from: { name: "Ada", address: "ada@example.org" },
    sender: null,
    replyTo: [],
    to: [
      { name: "Sam", address: "sam@acme.test" },
      { name: null, address: "team@acme.test" },
    ],
    cc: [
      { name: "Grace", address: "grace@example.org" },
      { name: null, address: "sam@acme.test" },
    ],
    snippet: "",
    hasHtml: false,
    auth: {
      source: "none",
      authservId: null,
      spf: null,
      spfDomain: null,
      dkim: [],
      dmarc: null,
      dmarcDomain: null,
      arc: null,
    },
    automated: false,
    listId: null,
    listUnsubscribe: null,
    attachments: [],
    ...fields,
  }) as StoredMessage

describe("replies", () => {
  it("References carry the chain plus the parent, keeping the root when it grows past the limit", () => {
    expect(referencesFor(message({ references: ["<a@x>", "<b@x>"] }))).toEqual([
      "<a@x>",
      "<b@x>",
      "<m1@example.org>",
    ])
    expect(referencesFor(message({ inReplyTo: "<p@x>" }))).toEqual(["<p@x>", "<m1@example.org>"])
    const long = Array.from({ length: 40 }, (_, i) => `<r${i}@x>`)
    const refs = referencesFor(message({ references: long }))
    expect(refs).toHaveLength(MAX_REFERENCES)
    expect(refs[0]).toBe("<r0@x>")
    expect(refs.at(-1)).toBe("<m1@example.org>")
  })

  it("prefixes the subject once", () => {
    expect(replySubject("Plans", "reply")).toBe("Re: Plans")
    expect(replySubject("RE: Plans", "replyAll")).toBe("RE: Plans")
    expect(replySubject("Re: Plans", "forward")).toBe("Fwd: Re: Plans")
    expect(replySubject("Fwd: Plans", "forward")).toBe("Fwd: Plans")
  })

  it("reply goes to Reply-To or the sender; reply-all adds everyone else, never yourself", () => {
    const own = ["sam@acme.test", "team@acme.test"]
    expect(replyRecipients(message({}), "reply", own)).toEqual({
      to: [{ name: "Ada", address: "ada@example.org" }],
      cc: [],
    })
    expect(
      replyRecipients(message({ replyTo: [{ name: null, address: "replies@example.org" }] }), "reply", own)
        .to,
    ).toEqual([{ name: null, address: "replies@example.org" }])
    expect(replyRecipients(message({}), "replyAll", own)).toEqual({
      to: [{ name: "Ada", address: "ada@example.org" }],
      cc: [{ name: "Grace", address: "grace@example.org" }],
    })
    // Replying to your own sent message goes back to whoever you wrote to.
    const sent = message({
      from: { name: "Sam", address: "sam@acme.test" },
      to: [{ name: "Ada", address: "ada@example.org" }],
      cc: [],
    })
    expect(replyRecipients(sent, "reply", own).to).toEqual([{ name: "Ada", address: "ada@example.org" }])
  })

  it("quotes the original under an attribution line, or as a forwarded block", () => {
    const quoted = quoteBody(message({}), "Line one\n> earlier", "reply")
    expect(quoted).toContain("On Fri, 16 Oct 2026 09:00:00 GMT, Ada <ada@example.org> wrote:")
    expect(quoted).toContain("> Line one\n>> earlier")
    const forwarded = quoteBody(message({}), "Body", "forward")
    expect(forwarded).toContain("---------- Forwarded message ---------")
    expect(forwarded).toContain("Subject: Plans")
  })
})

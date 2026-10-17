import { describe, expect, it } from "vitest"
import {
  decodeMailboxName,
  ImapClient,
  ImapError,
  parseInternalDate,
  tokenize,
  uidSet,
} from "../../src/imap/client.ts"
import { fakeImap } from "./fakeServer.ts"

const raw = (subject: string, body = "Hello.") =>
  `From: a@example.org\r\nTo: b@example.org\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, "")}@example.org>\r\n\r\n${body}\r\n`

describe("tokenize", () => {
  it("reads atoms, quoted strings, NIL, nested lists and literals in order", () => {
    const literal = new TextEncoder().encode('raw {7} bytes "quoted" (paren')
    const tokens = tokenize([
      '1 FETCH (UID 4 FLAGS (\\Seen $Junk) INTERNALDATE "17-Jul-1996 02:44:25 -0700" BODY[] {30}',
      literal,
      " X NIL)",
    ])
    expect(tokens[0]).toBe("1")
    expect(tokens[1]).toBe("FETCH")
    const list = tokens[2] as ReadonlyArray<unknown>
    expect(list.slice(0, 6)).toEqual([
      "UID",
      "4",
      "FLAGS",
      ["\\Seen", "$Junk"],
      "INTERNALDATE",
      "17-Jul-1996 02:44:25 -0700",
    ])
    expect(list[6]).toBe("BODY[]")
    expect(list[7]).toBe(literal)
    expect(list.slice(8)).toEqual(["X", null])
  })
})

describe("helpers", () => {
  it("compresses UID sets, parses INTERNALDATE and decodes modified UTF-7 folder names", () => {
    expect(uidSet([7, 1, 2, 3, 4, 9, 10, 12, 4])).toBe("1:4,7,9:10,12")
    expect(parseInternalDate("17-Jul-1996 02:44:25 -0700")).toBe(Date.parse("1996-07-17T09:44:25Z"))
    expect(parseInternalDate(" 1-Jan-2026 00:00:00 +0100")).toBe(Date.parse("2025-12-31T23:00:00Z"))
    expect(parseInternalDate("garbage")).toBeNull()
    expect(decodeMailboxName("Entw&APw-rfe")).toBe("Entwürfe")
    expect(decodeMailboxName("&ZeVnLIqe-")).toBe("日本語")
    expect(decodeMailboxName("Tom &- Jerry")).toBe("Tom & Jerry")
  })
})

describe("ImapClient against a scripted server", () => {
  const server = () =>
    fakeImap({
      username: "me@acme.test",
      password: 'p"ss\\w0rd',
      folders: [
        {
          name: "INBOX",
          uidValidity: 42,
          messages: [1, 2, 3, 5].map((uid) => ({
            uid,
            raw: raw(`Inbox ${uid}`),
            flags: uid === 2 ? ["\\Seen", "\\Flagged"] : [],
          })),
        },
        { name: "Sent", flags: ["\\HasNoChildren", "\\Sent"], messages: [{ uid: 1, raw: raw("Sent one") }] },
        { name: "Entw&APw-rfe", flags: ["\\Drafts"], messages: [] },
      ],
    })

  it("logs in (quoting awkward passwords), lists, examines, searches and fetches bodies byte for byte", async () => {
    const fake = server()
    const client = new ImapClient(fake.transport())
    await client.greet()
    expect(client.capabilities).toContain("IMAP4REV1")
    await client.login("me@acme.test", 'p"ss\\w0rd')
    const folders = await client.list()
    expect(folders.map((f) => [f.name, f.flags])).toEqual([
      ["INBOX", []],
      ["Sent", ["\\HasNoChildren", "\\Sent"]],
      ["Entwürfe", ["\\Drafts"]],
    ])
    const inbox = folders[0]
    if (!inbox) throw new Error("no inbox")
    expect(await client.examine(inbox)).toEqual({ exists: 4, uidValidity: 42, uidNext: 6 })
    expect(await client.searchUids()).toEqual([1, 2, 3, 5])
    expect(await client.searchUids(3)).toEqual([3, 5])
    const sizes = await client.fetch([1, 2, 3, 5], { body: false })
    expect(sizes.map((m) => m.uid)).toEqual([1, 2, 3, 5])
    expect(sizes[1]?.flags).toEqual(["\\Seen", "\\Flagged"])
    const bodies = await client.fetch([2, 5], { body: true })
    expect(bodies.map((m) => new TextDecoder().decode(m.body ?? new Uint8Array()))).toEqual([
      raw("Inbox 2"),
      raw("Inbox 5"),
    ])
    expect(bodies[0]?.internalDate).toBe(Date.parse("2026-10-17T09:00:00Z"))
    await client.logout()
    // Read-only and non-destructive: EXAMINE and BODY.PEEK, never SELECT, STORE or EXPUNGE.
    expect(fake.log.some((c) => /^(SELECT|STORE|EXPUNGE|UID STORE)/i.test(c))).toBe(false)
  })

  it("reports a wrong password as an auth error", async () => {
    const client = new ImapClient(server().transport())
    await client.greet()
    await expect(client.login("me@acme.test", "wrong")).rejects.toMatchObject({ kind: "auth" })
  })

  it("reports a dropped connection as closed", async () => {
    const fake = fakeImap({
      username: "u",
      password: "p",
      folders: [{ name: "INBOX", messages: [{ uid: 1, raw: raw("x") }] }],
      dropAfterFetches: 0,
    })
    const client = new ImapClient(fake.transport())
    await client.greet()
    await client.login("u", "p")
    await client.examine({ name: "INBOX", raw: "INBOX", delimiter: "/", flags: [] })
    await expect(client.fetch([1], { body: true })).rejects.toBeInstanceOf(ImapError)
  })
})

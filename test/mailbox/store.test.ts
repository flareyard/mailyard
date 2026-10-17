import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { MAILBOX_MIGRATIONS } from "../../src/mailbox/schema.ts"
import { HIGHLIGHT_END, HIGHLIGHT_START, parseSearch } from "../../src/mailbox/search.ts"
import { MailboxStore } from "../../src/mailbox/store.ts"
import { mailboxErrorCode } from "../../src/mailbox/types.ts"
import type { MailboxDO } from "../../src/objects/MailboxDO.ts"
import { delivery, freshMailbox } from "./deliveries.ts"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/**
 * How far ahead the alarm tests schedule. The store refuses a time already past when the RPC arrives,
 * and a loaded CI machine can take well over 50 ms to get it there.
 */
const SOON_MS = 750

/**
 * Schedules something SOON_MS ahead, asking again with a fresh time if the call itself took so long
 * that the moment had already passed when it arrived. Returns the time that was accepted.
 */
const soon = async (schedule: (at: number) => Promise<unknown>) => {
  for (let tries = 0; ; tries++) {
    const at = Date.now() + SOON_MS
    try {
      await schedule(at)
      return at
    } catch (e) {
      if (tries >= 4 || !String(e).includes("in the future")) throw e
    }
  }
}
const sleepUntil = (at: number) => sleep(Math.max(0, at - Date.now()) + 100)
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise
    return null
  } catch (error) {
    return mailboxErrorCode(error)
  }
}

describe("threads", () => {
  it("summarises a conversation: first subject, newest snippet, participants, unread count", async () => {
    const box = freshMailbox()
    await box.deliver(
      delivery({ id: "inb_a", messageId: "<a@x>", subject: "Plan", snippet: "first", receivedAt: 1000 }),
    )
    await box.deliver(
      delivery({
        id: "inb_b",
        messageId: "<b@x>",
        inReplyTo: "<a@x>",
        references: ["<a@x>"],
        subject: "Re: Plan",
        snippet: "second",
        from: { name: "Grace", address: "grace@example.org" },
        receivedAt: 2000,
      }),
    )
    const { threads } = await box.threads()
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      subject: "Plan",
      snippet: "second",
      latestMessageId: "inb_b",
      messageCount: 2,
      unreadCount: 2,
      participants: [
        { name: "Ada Lovelace", address: "ada@example.org" },
        { name: "Grace", address: "grace@example.org" },
      ],
      folders: ["inbox"],
      firstAt: 1000,
      lastAt: 2000,
      sortAt: 2000,
    })
    const full = await box.thread(threads[0]?.id ?? "")
    expect(full?.messages.map((m) => m.id)).toEqual(["inb_a", "inb_b"])
  })

  it("merges two threads when a message connects them, and reports the removed one", async () => {
    const box = freshMailbox()
    await box.deliver(delivery({ id: "inb_1", messageId: "<1@x>", subject: "One" }))
    await box.deliver(delivery({ id: "inb_2", messageId: "<2@x>", subject: "Two" }))
    expect((await box.threads()).threads).toHaveLength(2)
    await box.deliver(
      delivery({ id: "inb_3", messageId: "<3@x>", inReplyTo: "<2@x>", references: ["<1@x>", "<2@x>"] }),
    )
    const { threads } = await box.threads()
    expect(threads).toHaveLength(1)
    expect(threads[0]?.messageCount).toBe(3)
  })

  it("lists newest first with a cursor, and filters by folder, unread and starred", async () => {
    const box = freshMailbox()
    for (let i = 0; i < 5; i++)
      await box.deliver(delivery({ id: `inb_${i}`, subject: `S${i}`, receivedAt: 1000 + i }))
    const first = await box.threads({ limit: 2 })
    expect(first.threads.map((t) => t.subject)).toEqual(["S4", "S3"])
    const second = await box.threads({ limit: 2, cursor: first.nextCursor })
    expect(second.threads.map((t) => t.subject)).toEqual(["S2", "S1"])
    const third = await box.threads({ limit: 2, cursor: second.nextCursor })
    expect(third).toMatchObject({ nextCursor: null })
    expect(third.threads.map((t) => t.subject)).toEqual(["S0"])

    await box.updateMessages(["inb_1"], { seen: true, starred: true })
    expect((await box.threads({ unread: true })).threads).toHaveLength(4)
    expect((await box.threads({ starred: true })).threads.map((t) => t.subject)).toEqual(["S1"])
  })
})

describe("folders and flags", () => {
  const conversation = async () => {
    const box = freshMailbox()
    await box.deliver(delivery({ id: "inb_in", messageId: "<in@x>", subject: "Q", receivedAt: 1000 }))
    await box.deliver(
      delivery({
        id: "inb_sent",
        messageId: "<sent@x>",
        inReplyTo: "<in@x>",
        subject: "Re: Q",
        receivedAt: 2000,
      }),
      "sent",
    )
    const threadId = (await box.threads()).threads[0]?.id ?? ""
    return { box, threadId }
  }

  it("archives only what is in the inbox, and brings it back; sent copies stay in sent", async () => {
    const { box, threadId } = await conversation()
    await box.updateThreads([threadId], { folder: "archive" })
    expect((await box.message("inb_in"))?.folder).toBe("archive")
    expect((await box.message("inb_sent"))?.folder).toBe("sent")
    expect((await box.threads({ folder: "inbox" })).threads).toHaveLength(0)
    expect((await box.threads({ folder: "archive" })).threads).toHaveLength(1)
    await box.updateThreads([threadId], { folder: "inbox" })
    expect((await box.message("inb_in"))?.folder).toBe("inbox")
  })

  it("trash takes the whole conversation; spam leaves your own sent copies alone", async () => {
    const { box, threadId } = await conversation()
    await box.updateThreads([threadId], { folder: "spam" })
    expect([(await box.message("inb_in"))?.folder, (await box.message("inb_sent"))?.folder]).toEqual([
      "spam",
      "sent",
    ])
    await box.updateThreads([threadId], { folder: "trash" })
    expect([(await box.message("inb_in"))?.folder, (await box.message("inb_sent"))?.folder]).toEqual([
      "trash",
      "trash",
    ])
    const thread = (await box.thread(threadId))?.thread
    expect(thread?.unreadCount).toBe(0)
  })

  it("thread star stars the newest message; unstar clears all; seen marks every message", async () => {
    const { box, threadId } = await conversation()
    await box.updateThreads([threadId], { starred: true, seen: true })
    expect((await box.message("inb_sent"))?.starred).toBe(true)
    expect((await box.message("inb_in"))?.starred).toBe(false)
    expect((await box.thread(threadId))?.thread).toMatchObject({ starred: true, unreadCount: 0 })
    await box.updateThreads([threadId], { starred: false })
    expect((await box.thread(threadId))?.thread.starred).toBe(false)
  })

  it("counts threads and unread threads per folder, plus drafts", async () => {
    const { box } = await conversation()
    await box.saveDraft({ subject: "Draft" })
    const counts = await box.folderCounts()
    expect(counts.find((c) => c.folder === "inbox")).toEqual({
      folder: "inbox",
      threads: 1,
      unreadThreads: 1,
    })
    expect(counts.find((c) => c.folder === "sent")).toEqual({ folder: "sent", threads: 1, unreadThreads: 0 })
    expect(counts.find((c) => c.folder === "drafts")).toEqual({
      folder: "drafts",
      threads: 1,
      unreadThreads: 0,
    })
  })

  it("refuses an unknown folder", async () => {
    const { box, threadId } = await conversation()
    expect(await codeOf(box.updateThreads([threadId], { folder: "nowhere" as never }))).toBe("invalid")
  })

  it("purges messages for good, returning the R2 keys they used", async () => {
    const box = freshMailbox()
    await box.deliver(
      delivery({
        id: "inb_p",
        attachments: [
          {
            id: "inb_p_0",
            filename: "a.pdf",
            mimeType: "application/pdf",
            disposition: "attachment",
            contentId: null,
            related: false,
            size: 3,
            sha256: "abc",
            r2Key: "att/abc",
          },
        ],
      }),
    )
    await box.updateMessages(["inb_p"], { folder: "trash" })
    const result = await box.emptyFolder("trash")
    expect(result).toMatchObject({ purged: 1, blobKeys: ["att/abc", "body/inb_p.json", "raw/inb_p.eml"] })
    expect(await box.count()).toBe(0)
    expect((await box.threads()).threads).toHaveLength(0)
    expect((await box.search("hello")).hits).toHaveLength(0)
  })
})

describe("labels", () => {
  it("creates, applies, counts, renames and deletes labels", async () => {
    const box = freshMailbox()
    await box.deliver(delivery({ id: "inb_l" }))
    const { label } = await box.createLabel({ name: "Receipts", color: "#00AA88" })
    expect(label).toMatchObject({ name: "Receipts", color: "#00aa88", threads: 0 })
    expect(await codeOf(box.createLabel({ name: "receipts" }))).toBe("label_exists")
    expect(await codeOf(box.createLabel({ name: "Bad", color: "red" }))).toBe("invalid")

    await box.updateMessages(["inb_l"], { addLabels: [label.id] })
    expect((await box.labels())[0]).toMatchObject({ threads: 1, unreadThreads: 1 })
    expect((await box.threads({ labelId: label.id })).threads).toHaveLength(1)
    expect((await box.message("inb_l"))?.labelIds).toEqual([label.id])
    expect(await codeOf(box.updateMessages(["inb_l"], { addLabels: ["lbl_nope"] }))).toBe("unknown_label")

    await box.updateLabel(label.id, { name: "Bills" })
    expect((await box.search("label:bills")).hits.map((h) => h.messageId)).toEqual(["inb_l"])
    await box.deleteLabel(label.id)
    expect(await box.labels()).toEqual([])
    expect((await box.message("inb_l"))?.labelIds).toEqual([])
    expect((await box.threads()).threads[0]?.labelIds).toEqual([])
  })
})

describe("search (FTS5)", () => {
  const seeded = async () => {
    const box = freshMailbox()
    await box.deliver(
      delivery({
        id: "inb_inv",
        subject: "Invoice for October",
        bodyText: "Please find the invoice attached. Payment is due Friday.",
        from: { name: "Billing", address: "billing@vendor.test" },
        receivedAt: 1000,
      }),
    )
    await box.deliver(
      delivery({
        id: "inb_cafe",
        subject: "Lunch",
        bodyText: "Meet at the café near the station.",
        from: { name: "Renée", address: "renee@example.fr" },
        to: [{ name: "Team", address: "team@acme.test" }],
        receivedAt: 2000,
      }),
    )
    await box.deliver(
      delivery({
        id: "inb_body",
        subject: "Notes",
        bodyText: "The invoice question came up in the meeting.",
        receivedAt: 3000,
      }),
    )
    return box
  }

  it("finds by subject, sender and body, best match first, with highlights", async () => {
    const box = await seeded()
    const { hits, threads } = await box.search("invoice", { sort: "relevance" })
    // By relevance, the subject match outranks the body-only match.
    expect(hits.map((h) => h.messageId)).toEqual(["inb_inv", "inb_body"])
    expect(hits[0]?.subjectHighlighted).toBe(`${HIGHLIGHT_START}Invoice${HIGHLIGHT_END} for October`)
    expect(hits[0]?.subject).toBe("Invoice for October")
    // By default, newest first.
    const recent = await box.search("invoice")
    expect(recent.sort).toBe("recent")
    const times = recent.hits.map((h) => h.receivedAt)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(hits[1]?.excerpt).toContain(`${HIGHLIGHT_START}invoice${HIGHLIGHT_END}`)
    expect(threads).toHaveLength(2)
    expect((await box.search("from:billing")).hits.map((h) => h.messageId)).toEqual(["inb_inv"])
    expect((await box.search("renee")).hits.map((h) => h.messageId)).toEqual(["inb_cafe"])
    expect((await box.search("to:team")).hits.map((h) => h.messageId)).toEqual(["inb_cafe"])
  })

  it("matches prefixes, ignores diacritics, and supports exact phrases", async () => {
    const box = await seeded()
    expect((await box.search("invo")).hits).toHaveLength(2)
    expect((await box.search("cafe")).hits.map((h) => h.messageId)).toEqual(["inb_cafe"])
    expect((await box.search('"due friday"')).hits.map((h) => h.messageId)).toEqual(["inb_inv"])
    expect((await box.search('"friday due"')).hits).toHaveLength(0)
    expect((await box.search("subject:invoice")).hits.map((h) => h.messageId)).toEqual(["inb_inv"])
  })

  it("leaves trash and spam out unless asked, and supports is:/has: filters", async () => {
    const box = await seeded()
    await box.updateMessages(["inb_body"], { folder: "trash" })
    expect((await box.search("invoice")).hits.map((h) => h.messageId)).toEqual(["inb_inv"])
    expect((await box.search("invoice in:trash")).hits.map((h) => h.messageId)).toEqual(["inb_body"])
    await box.updateMessages(["inb_cafe"], { starred: true, seen: true })
    expect((await box.search("is:starred")).hits.map((h) => h.messageId)).toEqual(["inb_cafe"])
    expect((await box.search("is:unread")).hits.map((h) => h.messageId)).toEqual(["inb_inv"])
  })

  it("never lets input break the query", async () => {
    const box = await seeded()
    for (const q of ['"', "AND", "OR NOT", "*", "NEAR(", "col:", ")(", "' OR 1=1 --", "from:", "💥"]) {
      await expect(box.search(q)).resolves.toBeDefined()
    }
  })
})

describe("parseSearch", () => {
  it("builds a safe FTS5 expression and pulls out the filters", () => {
    expect(
      parseSearch('from:ada "due friday" budget in:archive is:unread has:attachment label:"Big Deals"'),
    ).toEqual({
      match: 'sender : ("ada"*) AND "due friday" AND "budget"*',
      filters: {
        folder: "archive",
        labelName: "Big Deals",
        unread: true,
        starred: false,
        hasAttachment: true,
        before: null,
        after: null,
      },
      parsed: {
        operators: [
          { op: "from", value: "ada" },
          { op: "in", value: "archive" },
          { op: "is", value: "unread" },
          { op: "has", value: "attachment" },
          { op: "label", value: "Big Deals" },
        ],
        terms: ["due friday", "budget"],
        unsupported: [],
      },
    })
    // Dates, as Gmail reads them; an unknown operator is searched as words and reported.
    const dated = parseSearch("after:2026-10-16 before:2026/10/17 re:budget")
    expect(dated.filters).toMatchObject({ after: Date.UTC(2026, 9, 16), before: Date.UTC(2026, 9, 17) })
    expect(dated.parsed.unsupported).toEqual([{ op: "re", value: "budget" }])
    expect(parseSearch("before:someday").parsed.unsupported).toEqual([{ op: "before", value: "someday" }])
    expect(parseSearch('a"b').match).toBe('"a"* AND "b"*')
    expect(parseSearch("re:budget").match).toBe('"re"* AND "budget"*')
    expect(parseSearch("   ").match).toBeNull()
  })
})

describe("drafts and the schedule", () => {
  it("saves, edits and deletes drafts; editing a scheduled draft takes it off the schedule", async () => {
    const box = freshMailbox()
    const { draft } = await box.saveDraft({ subject: "Hi", to: [{ name: null, address: "x@example.org" }] })
    expect(draft).toMatchObject({ status: "draft", subject: "Hi", sendAt: null })
    const sendAt = Date.now() + 60 * 60 * 1000
    await box.scheduleDraft(draft.id, sendAt)
    expect(await box.draft(draft.id)).toMatchObject({ status: "scheduled", sendAt })
    expect(await box.alarmAt()).toBe(sendAt)

    await box.saveDraft({ id: draft.id, bodyText: "Edited" })
    expect(await box.draft(draft.id)).toMatchObject({
      status: "draft",
      sendAt: null,
      subject: "Hi",
      bodyText: "Edited",
    })
    expect(await box.alarmAt()).toBeNull()

    expect(await codeOf(box.scheduleDraft(draft.id, Date.now() - 1))).toBe("invalid")
    const empty = (await box.saveDraft({ subject: "No one" })).draft
    expect(await codeOf(box.scheduleDraft(empty.id, sendAt))).toBe("invalid")
    expect(await box.deleteDraft(draft.id)).toMatchObject({ blobKeys: [] })
    expect(await box.draft(draft.id)).toBeNull()
    expect(await codeOf(box.saveDraft({ id: "drf_missing" }))).toBe("not_found")
  })

  it("the alarm marks a scheduled draft due, and a due draft can't be edited", async () => {
    const box = freshMailbox()
    const { draft } = await box.saveDraft({
      subject: "Later",
      to: [{ name: null, address: "x@example.org" }],
    })
    await sleepUntil(await soon((at) => box.scheduleDraft(draft.id, at)))
    // Miniflare fires alarms in real time; this runs it now if it hasn't fired yet.
    await runDurableObjectAlarm(box)
    expect(await box.draft(draft.id)).toMatchObject({ status: "due" })
    expect(await box.drafts({ status: "due" })).toHaveLength(1)
    expect(await codeOf(box.saveDraft({ id: draft.id, subject: "Changed" }))).toBe("draft_locked")
    expect(await box.alarmAt()).toBeNull()
  })

  it("snoozes a thread out of the inbox and the alarm brings it back on top, unread", async () => {
    const box = freshMailbox()
    await box.deliver(delivery({ id: "inb_old", subject: "Old", receivedAt: 1000 }))
    await box.deliver(delivery({ id: "inb_new", subject: "New", receivedAt: 2000 }))
    await box.updateMessages(["inb_old"], { seen: true })
    const oldThread = (await box.message("inb_old"))?.threadId ?? ""
    const wakeAt = await soon((at) => box.snooze(oldThread, at))
    expect((await box.threads({ folder: "inbox" })).threads.map((t) => t.subject)).toEqual(["New"])
    expect((await box.threads({ folder: "snoozed" })).threads[0]?.snoozedUntil).not.toBeNull()

    await sleepUntil(wakeAt)
    await runDurableObjectAlarm(box)
    const inbox = (await box.threads({ folder: "inbox" })).threads
    expect(inbox.map((t) => t.subject)).toEqual(["Old", "New"])
    expect(inbox[0]).toMatchObject({ snoozedUntil: null, unreadCount: 1 })
    expect(await box.alarmAt()).toBeNull()
  })

  it("new mail in a snoozed conversation wakes it at once; unsnooze wakes it without marking unread", async () => {
    const box = freshMailbox()
    await box.deliver(delivery({ id: "inb_s1", messageId: "<s1@x>", subject: "Snoozy" }))
    const threadId = (await box.message("inb_s1"))?.threadId ?? ""
    await box.snooze(threadId, Date.now() + 60 * 60 * 1000)
    await box.deliver(
      delivery({ id: "inb_s2", inReplyTo: "<s1@x>", references: ["<s1@x>"], subject: "Re: Snoozy" }),
    )
    expect((await box.thread(threadId))?.thread).toMatchObject({ snoozedUntil: null, folders: ["inbox"] })
    expect(await box.alarmAt()).toBeNull()

    await box.updateMessages(["inb_s1", "inb_s2"], { seen: true })
    await box.snooze(threadId, Date.now() + 60 * 60 * 1000)
    await box.unsnooze(threadId)
    expect((await box.thread(threadId))?.thread).toMatchObject({ snoozedUntil: null, unreadCount: 0 })
    expect(await codeOf(box.snooze(threadId, Date.now() - 1))).toBe("invalid")
  })
})

describe("schema migrations", () => {
  it("v2 threads and indexes the messages a v1 mailbox stored", async () => {
    const box = freshMailbox()
    await runInDurableObject(box, (_instance: MailboxDO, state) => {
      const sql = state.storage.sql
      // Rebuild this object as a v1 mailbox holding two messages of one conversation.
      for (const table of [
        "search",
        "schedule",
        "drafts",
        "message_labels",
        "labels",
        "thread_refs",
        "threads",
        "attachments",
        "messages",
        "meta",
        "live_events",
        "thread_folders",
        "folder_counts",
        "correspondents",
        "smart_folders",
      ]) {
        sql.exec(`DROP TABLE IF EXISTS ${table}`)
      }
      for (const statement of MAILBOX_MIGRATIONS[0]?.statements ?? []) sql.exec(statement)
      sql.exec("UPDATE _schema SET version = 1")
      const insert = (id: string, messageId: string, inReplyTo: string | null, subject: string, at: number) =>
        sql.exec(
          `INSERT INTO messages (id, received_at, stored_at, envelope_from, envelope_to, via, raw_key, body_key, size,
             message_id, in_reply_to, refs, subject, from_address, reply_to, to_list, cc_list, snippet, body_text,
             has_html, has_attachments, auth, automated)
           VALUES (?, ?, ?, 'a@x', 'sam@acme.test', 'mailbox', 'raw', 'body', 1, ?, ?, ?, ?, 'a@x', '[]', '[]', '[]',
             'snip', 'migrated body text', 0, 0, '{}', 0)`,
          id,
          at,
          at,
          messageId,
          inReplyTo,
          JSON.stringify(inReplyTo ? [inReplyTo] : []),
          subject,
        )
      insert("inb_v1a", "<v1a@x>", null, "Legacy", 1000)
      insert("inb_v1b", "<v1b@x>", "<v1a@x>", "Re: Legacy", 2000)

      const store = new MailboxStore(sql, (fn) => state.storage.transactionSync(fn))
      store.migrate()
      expect(store.schemaVersion()).toBe(MAILBOX_MIGRATIONS.length)
      const { threads } = store.threads()
      expect(threads).toHaveLength(1)
      expect(threads[0]).toMatchObject({ subject: "Legacy", messageCount: 2, folders: ["inbox"] })
      expect(store.search("migrated").hits).toHaveLength(2)
    })
  })
})

describe("sent copies and shared inboxes", () => {
  it("a sent copy filed without its Message-ID joins replies once the id is known", async () => {
    const box = freshMailbox()
    // Sent fresh (not a reply), deferred on its first attempt, so filed with no Message-ID yet.
    await box.deliver(delivery({ id: "snt_1", messageId: null, subject: "Proposal" }), "sent")
    // The recipient's reply names the Message-ID Email Service gave it.
    await box.deliver(
      delivery({
        id: "inb_reply",
        messageId: "<r@x>",
        inReplyTo: "<cf-1@acme.test>",
        references: ["<cf-1@acme.test>"],
        subject: "Re: Proposal",
      }),
    )
    expect((await box.threads()).threads).toHaveLength(2)
    expect(await box.setMessageId("snt_1", "<cf-1@acme.test>")).toMatchObject({ changed: true })
    const { threads } = await box.threads()
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ messageCount: 2, folders: ["inbox", "sent"] })
    expect(await box.setMessageId("snt_1", "<cf-1@acme.test>")).toMatchObject({ changed: false })
    expect(await codeOf(box.setMessageId("snt_missing", "<x@x>"))).toBe("not_found")
  })

  it("assigns and unassigns conversations, and filters by assignee", async () => {
    const box = freshMailbox()
    await box.deliver(delivery({ id: "inb_a1", subject: "A" }))
    await box.deliver(delivery({ id: "inb_a2", subject: "B" }))
    const [a] = (await box.threads()).threads
    await box.assign([a?.id ?? ""], "key_sam")
    expect((await box.threads({ assignee: "key_sam" })).threads.map((t) => t.id)).toEqual([a?.id])
    expect((await box.threads({ assignee: "none" })).threads).toHaveLength(1)
    // Assignment survives the thread being recomputed by new mail.
    await box.updateThreads([a?.id ?? ""], { seen: true })
    expect((await box.thread(a?.id ?? ""))?.thread.assignee).toBe("key_sam")
    await box.assign([a?.id ?? ""], null)
    expect((await box.threads({ assignee: "none" })).threads).toHaveLength(2)
  })
})

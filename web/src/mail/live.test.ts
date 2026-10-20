import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { applyFrame, isFresh } from "./live.ts"
import { mailKeys } from "./queries.ts"
import type { Draft, FoldersBody, MessageDetail, Thread, ThreadDetail, ThreadPage } from "./types.ts"

const T0 = Date.UTC(2026, 9, 17, 17, 48)
const thread = (id: string, over: Partial<Thread> = {}): Thread =>
  ({
    id,
    subject: id,
    snippet: "",
    latestMessageId: `m_${id}`,
    messageCount: 1,
    unreadCount: 0,
    starred: false,
    hasAttachments: false,
    participants: [],
    folders: ["inbox"],
    labelIds: [],
    firstAt: T0,
    lastAt: T0,
    sortAt: T0,
    snoozedUntil: null,
    assignee: null,
    ...over,
  }) as Thread
const pages = (threads: Thread[], total: number) => ({
  pages: [{ threads, total, nextCursor: null } as ThreadPage],
  pageParams: [undefined],
})

function setup() {
  const qc = new QueryClient()
  const inbox = mailKeys.threads("mbx", {})
  const sent = mailKeys.threads("mbx", { folder: "sent" })
  qc.setQueryData(inbox, pages([thread("a", { sortAt: T0 - 10 })], 5))
  qc.setQueryData(sent, pages([], 0))
  return { qc, inbox, sent }
}
const ids = (qc: QueryClient, key: readonly unknown[]) =>
  qc.getQueryData<{ pages: ThreadPage[] }>(key)?.pages[0]?.threads.map((t) => t.id)

describe("applyFrame", () => {
  it("message.added slides the thread into the lists it belongs in, marks it new, and leaves others", () => {
    const { qc, inbox, sent } = setup()
    applyFrame(qc, "mbx", {
      type: "message.added",
      seq: 1,
      thread: thread("n", { unreadCount: 1 }),
      removedThreadIds: [],
      counts: [],
    })
    expect(ids(qc, inbox)).toEqual(["n", "a"])
    expect(qc.getQueryData<{ pages: ThreadPage[] }>(inbox)?.pages[0]?.total).toBe(6)
    expect(ids(qc, sent)).toEqual([])
    expect(isFresh("n")).toBe(true)
  })

  it("threads.changed moves rows between lists and updates the open thread", () => {
    const { qc, inbox, sent } = setup()
    qc.setQueryData<ThreadDetail>(mailKeys.thread("mbx", "a"), {
      thread: thread("a"),
      messages: [],
      drafts: [],
      notes: [],
    } as unknown as ThreadDetail)
    applyFrame(qc, "mbx", {
      type: "threads.changed",
      seq: 2,
      threads: [thread("a", { folders: ["sent"], starred: true })],
      removedThreadIds: [],
      counts: [],
    })
    expect(ids(qc, inbox)).toEqual([])
    expect(ids(qc, sent)).toEqual(["a"])
    expect(qc.getQueryData<ThreadDetail>(mailKeys.thread("mbx", "a"))?.thread.starred).toBe(true)
  })

  it("drafts.changed updates the drafts lists and the thread's drafts", () => {
    const { qc } = setup()
    const d = (id: string, status: Draft["status"]) => ({ id, threadId: "a", status, updatedAt: T0 }) as Draft
    qc.setQueryData(mailKeys.drafts("mbx", "scheduled"), { drafts: [] })
    qc.setQueryData<ThreadDetail>(mailKeys.thread("mbx", "a"), {
      thread: thread("a"),
      messages: [],
      drafts: [d("d1", "draft")],
      notes: [],
    } as unknown as ThreadDetail)
    applyFrame(qc, "mbx", {
      type: "drafts.changed",
      seq: 3,
      drafts: [d("d1", "scheduled")],
      removedDraftIds: [],
    })
    expect(
      qc.getQueryData<{ drafts: Draft[] }>(mailKeys.drafts("mbx", "scheduled"))?.drafts.map((x) => x.id),
    ).toEqual(["d1"])
    expect(qc.getQueryData<ThreadDetail>(mailKeys.thread("mbx", "a"))?.drafts[0]?.status).toBe("scheduled")
  })

  it("delivery.changed updates the sent copy's per-recipient table", () => {
    const { qc } = setup()
    const key = mailKeys.message("mbx", "snt_1")
    qc.setQueryData(key, {
      id: "snt_1",
      delivery: { status: "sent", recipients: [{ recipient: "a@x", status: "sent" }] },
    } as unknown as MessageDetail)
    applyFrame(qc, "mbx", {
      type: "delivery.changed",
      seq: 4,
      messageId: "snt_1",
      logId: "log",
      recipients: [{ recipient: "a@x", status: "bounced" }],
    })
    expect(qc.getQueryData<MessageDetail>(key)?.delivery?.recipients[0]?.status).toBe("bounced")
  })

  it("notes.changed names known authors; labels.changed refreshes the folder pane's labels", () => {
    const { qc } = setup()
    qc.setQueryData<ThreadDetail>(mailKeys.thread("mbx", "a"), {
      thread: thread("a"),
      messages: [],
      drafts: [],
      notes: [{ id: "n1", body: "x", createdAt: T0, author: { id: "k1", name: "Kemi" } }],
    } as unknown as ThreadDetail)
    applyFrame(qc, "mbx", {
      type: "notes.changed",
      seq: 5,
      threadId: "a",
      notes: [
        { id: "n1", author: "k1", body: "x", createdAt: T0 },
        { id: "n2", author: "k1", body: "y", createdAt: T0 },
      ],
    })
    expect(
      qc.getQueryData<ThreadDetail>(mailKeys.thread("mbx", "a"))?.notes.map((n) => n.author.name),
    ).toEqual(["Kemi", "Kemi"])
    qc.setQueryData<FoldersBody>(mailKeys.folders("mbx"), {
      folders: [],
      labels: [],
      smartFolders: [],
      views: {},
    } as unknown as FoldersBody)
    applyFrame(qc, "mbx", {
      type: "labels.changed",
      seq: 6,
      labels: [{ id: "l1", name: "billing", color: "blue" }],
    })
    expect(qc.getQueryData<FoldersBody>(mailKeys.folders("mbx"))?.labels.map((l) => l.name)).toEqual([
      "billing",
    ])
  })
})

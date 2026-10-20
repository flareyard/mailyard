import { describe, expect, it } from "vitest"
import {
  agentFor,
  applyDraftsToDetail,
  applyDraftsToList,
  applyNotesToDetail,
  applyThreadsToPages,
  authChips,
  authWarning,
  buildSrcdoc,
  bulkWords,
  counterpart,
  deliveryCounts,
  expandedByDefault,
  fileExt,
  fileSize,
  forwardSubject,
  hasPerm,
  highlightRuns,
  initials,
  inverseBulk,
  listSearchString,
  mailAccess,
  mailKey,
  namesLine,
  operatorSuggestions,
  optimisticThread,
  rangeSelect,
  readerTime,
  remoteImageCount,
  removeOperator,
  replySubject,
  rowTime,
  snoozePresets,
  stripMarks,
  textBlocks,
  threadMatches,
  utcFromInputs,
  utcShort,
  utcStamp,
  validateListSearch,
  validateReaderSearch,
} from "./logic.ts"
import type { Agent, Draft, MessageSummary, Thread, ThreadDetail, ThreadPage } from "./types.ts"

const T0 = Date.UTC(2026, 9, 17, 17, 48) // Sat 17 Oct 2026, 17:48 UTC

const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
  id,
  subject: `Subject ${id}`,
  snippet: "…",
  latestMessageId: `msg_${id}`,
  messageCount: 1,
  unreadCount: 0,
  starred: false,
  hasAttachments: false,
  participants: [{ name: "Ada Okafor", address: "ada@gmail.com" }],
  folders: ["inbox"],
  labelIds: [],
  firstAt: T0,
  lastAt: T0,
  sortAt: T0,
  snoozedUntil: null,
  assignee: null,
  assignedTo: null,
  scheduledSendAt: null,
  ...over,
})

const pages = (
  threads: Thread[],
  total: number | null = threads.length,
  nextCursor: string | null = null,
) => ({
  pages: [{ threads, total, nextCursor } as ThreadPage],
  pageParams: [undefined],
})

describe("the list URL", () => {
  it("keeps inbox out of the URL and round-trips every filter", () => {
    const q = validateListSearch({
      folder: "sent",
      labelId: "lbl_1",
      unread: "true",
      starred: true,
      assignee: "key_1",
      att: "1",
      q: " from:ada ",
      sort: "relevance",
    })
    expect(q).toEqual({
      folder: "sent",
      labelId: "lbl_1",
      unread: true,
      starred: true,
      assignee: "key_1",
      att: true,
      q: "from:ada",
      sort: "relevance",
    })
    expect(validateListSearch(Object.fromEntries(new URLSearchParams(listSearchString(q))))).toEqual(q)
    expect(validateListSearch({ folder: "inbox" })).toEqual({})
    expect(validateListSearch({ folder: "nope", unread: "no" })).toEqual({})
    expect(listSearchString({})).toBe("")
  })

  it("reads the reader's drawers and views from the URL", () => {
    expect(
      validateReaderSearch({
        raw: "m1",
        details: "m2",
        tab: "spam",
        dlv: "m3",
        rcpt: "a@b.c",
        preview: "m1:att",
        reply: "replyAll",
      }),
    ).toEqual({
      raw: "m1",
      details: "m2",
      tab: "spam",
      dlv: "m3",
      rcpt: "a@b.c",
      preview: "m1:att",
      reply: "replyAll",
    })
    expect(validateReaderSearch({ tab: "x", reply: "nope" })).toEqual({})
  })
})

describe("threadMatches", () => {
  it("applies the server's folder rules", () => {
    expect(threadMatches(thread("a"), {})).toBe(true)
    expect(threadMatches(thread("a", { folders: ["archive"] }), {})).toBe(false)
    expect(threadMatches(thread("a", { folders: ["archive"] }), { folder: "all" })).toBe(true)
    expect(threadMatches(thread("a", { folders: ["spam"] }), { folder: "all" })).toBe(false)
    expect(threadMatches(thread("a", { folders: ["archive"], starred: true }), { starred: true })).toBe(true)
    expect(threadMatches(thread("a", { labelIds: ["l1"] }), { labelId: "l1" })).toBe(true)
    expect(threadMatches(thread("a"), { labelId: "l1" })).toBe(false)
    expect(threadMatches(thread("a"), { unread: true })).toBe(false)
    expect(threadMatches(thread("a", { unreadCount: 2 }), { unread: true })).toBe(true)
    expect(threadMatches(thread("a", { assignee: "k" }), { assignee: "k" })).toBe(true)
  })
})

describe("live frames on the cache", () => {
  it("slides a new thread in by sortAt and counts it", () => {
    const old = pages([thread("b", { sortAt: T0 - 1000 })], 10)
    const next = applyThreadsToPages(old, {}, [thread("a", { sortAt: T0 })], [])
    expect(next?.pages[0]?.threads.map((t) => t.id)).toEqual(["a", "b"])
    expect(next?.pages[0]?.total).toBe(11)
  })

  it("moves a changed thread out of a list it no longer matches, and removes removed ids", () => {
    const old = pages([thread("a"), thread("b"), thread("c")], 3)
    const next = applyThreadsToPages(old, {}, [thread("b", { folders: ["archive"] })], ["c"])
    expect(next?.pages[0]?.threads.map((t) => t.id)).toEqual(["a"])
    expect(next?.pages[0]?.total).toBe(1)
  })

  it("updates a thread in place and leaves other lists alone", () => {
    const old = pages([thread("a")], null)
    const next = applyThreadsToPages(old, {}, [thread("a", { unreadCount: 3 })], [])
    expect(next?.pages[0]?.threads[0]?.unreadCount).toBe(3)
    expect(next?.pages[0]?.total).toBeNull()
    expect(applyThreadsToPages(undefined, {}, [thread("a")], [])).toBeUndefined()
  })

  it("never puts a thread on page one that sorts below what's loaded when more pages exist", () => {
    const old = pages([thread("a", { sortAt: T0 })], 100, "cursor")
    const next = applyThreadsToPages(old, {}, [thread("z", { sortAt: T0 - 999_999 })], [])
    expect(next?.pages[0]?.threads.map((t) => t.id)).toEqual(["a"])
  })

  const draft = (id: string, over: Partial<Draft> = {}): Draft =>
    ({
      id,
      threadId: "t1",
      status: "draft",
      updatedAt: T0,
      subject: "",
      bodyText: "",
      to: [],
      cc: [],
      bcc: [],
      attachments: [],
      ...over,
    }) as Draft

  it("keeps the drafts lists and the open thread's drafts current", () => {
    const list = { drafts: [draft("d1"), draft("d2", { status: "scheduled" })] }
    expect(
      applyDraftsToList(list, "draft", [draft("d3", { updatedAt: T0 + 1 })], ["d1"])?.drafts.map((d) => d.id),
    ).toEqual(["d3", "d2"])
    expect(applyDraftsToList(list, "scheduled", [draft("d3")], [])?.drafts.map((d) => d.id)).toEqual([
      "d1",
      "d2",
    ])
    const detail = {
      thread: thread("t1"),
      messages: [],
      drafts: [draft("d1")],
      notes: [],
    } as unknown as ThreadDetail
    expect(applyDraftsToDetail(detail, [draft("d9", { threadId: "other" })], [])).toBe(detail)
    expect(applyDraftsToDetail(detail, [draft("d2")], ["d1"])?.drafts.map((d) => d.id)).toEqual(["d2"])
  })

  it("names note authors it knows and says when it doesn't", () => {
    const detail = {
      thread: thread("t1"),
      messages: [],
      drafts: [],
      notes: [{ id: "n1", body: "x", createdAt: T0, author: { id: "k1", name: "Kemi" } }],
    } as unknown as ThreadDetail
    const known = applyNotesToDetail(detail, "t1", [{ id: "n2", author: "k1", body: "y", createdAt: T0 }])
    expect(known.detail?.notes[0]?.author).toEqual({ id: "k1", name: "Kemi" })
    expect(known.unknownAuthor).toBe(false)
    expect(
      applyNotesToDetail(detail, "t1", [{ id: "n3", author: "k9", body: "z", createdAt: T0 }]).unknownAuthor,
    ).toBe(true)
    expect(applyNotesToDetail(detail, "other", []).detail).toBe(detail)
  })
})

describe("search", () => {
  it("turns \\u0002…\\u0003 into marked runs", () => {
    expect(highlightRuns("Re: \u0002Payment\u0003 didn’t go")).toEqual([
      { text: "Re: ", hit: false },
      { text: "Payment", hit: true },
      { text: " didn’t go", hit: false },
    ])
    expect(stripMarks("\u0002a\u0003b")).toBe("ab")
    expect(highlightRuns("")).toEqual([])
  })

  it("removes one operator, quoted or not, and suggests operators as you type", () => {
    expect(removeOperator("payment after:2026-10-01 in:inbox", "after", "2026-10-01")).toBe(
      "payment in:inbox",
    )
    expect(removeOperator('subject:"payment link" x', "subject", "payment link")).toBe("x")
    expect(operatorSuggestions("refund fro").map((o) => o.op)).toEqual(["from:"])
    expect(operatorSuggestions("from:ada")).toEqual([])
    expect(operatorSuggestions("")).toEqual([])
  })
})

describe("people", () => {
  const ours = new Set(["support@coursified.app"])
  it("shows the mailbox as us, once, and picks the other side for the avatar", () => {
    const ps = [
      { name: "Ada Okafor", address: "ada@gmail.com" },
      { name: "Coursified support", address: "support@coursified.app" },
      { name: null, address: "SUPPORT@coursified.app" },
    ]
    expect(namesLine(ps, ours)).toEqual([
      { name: "Ada Okafor", us: false },
      { name: "us", us: true },
    ])
    expect(counterpart(ps, ours)?.address).toBe("ada@gmail.com")
    expect(initials("Ada Okafor")).toBe("AO")
    expect(initials(null, "kemi.bello@x.com")).toBe("KB")
    expect(initials("Hermes")).toBe("HE")
  })
})

describe("times (UTC)", () => {
  it("formats rows, the reader's stamp and short picker times", () => {
    expect(rowTime(T0 - 30_000, T0)).toBe("now")
    expect(rowTime(T0 - 2 * 60_000, T0)).toBe("2 min")
    expect(rowTime(T0 - 5 * 3600_000, T0)).toBe("5 h")
    expect(rowTime(T0 - 3 * 86_400_000, T0)).toBe("3 d")
    expect(rowTime(Date.UTC(2026, 9, 2, 9), T0)).toBe("2 Oct")
    expect(rowTime(Date.UTC(2025, 9, 2, 9), T0)).toBe("2 Oct 2025")
    expect(utcStamp(T0)).toBe("Sat 17 Oct, 17:48 UTC")
    expect(readerTime(T0 - 2 * 60_000, T0)).toBe("Sat 17 Oct, 17:46 UTC · 2 min ago")
    expect(utcShort(Date.UTC(2026, 9, 18, 8))).toBe("Sun 08:00 UTC")
  })

  it("offers the designed snooze presets (Sat 17:46 → 21:00, Sun 08:00, Mon 08:00, next Mon)", () => {
    const p = snoozePresets(Date.UTC(2026, 9, 17, 17, 46))
    expect(p.map((x) => [x.label, utcShort(x.until)])).toEqual([
      ["Later today", "Sat 21:00 UTC"],
      ["Tomorrow morning", "Sun 08:00 UTC"],
      ["Monday morning", "Mon 08:00 UTC"],
      ["Next week", "Mon 08:00 UTC"],
    ])
    expect(new Date(p[3]?.until ?? 0).getUTCDate()).toBe(26)
    // Late on a Sunday: no "later today", and Monday morning is tomorrow (not listed twice).
    const sun = snoozePresets(Date.UTC(2026, 9, 18, 22))
    expect(sun.map((x) => x.label)).toEqual(["Tomorrow morning", "Next week"])
  })

  it("reads a typed UTC date and time", () => {
    expect(utcFromInputs("2026-10-21", "09:00")).toBe(Date.UTC(2026, 9, 21, 9))
    expect(utcFromInputs("21/10/2026", "09:00")).toBeNull()
    expect(utcFromInputs("2026-10-21", "9")).toBeNull()
  })
})

describe("files", () => {
  it("sizes and labels attachments", () => {
    expect(fileSize(900)).toBe("900 B")
    expect(fileSize(217_088)).toBe("212 KB")
    expect(fileSize(5 * 1024 * 1024)).toBe("5 MB")
    expect(fileSize(1.25 * 1024 ** 3)).toBe("1.3 GB")
    expect(fileExt("statement-oct-17.pdf", "application/pdf")).toBe("PDF")
    expect(fileExt(null, "image/png")).toBe("PNG")
  })
})

describe("the authentication line", () => {
  const msg = (auth: MessageSummary["auth"]) => auth
  it("orders SPF, DKIM, DMARC, ARC with their details", () => {
    const chips = authChips(
      msg({
        source: "cloudflare",
        spf: "pass",
        dmarc: "pass",
        dkim: [{ result: "pass", domain: "gmail.com", selector: "s" }],
        arc: { result: "pass", instance: 1, sealer: "google.com" },
      }),
    )
    expect(chips.map((c) => `${c.label} ${c.result} ${c.sub ?? ""}`.trim())).toEqual([
      "SPF pass",
      "DKIM pass d=gmail.com",
      "DMARC pass",
      "ARC pass i=1 · google.com",
    ])
    expect(chips.every((c) => c.tone === "pass")).toBe(true)
  })

  it("warns in plain words, and says when ARC vouches for a forwarded message", () => {
    const fwd = msg({
      source: "cloudflare",
      spf: "softfail",
      dmarc: "fail",
      dkim: [{ result: "fail", domain: "x.com", selector: null }],
      arc: { result: "pass", instance: 1, sealer: "lists.x.com" },
    })
    expect(authWarning(fwd)).toMatch(/DKIM and DMARC failed, but ARC passed/)
    const bad = msg({ source: "cloudflare", spf: "fail", dmarc: "fail", dkim: [], arc: null })
    expect(authWarning(bad)).toMatch(/may not be from who it says/)
    expect(
      authWarning(msg({ source: "cloudflare", spf: "pass", dmarc: "pass", dkim: [], arc: null })),
    ).toBeNull()
  })
})

describe("delivery", () => {
  it("counts recipients by status with their tone", () => {
    expect(
      deliveryCounts([
        { status: "delivered" },
        { status: "deferred" },
        { status: "bounced" },
        { status: "delivered" },
      ]),
    ).toEqual([
      { status: "delivered", n: 2, tone: "pass" },
      { status: "deferred", n: 1, tone: "warn" },
      { status: "bounced", n: 1, tone: "fail" },
    ])
  })
})

describe("agents", () => {
  const agent = (over: Partial<Agent>): Agent =>
    ({
      id: "agt",
      name: "Hermes",
      mailbox: { id: "mbx_h", address: "h@x" },
      key: null,
      limits: null,
      sentToday: 0,
      pendingApprovals: 0,
      createdAt: 0,
      removedAt: null,
      ...over,
    }) as Agent
  it("finds the live agent that owns a mailbox", () => {
    expect(agentFor("mbx_h", [agent({})])?.name).toBe("Hermes")
    expect(agentFor("mbx_h", [agent({ removedAt: 5 })])).toBeUndefined()
    expect(agentFor("mbx_other", [agent({})])).toBeUndefined()
    expect(agentFor("mbx_h", undefined)).toBeUndefined()
  })
})

describe("selection and keys", () => {
  it("range-selects between the anchor and the clicked row", () => {
    expect(rangeSelect(["a", "b", "c", "d"], "b", "d")).toEqual(["b", "c", "d"])
    expect(rangeSelect(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "c", "d"])
    expect(rangeSelect(["a", "b"], null, "b")).toEqual(["b"])
  })

  it("maps the contract's keys", () => {
    const k = (key: string, shiftKey = false, metaKey = false) =>
      mailKey({ key, shiftKey, metaKey, ctrlKey: false, altKey: false })
    expect([
      k("j"),
      k("k"),
      k("e"),
      k("#"),
      k("s"),
      k("l"),
      k("v"),
      k("a"),
      k("r"),
      k("f"),
      k("/"),
      k("x"),
      k("n"),
      k("u"),
      k("Enter"),
    ]).toEqual([
      "next",
      "prev",
      "archive",
      "delete",
      "snooze",
      "label",
      "move",
      "assign",
      "reply",
      "forward",
      "search",
      "select",
      "note",
      "back",
      "open",
    ])
    expect([
      k("R", true),
      k("S", true),
      k("U", true),
      k("I", true),
      k("X", true),
      k("?", true),
      k("!", true),
    ]).toEqual(["replyAll", "star", "unread", "read", "selectAll", "help", "spam"])
    expect(k("k", false, true)).toBeNull()
    expect(k("q")).toBeNull()
  })
})

describe("bulk actions", () => {
  it("predicts the thread after each action", () => {
    const t = thread("a", { unreadCount: 2, labelIds: ["l1"] })
    expect(optimisticThread(t, "archive")?.folders).toEqual(["archive"])
    expect(optimisticThread(t, "snooze", { until: 5 })).toMatchObject({
      folders: ["snoozed"],
      snoozedUntil: 5,
    })
    expect(optimisticThread(t, "read")?.unreadCount).toBe(0)
    expect(optimisticThread(thread("b"), "unread")?.unreadCount).toBe(1)
    expect(optimisticThread(t, "label", { labelId: "l2" })?.labelIds).toEqual(["l1", "l2"])
    expect(optimisticThread(t, "unlabel", { labelId: "l1" })?.labelIds).toEqual([])
    expect(optimisticThread(t, "assign", { assignee: "k1", assigneeName: "Kemi" })?.assignedTo).toEqual({
      id: "k1",
      name: "Kemi",
    })
    expect(optimisticThread(t, "delete")).toBeNull()
    expect(optimisticThread(t, "move", { folder: "trash" })?.folders).toEqual(["trash"])
  })

  it("undoes by putting each thread back where it was", () => {
    const a = thread("a", { folders: ["inbox"] })
    const b = thread("b", { folders: ["snoozed"] })
    expect(inverseBulk([a, b], "archive")).toEqual([
      { action: "move", threadIds: ["a"], extra: { folder: "inbox" } },
      { action: "move", threadIds: ["b"], extra: { folder: "snoozed" } },
    ])
    expect(inverseBulk([a], "delete")).toBeNull()
    expect(inverseBulk([thread("c", { unreadCount: 1 }), thread("d")], "read")).toEqual([
      { action: "unread", threadIds: ["c"], extra: {} },
    ])
    expect(
      inverseBulk([thread("c", { assignee: "k1", assignedTo: { id: "k1", name: "Kemi" } })], "assign", {
        assignee: "k2",
      }),
    ).toEqual([{ action: "assign", threadIds: ["c"], extra: { assignee: "k1", assigneeName: "Kemi" } }])
  })

  it("says what happened", () => {
    expect(bulkWords("archive", 3)).toBe("Archived 3 conversations")
    expect(bulkWords("trash", 1)).toBe("Moved conversation to Trash")
    expect(bulkWords("label", 2, {}, "billing")).toBe("Labelled 2 conversations billing")
    expect(bulkWords("assign", 1, { assignee: "k", assigneeName: "Kemi" })).toBe(
      "Assigned conversation to Kemi",
    )
  })
})

describe("access", () => {
  const me = (over: Record<string, unknown>) =>
    ({
      role: null,
      via: "session-key",
      scopes: [] as string[],
      permissions: [] as string[],
      mailboxes: null,
      ...over,
    }) as Parameters<typeof mailAccess>[0]
  it("judges by permissions, then role, then the key's scopes", () => {
    expect(hasPerm(me({ via: "admin-key" }), "mail.manage")).toBe(true)
    expect(hasPerm(me({ permissions: ["mail.read"] }), "mail.send")).toBe(false)
    expect(hasPerm(me({ role: "agent" }), "mail.send")).toBe(true)
    expect(hasPerm(me({ role: "agent" }), "mail.manage")).toBe(false)
    expect(hasPerm(me({ scopes: ["read", "send"] }), "mail.send")).toBe(true)
    expect(hasPerm(undefined, "mail.read")).toBe(false)
  })

  it("makes a mailbox viewer read-only, naming who can change it", () => {
    const a = mailAccess(
      me({ role: "sender", mailboxes: [{ id: "mbx_1", address: "x@y", access: "viewer" }] }),
      "mbx_1",
    )
    expect(a.read).toBe(true)
    expect(a.write).toBe(false)
    expect(a.writeReason).toMatch(/read this mailbox but not reply/)
    expect(mailAccess(me({ role: "owner" }), "mbx_1")).toMatchObject({ write: true, manage: true })
    expect(mailAccess(me({ scopes: ["read"] }), "mbx_1").writeWho).toMatch(/send scope/)
  })
})

describe("the sandboxed body", () => {
  it("strips scripts, handlers and forms, points cid: at signed links and blocks remote images until asked", () => {
    const html =
      '<p onclick="x()">Hi</p><script>alert(1)</script><form action="/x"><input></form><img src="cid:logo"><img src="https://t.example/p.gif"><a href="javascript:alert(1)">x</a>'
    const doc = buildSrcdoc(html, { showImages: false, cid: { logo: "/v1/files/tok" }, tokensCss: ":root{}" })
    expect(doc).not.toMatch(/<script|onclick|<form|javascript:/i)
    expect(doc).toContain('src="/v1/files/tok"')
    expect(doc).toContain("img-src data: 'self';")
    expect(doc).toContain("script-src 'none'")
    expect(doc).toContain('<base target="_blank">')
    expect(buildSrcdoc(html, { showImages: true, cid: {}, tokensCss: "" })).toContain(
      "img-src data: 'self' https: http:",
    )
    expect(remoteImageCount(html)).toBe(1)
    expect(remoteImageCount('<div style="background:url(https://x/y.png)">')).toBe(1)
  })

  it("groups quoted lines, and opens the newest and unread messages", () => {
    expect(textBlocks("Hi Ada,\n\nThanks.\n\n> earlier\n> text\n\n> more")).toEqual([
      { kind: "p", text: "Hi Ada," },
      { kind: "p", text: "Thanks." },
      { kind: "quote", text: "earlier\ntext\n\nmore" },
    ])
    expect([
      ...expandedByDefault([
        { id: "a", seen: false },
        { id: "b", seen: true },
        { id: "c", seen: true },
      ]),
    ]).toEqual(["c", "a"])
  })

  it("prefixes reply and forward subjects once", () => {
    expect(replySubject("Re: Hello")).toBe("Re: Hello")
    expect(replySubject("Hello")).toBe("Re: Hello")
    expect(forwardSubject("Fwd: Hi")).toBe("Fwd: Hi")
    expect(forwardSubject("Hi")).toBe("Fwd: Hi")
  })
})

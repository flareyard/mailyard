import { describe, expect, it } from "vitest"
import { RULES } from "./fixtures.ts"
import {
  actionPart,
  applyImportProgress,
  conditionMatches,
  conditionWords,
  durationWords,
  etaWords,
  expiryWords,
  exportPct,
  folderProgress,
  folderState,
  importProgress,
  keyword,
  matchWords,
  moveItem,
  prefillFromMessage,
  type RuleMessage,
  retryableCount,
  ruleMatches,
  ruleProblem,
  senderValue,
  sendsWords,
  withDraftRule,
} from "./logic.ts"
import type { MailImport } from "./types.ts"

const NOW = Date.UTC(2026, 9, 17, 17, 46)

const msg = (over: Partial<RuleMessage> = {}): RuleMessage => ({
  subject: "Re: Payment didn’t go through",
  from: { name: "Ada Okafor", address: "Ada.Okafor@gmail.com" },
  listId: null,
  tag: null,
  to: [{ address: "support@coursified.app" }],
  cc: [],
  snippet: "I tried again this afternoon",
  automated: false,
  attachments: [{}],
  ...over,
})

describe("rules in words", () => {
  it("says each condition the way the rules list reads", () => {
    expect(conditionWords({ field: "subject", op: "contains", value: "invoice" })).toEqual({
      k: "subject contains",
      v: "invoice",
    })
    expect(conditionWords({ field: "from", op: "endsWith", value: ".icu" })).toEqual({
      k: "from ends with",
      v: ".icu",
    })
    expect(conditionWords({ field: "tag", op: "equals", value: "app-feedback" })).toEqual({
      k: "tag is",
      v: "app-feedback",
    })
    expect(conditionWords({ field: "automated", value: true })).toEqual({ k: "is automated" })
    expect(conditionWords({ field: "hasAttachment", value: false })).toEqual({ k: "has no attachment" })
  })
  it("turns actions into parts: labels, keys, key-value and plain words", () => {
    expect(actionPart({ type: "label", labelId: "lbl_1" })).toEqual({ kind: "label", labelId: "lbl_1" })
    expect(actionPart({ type: "assign", assignee: "key_1" })).toEqual({ kind: "assign", keyId: "key_1" })
    expect(actionPart({ type: "forward", to: ["a@x.co", "b@x.co"] })).toEqual({
      kind: "kv",
      k: "forward to",
      v: "a@x.co, b@x.co",
    })
    expect(actionPart({ type: "spam" })).toEqual({ kind: "text", text: "mark as spam" })
    expect(actionPart({ type: "markRead" })).toEqual({ kind: "text", text: "mark read" })
  })
  it("counts matches and says when the last one was", () => {
    expect(matchWords(212, NOW - 2 * 60_000, NOW)).toEqual({ count: "212 matches", last: "last 2 min ago" })
    expect(matchWords(1, NOW - 3 * 3600_000, NOW)).toEqual({ count: "1 match", last: "last 3 h ago" })
    expect(matchWords(0, null, NOW)).toEqual({ count: "0 matches", last: "never matched" })
  })
})

describe("a rule from a message", () => {
  it("picks a subject word worth matching", () => {
    expect(keyword("Re: Payment didn’t go through")).toBe("payment")
    expect(keyword("Fwd: Re: the big invoice")).toBe("invoice")
    expect(keyword("Re: hi")).toBeNull()
  })
  it("matches a freemail sender by address and a company by domain", () => {
    const fromGmail = prefillFromMessage(msg())
    expect(fromGmail.conditions).toEqual([
      { field: "from", op: "equals", value: "ada.okafor@gmail.com" },
      { field: "subject", op: "contains", value: "payment" },
    ])
    expect(fromGmail.name).toBe("Payment from Ada Okafor")
    const fromCompany = prefillFromMessage(
      msg({ from: { name: "Ibrahim", address: "ibrahim@musaanalytics.ng" }, subject: "Team plan" }),
    )
    expect(fromCompany.conditions[0]).toEqual({ field: "from", op: "endsWith", value: "@musaanalytics.ng" })
    expect(fromCompany.name).toBe("Team from musaanalytics.ng")
  })
  it("prefers the mailing list when there is one", () => {
    const r = prefillFromMessage(msg({ listId: "<news.example.com>" }))
    expect(r.conditions[0]).toEqual({ field: "listId", op: "equals", value: "<news.example.com>" })
  })
  it("checks a rule against the message as the server would", () => {
    const m = msg()
    expect(conditionMatches({ field: "from", op: "endsWith", value: "@GMAIL.com" }, m)).toBe(true)
    expect(conditionMatches({ field: "subject", op: "notContains", value: "refund" }, m)).toBe(true)
    expect(conditionMatches({ field: "hasAttachment", value: true }, m)).toBe(true)
    expect(conditionMatches({ field: "recipients", op: "equals", value: "support@coursified.app" }, m)).toBe(
      true,
    )
    const conds = prefillFromMessage(m).conditions
    expect(ruleMatches("all", conds, m)).toBe(true)
    expect(ruleMatches("all", [...conds, { field: "automated", value: true }], m)).toBe(false)
    expect(ruleMatches("any", [...conds, { field: "automated", value: true }], m)).toBe(true)
    expect(ruleMatches("all", [], m)).toBe(false)
  })
  it("says what's missing before saving", () => {
    const base = prefillFromMessage(msg())
    expect(ruleProblem(base)).toBe("Add at least one action.")
    expect(ruleProblem({ ...base, actions: [{ type: "label", labelId: "" }] })).toBe("Choose a label.")
    expect(ruleProblem({ ...base, actions: [{ type: "forward", to: ["nope"] }] })).toBe(
      "Forward needs an address.",
    )
    expect(ruleProblem({ ...base, name: " " })).toBe("Give the rule a name.")
    expect(ruleProblem({ ...base, actions: [{ type: "archive" }] })).toBeNull()
  })
  it("adds the unsaved rule's effect to the server's test, unless a rule stopped the run", () => {
    const server = {
      matched: ["rul_01"],
      folder: null,
      labelIds: ["lbl_billing"],
      markRead: false,
      star: false,
      skipSpamCheck: false,
      forwards: [],
      autoReplies: [],
      webhooks: [],
      assignee: null,
      stoppedAt: null,
    }
    const o = withDraftRule(server, {
      id: "draft",
      matches: true,
      actions: [
        { type: "label", labelId: "lbl_billing" },
        { type: "assign", assignee: "key_1" },
        { type: "archive" },
      ],
      stop: true,
    })
    expect(o).toMatchObject({
      matched: ["rul_01", "draft"],
      labelIds: ["lbl_billing"],
      assignee: "key_1",
      folder: "archive",
      stoppedAt: "draft",
      draftRan: true,
    })
    expect(
      withDraftRule(
        { ...server, stoppedAt: "rul_01" },
        { id: "draft", matches: true, actions: [{ type: "star" }], stop: false },
      ).draftRan,
    ).toBe(false)
    expect(sendsWords(o)).toBe("No forwards, auto-replies or webhooks")
    expect(
      sendsWords({
        forwards: [{ ruleId: "r", to: ["a@x.co"] }],
        autoReplies: [],
        webhooks: [{ ruleId: "r", endpointId: "whk_1" }],
      }),
    ).toBe("forward to a@x.co; webhook whk_1")
  })
})

describe("reorder", () => {
  it("moves one item and leaves out-of-range moves alone", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"])
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"])
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"])
    expect(moveItem(RULES.rules, 4, 3).map((r) => r.id)).toEqual([
      "rul_01",
      "rul_02",
      "rul_03",
      "rul_05",
      "rul_04",
    ])
  })
})

describe("senders", () => {
  it("takes an address or a domain and refuses anything else", () => {
    expect(senderValue(" Ada@Gmail.com ")).toBe("ada@gmail.com")
    expect(senderValue("@example.co.uk")).toBe("example.co.uk")
    expect(senderValue("not a sender")).toBeNull()
    expect(senderValue("localhost")).toBeNull()
  })
})

const imp = (over: Partial<MailImport> = {}): MailImport => ({
  id: "imp_1",
  source: "imap",
  mode: "full",
  host: "imap.gmail.com",
  port: 993,
  username: "a@gmail.com",
  status: "running",
  error: null,
  folders: [
    {
      name: "INBOX",
      folder: "inbox",
      label: null,
      uidValidity: 1,
      source: 4210,
      imported: 4210,
      duplicates: 12,
      failed: 0,
      skipped: 0,
      lastUid: 1,
      batches: 43,
      batchesDone: 43,
      lastError: null,
      retryable: 0,
    },
    {
      name: "Sent",
      folder: "sent",
      label: null,
      uidValidity: 1,
      source: 2186,
      imported: 1302,
      duplicates: 0,
      failed: 3,
      skipped: 0,
      lastUid: 1,
      batches: 22,
      batchesDone: 14,
      lastError: "too big",
      retryable: 2,
    },
    {
      name: "Spam",
      folder: "spam",
      label: null,
      uidValidity: 1,
      source: 58,
      imported: 0,
      duplicates: 0,
      failed: 0,
      skipped: 58,
      lastUid: 0,
      batches: 0,
      batchesDone: 0,
      lastError: null,
      retryable: 0,
    },
    {
      name: "Receipts",
      folder: "archive",
      label: "receipts",
      uidValidity: 1,
      source: 640,
      imported: 0,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      lastUid: 0,
      batches: 7,
      batchesDone: 0,
      lastError: null,
      retryable: 0,
    },
  ],
  totals: { source: 7094, imported: 5512, duplicates: 12, failed: 3, skipped: 58 },
  accountedFor: false,
  ratePerMinute: 212,
  etaAt: NOW + 8 * 60_000,
  startedAt: NOW - 26 * 60_000,
  pausedAt: null,
  catchupOf: null,
  since: null,
  retryOf: null,
  credentialsHeld: true,
  createdAt: NOW - 26 * 60_000,
  finishedAt: null,
  ...over,
})

describe("import arithmetic", () => {
  it("counts everything accounted for: copied, duplicates, failed and skipped", () => {
    expect(importProgress(imp())).toMatchObject({ done: 5585, pct: 79, source: 7094 })
    expect(
      importProgress(imp({ totals: { source: 0, imported: 0, duplicates: 0, failed: 0, skipped: 0 } })).pct,
    ).toBe(0)
  })
  it("gives each folder its progress and state", () => {
    const [inbox, sent, spam, receipts] = imp().folders
    expect(inbox && folderProgress(inbox)).toBe(100)
    expect(inbox && folderState(inbox, "running").label).toBe("Done")
    expect(sent && folderState(sent, "running").label).toBe("Copying")
    expect(spam && folderState(spam, "running").label).toBe("Skipped")
    expect(receipts && folderState(receipts, "running").label).toBe("Waiting")
    expect(sent && folderState(sent, "paused").label).toBe("Paused")
    expect(sent && folderState(sent, "failed").tone).toBe("fail")
  })
  it("says the ETA and durations in UTC", () => {
    expect(etaWords(NOW + 8 * 60_000, NOW)).toBe("done about 17:54 UTC, in 0 h 08 min")
    expect(etaWords(null, NOW)).toBeNull()
    expect(durationWords(NOW - 23 * 60_000, NOW)).toBe("23 min")
    expect(durationWords(NOW - 65 * 60_000, NOW)).toBe("1 h 05 min")
  })
  it("adds up what a retry can fetch", () => {
    expect(retryableCount(imp())).toBe(2)
  })
  it("merges an import.progress frame into the import it names, and only that one", () => {
    const next = applyImportProgress(imp(), {
      type: "import.progress",
      importId: "imp_1",
      status: "running",
      totals: { source: 7094, imported: 6000, duplicates: 12, failed: 3, skipped: 58 },
      ratePerMinute: 250,
      etaAt: NOW,
      folders: [{ name: "Sent", imported: 1790 }],
    })
    expect(next.totals.imported).toBe(6000)
    expect(next.ratePerMinute).toBe(250)
    expect(next.folders[1]?.imported).toBe(1790)
    expect(next.folders[1]?.lastError).toBe("too big")
    const other = imp()
    expect(applyImportProgress(other, { importId: "imp_2", status: "failed" })).toBe(other)
  })
})

describe("export", () => {
  it("says until when the links work, or that they stopped", () => {
    expect(expiryWords({ downloadsExpireAt: Date.UTC(2026, 9, 18, 17, 8) }, NOW)).toBe(
      "Links work until Sun 18 Oct, 17:08 UTC; after that, Export again makes fresh ones.",
    )
    expect(expiryWords({ downloadsExpireAt: NOW - 1000 }, NOW)).toMatch(/^These links stopped working/)
    expect(expiryWords({ downloadsExpireAt: null }, NOW)).toBeNull()
  })
  it("works out the share written when the mailbox's size is known", () => {
    expect(exportPct({ messageCount: 1904 }, 2756)).toBe(69)
    expect(exportPct({ messageCount: 10 }, null)).toBeNull()
  })
})

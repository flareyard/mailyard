import { describe, expect, it } from "vitest"
import {
  checksPassing,
  contactProgressLine,
  countsSentence,
  currentStep,
  type DomainCheck,
  type DomainLike,
  defaultFolderSelection,
  deriveSteps,
  doneCount,
  ENABLE_WATCH_MS,
  enablePhase,
  fieldKeyFor,
  fmtBytes,
  fmtLeft,
  fmtUtc,
  guessMapping,
  landsIn,
  type MappingRow,
  mailRateLine,
  nameserversOnCloudflare,
  normalizeDomain,
  parseSetupMemory,
  pickDomain,
  pickMailbox,
  previewCsv,
  progressPct,
  requiredDone,
  rowState,
  type SetupFacts,
  selectedMessages,
  showChecklist,
  stepSub,
  testStatus,
  testSummary,
  testVerdict,
  toImportMapping,
  validateLocalPart,
  validateMapping,
} from "./logic.ts"

const NOW = 1_792_345_700_000
const KEYS = ["mx", "spf", "dkim", "dmarc", "bounce-mx", "bounce-spf", "bounce-dkim"]
const checks = (status: DomainCheck["status"], actual: string[] = []): DomainCheck[] =>
  KEYS.map((id) => ({ id, status, actual }))

const domain = (over: Partial<DomainLike> = {}): DomainLike => ({
  id: "dom_01",
  name: "coursified.app",
  receiving: true,
  sending: true,
  checkStatus: "pass",
  createdAt: 1,
  currentNameservers: ["ada.ns.cloudflare.com", "rob.ns.cloudflare.com"],
  checks: checks("pass"),
  ...over,
})
const mailbox = {
  id: "mbx_hello",
  address: "hello@coursified.app",
  domainId: "dom_01",
  kind: "shared",
  holdsMail: true,
  createdAt: 2,
}
const passTest = {
  status: "received" as const,
  probe: true,
  deliveryTimeMs: 1754,
  error: null,
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass", dmarcPolicy: "reject" },
}
const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  domain: domain(),
  now: NOW,
  mailbox,
  mailboxRouting: "unchecked",
  lastTest: passTest,
  testMessages: [],
  delivered: [],
  skipped: {},
  ...over,
})

describe("step derivation", () => {
  it("is all-done for a set-up workspace, with the designs' summaries", () => {
    const steps = deriveSteps(
      facts({
        mailImport: {
          status: "complete",
          accountedFor: true,
          totals: { source: 7600, imported: 7569, duplicates: 31, failed: 0 },
          createdAt: 1,
        },
        contactImport: { status: "completed", created: 11802, updated: 389, createdAt: 1 },
      }),
    )
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done", "done"])
    expect(steps.map((s) => s.summary)).toEqual([
      "coursified.app",
      "7 of 7 records passing",
      "hello@coursified.app · routing not checked",
      "Arrived in 1,754 ms · SPF, DKIM, DMARC pass",
      "7,600 messages copied",
      "11,802 added · 389 updated",
    ])
    expect(doneCount(steps)).toBe(6)
    expect(requiredDone(steps)).toBe(true)
    expect(currentStep(steps)).toBeNull()
  })

  it("starts at step 1 with nothing in the workspace", () => {
    const steps = deriveSteps(facts({ domain: undefined, mailbox: undefined, lastTest: undefined }))
    expect(steps.map((s) => s.status)).toEqual(["todo", "todo", "todo", "todo", "todo", "todo"])
    expect(currentStep(steps)).toBe("domain")
    expect(stepSub(steps[0] as never, true)).toBe("Not started")
    expect(stepSub(steps[1] as never, false)).toBe("Up next")
  })

  it("holds step 1 while the nameservers haven't moved to Cloudflare", () => {
    const d = domain({
      currentNameservers: ["ns1.dns-parking.com", "ns2.dns-parking.com"],
      receiving: false,
      sending: false,
    })
    const steps = deriveSteps(facts({ domain: d, mailbox: undefined, lastTest: undefined }))
    expect(steps[0]?.status).toBe("running")
    expect(stepSub(steps[0] as never, true)).toBe("In progress")
  })

  it("treats a pending zone as waiting even before DNS answers", () => {
    expect(
      deriveSteps(facts({ domain: domain({ zoneStatus: "pending", currentNameservers: null }) }))[0]?.status,
    ).toBe("running")
  })

  it("needs receiving and sending both on, and every record passing, for step 2", () => {
    expect(deriveSteps(facts({ domain: domain({ sending: false }) }))[1]?.status).toBe("todo")
    expect(deriveSteps(facts({ domain: domain({ checks: checks("fail", ["v=wrong"]) }) }))[1]?.status).toBe(
      "fail",
    )
  })

  it("lets optional steps be skipped without counting them done", () => {
    const steps = deriveSteps(facts({ skipped: { imap: true, csv: true } }))
    expect(steps[4]?.status).toBe("skipped")
    expect(steps[4]?.summary).toBe("Skipped")
    expect(doneCount(steps)).toBe(4)
    expect(currentStep(steps)).toBeNull()
  })

  it("prefers a real import over a skip", () => {
    const steps = deriveSteps(
      facts({
        skipped: { csv: true },
        contactImport: { status: "running", created: 0, updated: 0, createdAt: 1 },
      }),
    )
    expect(steps[5]?.status).toBe("running")
  })

  it("opens on the first optional step left once the required ones pass", () => {
    expect(currentStep(deriveSteps(facts()))).toBe("imap")
    expect(currentStep(deriveSteps(facts({ skipped: { imap: true } })))).toBe("csv")
  })

  it("shows the mailbox address alone when this browser didn't see the routing result", () => {
    expect(deriveSteps(facts({ mailboxRouting: undefined }))[2]?.summary).toBe("hello@coursified.app")
  })
})

describe("domain and mailbox choice", () => {
  it("picks the domain furthest along, then the first added", () => {
    const a = domain({ id: "a", receiving: false, sending: false, createdAt: 1 })
    const b = domain({ id: "b", checkStatus: "fail", createdAt: 3 })
    const c = domain({ id: "c", checkStatus: "pass", createdAt: 5 })
    expect(pickDomain([a, b, c])?.id).toBe("c")
    expect(pickDomain([a, b])?.id).toBe("b")
    expect(pickDomain([])).toBeUndefined()
  })

  it("knows Cloudflare nameservers", () => {
    expect(nameserversOnCloudflare(["ada.ns.cloudflare.com", "rob.ns.cloudflare.com."])).toBe(true)
    expect(nameserversOnCloudflare(["ns1.dns-parking.com"])).toBe(false)
    expect(nameserversOnCloudflare([])).toBeNull()
  })

  it("picks a mailbox that holds mail on the setup domain", () => {
    const alias = { ...mailbox, id: "a", kind: "alias", holdsMail: false }
    const other = { ...mailbox, id: "o", domainId: "dom_02", createdAt: 0 }
    expect(pickMailbox([alias, other, mailbox], "dom_01")?.id).toBe("mbx_hello")
    expect(pickMailbox([alias, other], "dom_01")?.id).toBe("o")
    expect(pickMailbox([alias])).toBeUndefined()
  })
})

describe("turning mail on", () => {
  it("is idle until both switches are on", () => {
    expect(enablePhase(domain({ receiving: false }), { now: NOW })).toBe("idle")
    expect(enablePhase(undefined, { now: NOW })).toBe("idle")
  })

  it("waits for records it hasn't seen during the watch window, then fails", () => {
    const d = domain({ checks: [...checks("pass").slice(0, 3), ...checks("fail").slice(3)] })
    expect(enablePhase(d, { turnedOnAt: NOW - 30_000, now: NOW })).toBe("progress")
    expect(enablePhase(d, { turnedOnAt: NOW - ENABLE_WATCH_MS - 1, now: NOW })).toBe("fail")
    expect(enablePhase(d, { now: NOW })).toBe("fail")
  })

  it("fails at once on a wrong value or a warning, whatever the window", () => {
    const wrong = domain({ checks: [{ id: "dkim", status: "fail", actual: ["v=DKIM1; p=old"] }] })
    const warn = domain({ checks: [{ id: "spf", status: "warn", actual: ["a", "b"] }] })
    expect(enablePhase(wrong, { turnedOnAt: NOW, now: NOW })).toBe("fail")
    expect(enablePhase(warn, { turnedOnAt: NOW, now: NOW })).toBe("fail")
  })

  it("passes when every record passes", () => {
    expect(enablePhase(domain(), { now: NOW })).toBe("pass")
  })

  it("draws rows as the designs do", () => {
    const missing: DomainCheck = { id: "bounce-mx", status: "fail", actual: [] }
    expect(rowState(missing, "idle", false)).toBe("idle")
    expect(rowState(missing, "progress", false)).toBe("waiting")
    expect(rowState(missing, "progress", true)).toBe("checking")
    expect(rowState(missing, "fail", false)).toBe("fail")
    expect(rowState({ id: "mx", status: "pass", actual: ["x"] }, "progress", true)).toBe("pass")
    expect(rowState({ id: "spf", status: "warn", actual: [] }, "fail", false)).toBe("warn")
  })

  it("counts passing records", () => {
    expect(checksPassing([...checks("pass").slice(0, 5), ...checks("fail").slice(5)])).toEqual({
      passing: 5,
      total: 7,
    })
    expect(checksPassing(undefined)).toEqual({ passing: 0, total: 0 })
  })
})

describe("the test send", () => {
  it("judges a test by status and authentication", () => {
    expect(testVerdict(passTest)).toBe("pass")
    expect(testVerdict({ ...passTest, authentication: { spf: "pass", dkim: "fail", dmarc: "fail" } })).toBe(
      "auth-fail",
    )
    expect(testVerdict({ ...passTest, status: "sent" })).toBe("waiting")
    expect(testVerdict({ ...passTest, status: "delivered", probe: false, authentication: null })).toBe(
      "delivered",
    )
    expect(testVerdict({ ...passTest, status: "failed", error: "SendSuppressed" })).toBe("failed")
  })

  it("trusts the browser's own test first, then the message log", () => {
    const authFail = { ...passTest, authentication: { spf: "pass", dkim: "fail", dmarc: "fail" } }
    const sent = [{ source: "test", stream: "test", status: "sent" }]
    expect(testStatus(authFail, sent, [])).toBe("fail")
    expect(testStatus(undefined, sent, [])).toBe("done")
    expect(testStatus(undefined, [{ source: "test", stream: "test", status: "failed" }], [])).toBe("todo")
    expect(testStatus(undefined, [{ source: "api", stream: "transactional", status: "bounced" }], [])).toBe(
      "todo",
    )
    expect(testStatus(undefined, [], [{ source: "api", stream: "transactional", status: "delivered" }])).toBe(
      "done",
    )
    expect(testStatus({ ...passTest, status: "sending" }, [], [])).toBe("running")
  })

  it("summarises the result for the stepper", () => {
    expect(
      testSummary({
        ...passTest,
        status: "delivered",
        probe: false,
        deliveryTimeMs: 2180,
        authentication: null,
      }),
    ).toBe("Delivered in 2,180 ms")
    expect(testSummary(undefined)).toBe("A test went out")
  })
})

describe("the gate", () => {
  it("is the checklist until the required steps pass", () => {
    expect(showChecklist({ requiredDone: false, started: false, handedOver: false, forced: false })).toBe(
      true,
    )
    expect(showChecklist({ requiredDone: true, started: false, handedOver: false, forced: false })).toBe(
      false,
    )
  })
  it("keeps a setup started here open until its hand-over", () => {
    expect(showChecklist({ requiredDone: true, started: true, handedOver: false, forced: false })).toBe(true)
    expect(showChecklist({ requiredDone: true, started: true, handedOver: true, forced: false })).toBe(false)
  })
  it("opens on purpose with ?setup=1", () => {
    expect(showChecklist({ requiredDone: true, started: false, handedOver: true, forced: true })).toBe(true)
  })
})

describe("inputs", () => {
  it("normalises pasted domains", () => {
    expect(normalizeDomain(" https://Coursified.app/pricing ")).toEqual({ name: "coursified.app" })
    expect(normalizeDomain("coursified.app.")).toEqual({ name: "coursified.app" })
    expect(normalizeDomain("hello@coursified.app")).toEqual({
      error: "That’s an address. Type the domain itself: coursified.app.",
    })
    expect("error" in normalizeDomain("not a domain")).toBe(true)
    expect("error" in normalizeDomain("")).toBe(true)
  })
  it("checks the part before @", () => {
    expect(validateLocalPart("hello")).toBeNull()
    expect(validateLocalPart("first.last")).toBeNull()
    expect(validateLocalPart("hello@x.com")).toMatch(/Only the part before/)
    expect(validateLocalPart("two words")).toMatch(/no spaces/)
    expect(validateLocalPart("")).toMatch(/Type the part/)
  })
})

describe("IMAP folders", () => {
  const folders = [
    { name: "INBOX", messages: 2914, folder: "inbox", label: null, skipped: false },
    { name: "[Gmail]/All Mail", messages: null, folder: null, label: null, skipped: true },
    { name: "[Gmail]/Sent Mail", messages: 1206, folder: "sent", label: null, skipped: false },
    { name: "[Gmail]/Spam", messages: 41, folder: "spam", label: null, skipped: false },
    { name: "Archive", messages: 3480, folder: "archive", label: null, skipped: false },
    { name: "Receipts", messages: 388, folder: "archive", label: "Receipts", skipped: false },
  ]
  it("ticks inbox, sent and archive by default, as the design does", () => {
    const sel = defaultFolderSelection(folders)
    expect(sel).toEqual(["INBOX", "[Gmail]/Sent Mail", "Archive"])
    expect(selectedMessages(folders, sel)).toBe(7600)
    expect(selectedMessages(folders, [...sel, "[Gmail]/All Mail"])).toBe(7600)
  })
  it("says where a folder lands", () => {
    expect(landsIn({ folder: "archive", label: "Receipts" })).toBe("Archive · label “Receipts”")
    expect(landsIn({ folder: "inbox", label: null })).toBe("Inbox")
  })
})

describe("CSV header", () => {
  it("reads headers, the first row and the row count", () => {
    const csv = "﻿email,full_name, course \r\nada@x.com,Ada Okafor,Data\r\n\r\nbo@x.com,Bo,\r\n"
    expect(previewCsv(csv)).toEqual({
      headers: ["email", "full_name", "course"],
      firstRow: ["ada@x.com", "Ada Okafor", "Data"],
      rows: 2,
    })
  })
  it("keeps quoted commas, quotes and line breaks in one field", () => {
    const csv = 'email,note\nada@x.com,"one, ""two""\nthree"\nbo@x.com,plain'
    const p = previewCsv(csv)
    expect(p).toEqual({ headers: ["email", "note"], firstRow: ["ada@x.com", 'one, "two"\nthree'], rows: 2 })
  })
  it("counts a last row with no line ending", () => {
    expect(previewCsv("email\na@x.com\nb@x.com")).toMatchObject({ rows: 2 })
  })
  it("refuses a file with no header, an unnamed column or a repeated one", () => {
    expect(previewCsv("")).toEqual({
      error: "The file has no header row (or its first row is longer than 256 KB).",
    })
    expect(previewCsv("\n\n")).toEqual({
      error: "The file has no header row (or its first row is longer than 256 KB).",
    })
    expect(previewCsv("email,,name\n")).toMatchObject({ error: expect.stringMatching(/Column 2/) })
    expect(previewCsv("email,email\n")).toMatchObject({ error: expect.stringMatching(/both named “email”/) })
  })
  it("refuses a header row longer than 256 KB", () => {
    expect(previewCsv(`${"a".repeat(300 * 1024)}\nb`)).toMatchObject({
      error: expect.stringMatching(/256 KB/),
    })
  })
})

describe("mapping", () => {
  const headers = ["email", "full_name", "course", "Points", "signed_up", "status", "marketing_ok"]
  it("guesses the design's mapping", () => {
    const rows = guessMapping(headers, ["course", "points", "signed_up"])
    expect(toImportMapping(rows)).toEqual({
      email: "email",
      full_name: "name",
      course: "fields.course",
      Points: "fields.points",
      signed_up: "fields.signed_up",
      status: "status",
      marketing_ok: "ignore",
    })
    expect(validateMapping(rows)).toEqual([])
  })
  it("never guesses both a name and first/last", () => {
    const rows = guessMapping(["Email Address", "Name", "First Name", "Last Name"], [])
    expect(rows.map((r) => r.target)).toEqual(["email", "name", "ignore", "ignore"])
  })
  it("guesses first plus last when there's no name column", () => {
    expect(guessMapping(["E-mail", "First Name", "Surname"], []).map((r) => r.target)).toEqual([
      "email",
      "name.first",
      "name.last",
    ])
  })
  const row = (column: string, target: MappingRow["target"], fieldKey = column): MappingRow => ({
    column,
    target,
    fieldKey,
  })
  it("needs exactly one email", () => {
    expect(validateMapping([row("a", "ignore")])).toEqual([{ message: "Map one column to Email." }])
    expect(validateMapping([row("a", "email"), row("b", "email")])[0]?.message).toMatch(
      /Only one column can be Email: a, b/,
    )
  })
  it("refuses a name with first/last, and two of anything single", () => {
    const errs = validateMapping([
      row("e", "email"),
      row("n", "name"),
      row("f", "name.first"),
      row("s", "status"),
      row("t", "status"),
    ])
    expect(errs.map((e) => e.message)).toEqual([
      "Only one column can be Status: s, t.",
      "A name comes from one column, or from a first-name and a last-name column, not both.",
    ])
  })
  it("checks field names and repeats", () => {
    const errs = validateMapping([
      row("e", "email"),
      row("x", "fields", "9bad"),
      row("y", "fields", "plan"),
      row("z", "fields", "plan"),
    ])
    expect(errs).toEqual([
      { column: "x", message: expect.stringMatching(/letters, digits and underscores/) },
      { column: "z", message: "“y” already maps to plan. Two columns can’t share a field." },
    ])
  })
  it("allows at most 50 custom fields", () => {
    const rows = [row("e", "email"), ...Array.from({ length: 51 }, (_, i) => row(`c${i}`, "fields", `f${i}`))]
    expect(validateMapping(rows)).toEqual([{ message: "At most 50 custom fields; 51 are mapped." }])
  })
  it("makes field keys from column names", () => {
    expect(fieldKeyFor("Signed up (UTC)")).toBe("signed_up_utc")
    expect(fieldKeyFor("2024 plan")).toBe("_2024_plan")
    expect(fieldKeyFor("!!!")).toBe("field")
  })
})

describe("progress, rate and ETA", () => {
  it("formats sizes", () => {
    expect(fmtBytes(1938211)).toBe("1.8 MiB")
    expect(fmtBytes(217088)).toBe("212 KB")
    expect(fmtBytes(500)).toBe("500 B")
    expect(fmtBytes(null)).toBe("—")
  })
  it("computes the bar from bytesRead / size", () => {
    expect(progressPct(1562000, 1938211)).toBe(80.6)
    expect(progressPct(10, 0)).toBeNull()
    expect(progressPct(5, 4)).toBe(100)
  })
  it("words time left", () => {
    expect(fmtLeft(NOW + 30_000, NOW)).toBe("about 30 seconds left")
    expect(fmtLeft(NOW + 6 * 60_000, NOW)).toBe("about 6 minutes left")
    expect(fmtLeft(NOW + 60_000, NOW)).toBe("about 1 minute left")
    expect(fmtLeft(NOW + 2 * 3_600_000, NOW)).toBe("about 2 hours left")
    expect(fmtLeft(NOW, NOW)).toBe("almost done")
    expect(fmtLeft(null, NOW)).toBeNull()
  })
  it("writes the design's progress line", () => {
    const started = Date.UTC(2026, 9, 18, 17, 46)
    expect(
      contactProgressLine(
        {
          bytesRead: 1562000,
          size: 1938211,
          processed: 10000,
          ratePerMinute: 5000,
          etaAt: started + 90_000,
          startedAt: started,
        },
        started + 60_000,
      ),
    ).toBe(
      "1.5 MiB of 1.8 MiB read · 10,000 rows · 5,000 rows a minute · about 30 seconds left · started 17:46 UTC",
    )
    expect(
      contactProgressLine(
        {
          bytesRead: 0,
          size: null,
          fileSize: null,
          processed: 0,
          ratePerMinute: null,
          etaAt: null,
          startedAt: null,
        },
        NOW,
      ),
    ).toBe("0 B read · 0 rows")
  })
  it("writes the mail import rate", () => {
    const eta = Date.UTC(2026, 9, 18, 17, 54)
    expect(mailRateLine(780, eta, eta - 6 * 60_000)).toBe("780 a minute, done in about 6 minutes (17:54 UTC)")
    expect(mailRateLine(null, null, NOW)).toBeNull()
  })
  it("formats UTC times", () => {
    expect(fmtUtc(Date.UTC(2026, 9, 18, 7, 5))).toBe("07:05 UTC")
  })
  it("spells the counts out", () => {
    expect(
      countsSentence({
        rows: 12406,
        created: 11802,
        updated: 389,
        skipped: 0,
        invalid: 183,
        duplicates: 32,
        suppressed: 14,
      }),
    ).toBe(
      "11,802 created (including 14 suppressed) + 389 updated + 0 skipped + 183 invalid + 32 duplicates = 12,406 rows.",
    )
  })
})

describe("setup memory", () => {
  it("parses what it wrote and drops anything else", () => {
    expect(
      parseSetupMemory(
        JSON.stringify({
          started: true,
          handedOver: false,
          skipped: { imap: true, csv: "yes" },
          lastTestId: "tst_01JAF4T7QK",
          turnedOnAt: 5,
          mailboxRouting: { mailboxId: "mbx_hello", routing: "clear" },
          extra: 1,
        }),
      ),
    ).toEqual({
      started: true,
      skipped: { imap: true },
      lastTestId: "tst_01JAF4T7QK",
      turnedOnAt: 5,
      mailboxRouting: { mailboxId: "mbx_hello", routing: "clear" },
    })
  })
  it("survives garbage", () => {
    expect(parseSetupMemory("{nope")).toEqual({})
    expect(parseSetupMemory(null)).toEqual({})
    expect(parseSetupMemory('"str"')).toEqual({})
    expect(parseSetupMemory(JSON.stringify({ lastTestId: "../../etc" }))).toEqual({})
  })
})

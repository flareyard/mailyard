import { describe, expect, it } from "vitest"
import { filterLog, rawFrom, renderFixture } from "./fixtures.ts"
import {
  actorName,
  andList,
  checkTest,
  chips,
  curlFor,
  echo,
  eventView,
  hasFilters,
  holdRemoteImages,
  lineDiff,
  logQuery,
  messageCallout,
  missingVars,
  parseLogSearch,
  previewDoc,
  providerName,
  resendBlock,
  resendBody,
  rowNote,
  sampleData,
  senderLocal,
  sentBy,
  statusPill,
  testBody,
  testStatus,
  tokenizeLine,
  varChanges,
  variablesIn,
  versionRows,
  versionState,
  without,
} from "./logic.ts"

describe("log search", () => {
  it("keeps only what the API understands", () => {
    expect(
      parseLogSearch({
        status: "bounced",
        stream: "nope",
        q: "  ada ",
        from: "1792256400000",
        to: "x",
        templateId: "",
      }),
    ).toEqual({ status: "bounced", q: "ada", from: 1792256400000 })
  })
  it("builds the GET /v1/messages query with string numbers", () => {
    expect(logQuery({ q: "ada", from: 1, to: 2, cursor: "c" })).toEqual({
      q: "ada",
      from: "1",
      to: "2",
      cursor: "c",
      limit: "50",
    })
  })
  it("echoes the view as a link", () => {
    expect(echo({})).toBe("?")
    expect(echo({ status: "bounced", stream: "transactional" })).toBe("?status=bounced&stream=transactional")
  })
  it("names chips and drops one filter (back to page one)", () => {
    const s = { q: "ada", templateId: "tpl_reset", from: Date.UTC(2026, 9, 17, 17, 0), cursor: "c" }
    expect(chips(s, (id) => (id === "tpl_reset" ? "password-reset" : undefined))).toEqual([
      { key: "q", label: "Search", value: "ada" },
      { key: "templateId", label: "Template", value: "password-reset" },
      { key: "from", label: "From", value: "17 Oct 17:00 UTC" },
    ])
    expect(without(s, "q")).toEqual({ templateId: "tpl_reset", from: s.from })
    expect(hasFilters({ cursor: "c" })).toBe(false)
    expect(hasFilters({ stream: "test" })).toBe(true)
  })
})

describe("rows", () => {
  it("labels statuses with their colour", () => {
    expect(statusPill("bounced", "hard")).toEqual({ tone: "fail", label: "Bounced hard" })
    expect(statusPill("deferred")).toEqual({ tone: "warn", label: "Deferred" })
    expect(statusPill("queued")).toEqual({ tone: "neutral", label: "Queued" })
    expect(statusPill("delivered").tone).toBe("pass")
  })
  it("writes the note under the subject", () => {
    expect(rowNote({ status: "deferred", attempts: 5, error: "x" })).toEqual({
      tone: "warn",
      text: "Attempt 5 · Mailyard tries again",
    })
    expect(rowNote({ status: "bounced", attempts: 1, error: "SendBounced: 550 5.1.1 nope" })?.text).toBe(
      "550 5.1.1 nope",
    )
    expect(rowNote({ status: "failed", attempts: 1, error: "SendRejected: refused" })?.text).toBe(
      "SendRejected: refused",
    )
    expect(rowNote({ status: "delivered", attempts: 1, error: null })).toBeNull()
  })
  it("says who sent it", () => {
    const keys = new Map([["key_1", { name: "Billing worker", prefix: "sk_Vd81" }]])
    const campaigns = new Map([["cmp_1", "October update"]])
    const base = {
      source: "api",
      stream: "transactional",
      apiKeyId: null,
      campaignId: null,
      sender: "Hello <support@x.app>",
    }
    expect(sentBy({ ...base, apiKeyId: "key_1" }, keys, campaigns)).toEqual({
      name: "Billing worker",
      prefix: "sk_Vd81",
      kind: "key",
    })
    expect(sentBy({ ...base, campaignId: "cmp_1" }, keys, campaigns).name).toBe("October update")
    expect(sentBy({ ...base, source: "mailbox", stream: "mailbox" }, keys, campaigns).name).toBe("support@")
    expect(sentBy({ ...base, source: "automation", stream: "automation" }, keys, campaigns).name).toBe(
      "Automation",
    )
    expect(senderLocal("plain@x.app")).toBe("plain@")
  })
  it("names providers and actors", () => {
    expect(providerName("gmail")).toBe("Gmail")
    expect(providerName("fastmail")).toBe("Fastmail")
    expect(providerName(null)).toBeNull()
    const keys = new Map([["key_1", { name: "Web app" }]])
    expect(actorName("root", keys)).toBe("Admin key")
    expect(actorName("key_1", keys)).toBe("Web app")
    expect(actorName("Halleluyah", keys)).toBe("Halleluyah")
    expect(actorName(null, keys)).toBeNull()
  })
})

const msg = {
  status: "delivered",
  stream: "transactional",
  source: "api",
  bounceType: null as string | null,
  provider: "yahoo",
  error: null as string | null,
  events: [] as { type: string; detail: string | null }[],
  rendered: { from: "A <a@x.app>", subject: "Hi", html: "<p>Hi</p>", text: "Hi" } as {
    from: string
    subject: string
    html: string | null
    text: string | null
  } | null,
  recipient: "ada@x.com",
}

describe("message detail", () => {
  it("labels events with tone, icon and meta", () => {
    expect(
      eventView({ type: "bounced", attempt: null, provider: "other", bounceType: "hard" }),
    ).toMatchObject({
      label: "Bounced · hard",
      tone: "is-fail",
      meta: "Other · hard bounce",
    })
    expect(eventView({ type: "sent", attempt: 1, provider: "gmail", bounceType: null })).toMatchObject({
      label: "Sent to Email Service",
      meta: "Attempt 1 · Gmail",
    })
    expect(eventView({ type: "mystery", attempt: null, provider: null, bounceType: null }).label).toBe(
      "mystery",
    )
  })
  it("explains what happened", () => {
    expect(messageCallout(msg)).toBeNull()
    expect(messageCallout({ ...msg, status: "bounced", bounceType: "hard" })?.link?.to).toBe(
      "/transactional/suppressions",
    )
    expect(messageCallout({ ...msg, status: "bounced", bounceType: "soft" })?.tone).toBe("warn")
    expect(messageCallout({ ...msg, status: "deferred" })?.title).toMatch(/^Yahoo deferred it/)
    expect(messageCallout({ ...msg, status: "complained", stream: "campaign" })?.title).toMatch(
      /campaign as spam/,
    )
    expect(messageCallout({ ...msg, status: "rejected", error: "SendSuppressed: on the list" })?.title).toBe(
      "Not sent: the recipient is suppressed.",
    )
    expect(
      messageCallout({ ...msg, status: "failed", error: "SendRejected: the From domain isn’t verified" })
        ?.link?.to,
    ).toBe("/domains")
  })
  it("blocks resend for suppressed, complained campaign mail and missing copies", () => {
    expect(resendBlock(msg)).toBeNull()
    expect(
      resendBlock({ ...msg, status: "bounced", events: [{ type: "suppressed", detail: null }] })?.reason,
    ).toBe("This address is suppressed")
    expect(resendBlock({ ...msg, status: "complained", stream: "campaign" })?.reason).toMatch(/spam/)
    expect(resendBlock({ ...msg, rendered: null })?.reason).toMatch(/copy/)
  })
  it("resends the stored copy and builds curl", () => {
    const body = resendBody(msg)
    expect(body).toEqual({ to: "ada@x.com", from: "A <a@x.app>", subject: "Hi", body: "<p>Hi</p>" })
    expect(resendBody({ ...msg, rendered: null })).toBeNull()
    const c = curlFor("https://mail.x.app", { to: "it's" }, "key-1")
    expect(c).toContain("https://mail.x.app/v1/send")
    expect(c).toContain("Idempotency-Key: key-1-2")
    expect(c).toContain(`'{"to":"it'\\''s"}'`)
  })
  it("holds remote images and forces dark mode on request", () => {
    const { html, held } = holdRemoteImages('<img alt="" src="https://x.app/a.png"><img src="data:x">')
    expect(held).toBe(1)
    expect(html).toContain('data-held-src="https://x.app/a.png"')
    expect(previewDoc("<p>x</p>", { dark: true })).toContain("color-scheme:dark")
    expect(previewDoc("<html><head></head><body></body></html>")).toContain(
      '<head><meta name="color-scheme" content="light">',
    )
    expect(previewDoc('<img src="https://x/a.png">', { allowImages: true })).toContain(
      'src="https://x/a.png"',
    )
  })
})

describe("templates", () => {
  it("tokenises a line into tags, variables and text", () => {
    expect(tokenizeLine("<p>Hi {{ name }},</p>")).toEqual([
      { kind: "tag", text: "<p" },
      { kind: "text", text: ">Hi " },
      { kind: "var", text: "{{ name }}", name: "name" },
      { kind: "text", text: "," },
      { kind: "tag", text: "</p" },
      { kind: "text", text: ">" },
    ])
    expect(variablesIn("{{a}} {{b.c}} {{a}}")).toEqual(["a", "b.c"])
  })
  it("finds missing variables and drops blank samples", () => {
    expect(missingVars(["name", "url"], { name: "Ada", url: "  " })).toEqual(["url"])
    expect(sampleData({ a: "1", b: "" })).toEqual({ a: "1" })
  })
  it("states the version", () => {
    expect(versionState({ publishedVersion: 5, latestVersion: 6, hasUnpublishedChanges: true })).toEqual({
      live: "v5 live",
      draft: { tone: "warn", label: "Draft v6" },
    })
    expect(
      versionState({ publishedVersion: 3, latestVersion: 3, hasUnpublishedChanges: false }).draft.label,
    ).toBe("Up to date")
    expect(versionState({ publishedVersion: null, latestVersion: 1, hasUnpublishedChanges: true }).live).toBe(
      "Not published",
    )
  })
  it("orders versions and names their state, including drafts a rollback superseded", () => {
    const rows = versionRows({
      publishedVersion: 7,
      latestVersion: 7,
      versions: [
        { version: 5, subject: "a", publishedAt: 5, createdBy: "root", createdAt: 5 },
        { version: 6, subject: "b", publishedAt: null, createdBy: "root", createdAt: 6 },
        { version: 7, subject: "a", publishedAt: 7, createdBy: "root", createdAt: 7 },
      ],
    })
    expect(rows.map((r) => [r.version, r.state])).toEqual([
      [7, "live"],
      [6, "superseded"],
      [5, "past"],
    ])
    expect(
      versionRows({
        publishedVersion: 5,
        latestVersion: 6,
        versions: [{ version: 6, subject: "b", publishedAt: null, createdBy: null, createdAt: 6 }],
      })[0]?.state,
    ).toBe("draft")
  })
  it("diffs lines and variables", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
    ])
    expect(
      varChanges({ used: ["a", "b"], required: ["a"] }, { used: ["a", "c"], required: ["a", "c"] }),
    ).toEqual({
      added: ["c"],
      removed: ["b"],
      nowRequired: ["c"],
    })
    expect(andList(["a", "b", "c"])).toBe("a, b and c")
    expect(andList(["a"])).toBe("a")
  })
})

describe("test sends", () => {
  const form = { to: ["ada@x.com"], version: { kind: "latest" as const }, data: "", from: "" }
  it("checks recipients, version, JSON and from", () => {
    expect(checkTest(form, 6)).toEqual({})
    expect(checkTest({ ...form, to: ["", " "] }, 6).to).toBe("Add at least one address.")
    expect(
      checkTest({ ...form, to: ["a@x.co", "b@x.co", "c@x.co", "d@x.co", "e@x.co", "f@x.co"] }, 6).to,
    ).toBe("Five addresses at most.")
    expect(checkTest({ ...form, to: ["nope"] }, 6).to).toBe("nope isn’t an email address.")
    expect(checkTest({ ...form, version: { kind: "number", n: 9 } }, 6).version).toBe(
      "Choose a version from 1 to 6.",
    )
    expect(checkTest({ ...form, data: "{" }, 6).data).toBe("That isn’t valid JSON.")
    expect(checkTest({ ...form, data: "[1]" }, 6).data).toMatch(/JSON object/)
    expect(checkTest({ ...form, from: "Coursified <no-reply@x.app>" }, 6)).toEqual({})
    expect(checkTest({ ...form, from: "no" }, 6).from).toMatch(/address/)
  })
  it("builds the body", () => {
    expect(
      testBody({
        ...form,
        to: [" ada@x.com ", ""],
        data: '{"name":"Ada"}',
        version: { kind: "number", n: 4 },
      }),
    ).toEqual({
      to: ["ada@x.com"],
      version: 4,
      data: { name: "Ada" },
    })
    expect(testBody({ ...form, from: " A <a@x.co> " })).toEqual({
      to: ["ada@x.com"],
      version: "latest",
      from: "A <a@x.co>",
    })
  })
  it("labels results", () => {
    expect(testStatus("sent").tone).toBe("pass")
    expect(testStatus("suppressed").label).toBe("Rejected: suppressed")
    expect(testStatus("rejected").tone).toBe("fail")
    expect(testStatus("queued").label).toBe("Queued")
  })
})

describe("fixture stand-ins", () => {
  const row = (over: Record<string, unknown>) =>
    ({
      id: "msg_1",
      stream: "transactional",
      source: "api",
      recipient: "ada.okafor@gmail.com",
      sender: "A <a@x.app>",
      subject: "Hi",
      status: "delivered",
      bounceType: null,
      provider: null,
      error: null,
      attempts: 1,
      cfMessageId: "<cf1@x.app>",
      templateId: "tpl_reset",
      templateVersion: 1,
      apiKeyId: null,
      campaignId: null,
      tracked: false,
      firstOpenedAt: null,
      firstClickedAt: null,
      opens: 0,
      clicks: 0,
      machineOpens: 0,
      machineClicks: 0,
      createdAt: 100,
      updatedAt: null,
      ...over,
    }) as Parameters<typeof filterLog>[0][number]
  it("filters the log the way the API does", () => {
    const rows = [
      row({}),
      row({
        id: "msg_2",
        recipient: "bob@x.com",
        status: "bounced",
        createdAt: 300,
        cfMessageId: "<cf2@x.app>",
      }),
    ]
    expect(filterLog(rows, { q: "ada" }).map((r) => r.id)).toEqual(["msg_1"])
    expect(filterLog(rows, { q: "adaokafor" })).toEqual([])
    expect(filterLog(rows, { q: "msg_2" }).map((r) => r.id)).toEqual(["msg_2"])
    expect(filterLog(rows, { q: "cf1@x.app" }).map((r) => r.id)).toEqual(["msg_1"])
    expect(filterLog(rows, { status: "bounced" }).map((r) => r.id)).toEqual(["msg_2"])
    expect(filterLog(rows, { from: 200 }).map((r) => r.id)).toEqual(["msg_2"])
  })
  it("renders and marks missing variables", () => {
    const r = renderFixture("Hi {{name}}", "<p>{{name}} {{url}}</p>", null, { name: "Ada" }, ["name", "url"])
    expect(r.subject).toBe("Hi Ada")
    expect(r.variables).toEqual({ used: ["name", "url"], required: ["name", "url"], missing: ["url"] })
    expect(r.html).toContain('<span class="m">{{url}}</span>')
  })
  it("rebuilds a raw copy", () => {
    const raw = rawFrom({
      ...row({}),
      smtpResponse: null,
      idempotencyKey: null,
      nextAttemptAt: null,
      events: [],
      headers: [{ name: "From", value: "A <a@x.app>" }],
      rendered: { from: "A", to: ["b"], subject: "Hi", html: "<p>x</p>", text: "x", attachments: [] },
    })
    expect(raw).toContain("From: A <a@x.app>")
    expect(raw).toContain("X-Mailyard-Copy")
    expect(raw).toContain("Content-Type: text/html")
  })
})

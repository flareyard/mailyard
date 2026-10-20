import { describe, expect, it } from "vitest"
import { ApiError } from "../../api/client.ts"
import {
  addRecipients,
  addressProblem,
  BUDGET,
  batches,
  blockedRefusal,
  budgetPlan,
  checkRecipients,
  fileRefusal,
  joinBody,
  joinHtml,
  MAX_FILE,
  MAX_RECIPIENTS,
  parseRecipients,
  type Rcpt,
  recipientRefusal,
  refusalFrom,
  schedulePresets,
  splitBody,
  textToHtml,
  type UploadRow,
  userHtmlOf,
} from "./logic.ts"

const NOW = Date.UTC(2026, 9, 17, 17, 46) // Sat 17 Oct 2026, 17:46 UTC

describe("addresses", () => {
  it("names what's wrong in plain words", () => {
    expect(addressProblem("ada.okafor@gmail.com")).toBeNull()
    expect(addressProblem("grace.nnamdi@gmail,com")).toBe("it has a comma where the dot should be")
    expect(addressProblem("nobody")).toBe("it has no @")
    expect(addressProblem("a@b@c.com")).toBe("it has more than one @")
    expect(addressProblem("a@localhost")).toBe("the part after @ has no dot")
    expect(addressProblem("a b@c.com")).toBe("it has a space in it")
  })

  it("parses names, quoted names and bare addresses, by commas, semicolons and lines", () => {
    expect(
      parseRecipients('Ada Okafor <ada@gmail.com>, "Bello, Kemi" <kemi@x.co>; chidi@y.com\nfunke@z.com'),
    ).toEqual([
      { name: "Ada Okafor", address: "ada@gmail.com" },
      { name: "Bello, Kemi", address: "kemi@x.co" },
      { name: null, address: "chidi@y.com" },
      { name: null, address: "funke@z.com" },
    ])
  })

  it("keeps a comma typo inside the domain so it can be flagged", () => {
    expect(
      parseRecipients("ada@gmail.com, grace.nnamdi@gmail,com, chidi@y.com").map((r) => r.address),
    ).toEqual(["ada@gmail.com", "grace.nnamdi@gmail,com", "chidi@y.com"])
  })

  it("splits space-separated pasted addresses", () => {
    expect(parseRecipients("a@b.co c@d.co").map((r) => r.address)).toEqual(["a@b.co", "c@d.co"])
  })

  it("adds without duplicates, ignoring case", () => {
    const list: Rcpt[] = [{ name: null, address: "Ada@Gmail.com" }]
    expect(
      addRecipients(list, [
        { name: "Ada", address: "ada@gmail.com" },
        { name: null, address: "b@c.co" },
      ]),
    ).toHaveLength(2)
  })
})

describe("the 50-recipient limit", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: null, address: `s${i}@x.co` }))
  it("flags over 50 across To, Cc and Bcc", () => {
    expect(checkRecipients(many(30), many(20), []).overLimit).toBe(false)
    expect(checkRecipients(many(30), many(21), []).overLimit).toBe(true)
  })
  it("refuses with the design's words, naming the bad address", () => {
    const c = checkRecipients([...many(51), { name: null, address: "grace@gmail,com" }], [], [])
    const r = recipientRefusal(c)
    expect(r?.button).toBe("Fix recipients to send")
    expect(r?.who).toBe(`Remove or correct grace@gmail,com, and keep it to ${MAX_RECIPIENTS} or fewer.`)
    expect(r?.marked).toEqual(["grace@gmail,com"])
  })
  it("asks for a recipient when there is none", () => {
    expect(recipientRefusal(checkRecipients([], [], []))?.title).toBe("Add a recipient")
  })
  it("batches by 50", () => {
    expect(batches(many(120)).map((b) => b.length)).toEqual([50, 50, 20])
  })
})

describe("attachments", () => {
  const row = (id: string, size: number, delivery: "inline" | "link" = "inline"): UploadRow => ({
    id,
    filename: id,
    mimeType: "application/pdf",
    size,
    status: "done",
    progress: 1,
    delivery,
  })
  it("refuses files over the per-file limit before uploading", () => {
    expect(fileRefusal(MAX_FILE + 1)).toMatch(/Too big to attach/)
    expect(fileRefusal(1024)).toBeNull()
  })
  it("keeps what fits the 5 MiB budget inline and forces the rest to Link", () => {
    const plan = budgetPlan([row("a", 3 * 1024 * 1024), row("b", 3 * 1024 * 1024), row("c", 1024, "link")])
    expect(plan.inlineBytes).toBe(3 * 1024 * 1024)
    expect([...plan.forced]).toEqual(["b"])
    expect(plan.links).toBe(2)
  })
  it("warns from 80% of the budget", () => {
    expect(budgetPlan([row("a", Math.ceil(BUDGET * 0.85))]).tone).toBe("warn")
    expect(budgetPlan([row("a", 1024)]).tone).toBe("ok")
  })
})

describe("the body", () => {
  const quote = "\n\nOn Sat, 17 Oct 2026 17:46:00 GMT, Ada Okafor <ada@gmail.com> wrote:\n> It still fails"
  it("joins and splits text, signature and quote losslessly", () => {
    const body = joinBody("Hi Ada,\n\nHere's the link.\n", "Kemi\nCoursified support", quote)
    expect(body).toBe(`Hi Ada,\n\nHere's the link.\n\n-- \nKemi\nCoursified support${quote}`)
    expect(splitBody(body)).toEqual({
      text: "Hi Ada,\n\nHere's the link.",
      signature: "Kemi\nCoursified support",
      quote,
    })
  })
  it("reads a fresh server-built reply as only a quote", () => {
    expect(splitBody(quote.trimStart())).toEqual({
      text: "",
      signature: null,
      quote: `\n${quote.trimStart()}`,
    })
  })
  it("finds a forward's header block", () => {
    const fwd = "FYI\n\n---------- Forwarded message ---------\nFrom: Ada"
    expect(splitBody(fwd).quote).toBe("\n\n---------- Forwarded message ---------\nFrom: Ada")
  })
  it("marks the user's HTML so a resumed draft gets it back", () => {
    const html = joinHtml("<b>Hi</b>", { text: "Kemi", html: null }, quote)
    expect(userHtmlOf(html)).toBe("<b>Hi</b>")
    expect(userHtmlOf("<p>someone else's</p>")).toBeNull()
  })
  it("escapes text into HTML and links URLs", () => {
    expect(textToHtml("a <b>\nhttps://x.co")).toBe('a &lt;b&gt;<br><a href="https://x.co">https://x.co</a>')
  })
})

describe("schedule presets", () => {
  it("offers tomorrow and Monday 08:00 UTC on a Saturday evening", () => {
    expect(schedulePresets(NOW)).toEqual([
      { label: "Tomorrow morning", at: Date.UTC(2026, 9, 18, 8) },
      { label: "Monday morning", at: Date.UTC(2026, 9, 19, 8) },
    ])
  })
  it("adds this afternoon in the morning, and drops Monday on a Sunday", () => {
    const sun = Date.UTC(2026, 9, 18, 9)
    expect(schedulePresets(sun).map((p) => p.label)).toEqual(["This afternoon", "Tomorrow morning"])
  })
})

describe("refusals", () => {
  const err = (status: number, body: Record<string, unknown>) => new ApiError(status, body)
  it("quota: the reset time, Queue, sticky", () => {
    const r = refusalFrom(
      err(409, {
        _tag: "SendBlocked",
        reason: "quota_exhausted",
        message: "x",
        resetsAt: Date.UTC(2026, 9, 18),
      }),
      {},
      NOW,
    )
    expect(r.button).toBe("Quota used")
    expect(r.queueAt).toBe(Date.UTC(2026, 9, 18))
    expect(r.who).toBe(
      "Schedule it, or press Queue: it goes at 00:00 UTC, in 6 h 14 min. The quota resets daily.",
    )
    expect(r.sticky).toBe(true)
  })
  it("domain: links to the domain", () => {
    const r = refusalFrom(
      err(409, {
        _tag: "SendBlocked",
        reason: "domain_unhealthy",
        message: "DKIM changed.",
        domainId: "dom_01",
      }),
      { domain: "coursified.app" },
    )
    expect(r.button).toBe("Can’t send: domain failing")
    expect(r.notice.link).toEqual({ label: "Open coursified.app (dom_01)", to: "/domains/dom_01" })
  })
  it("suppressed: marks the chips", () => {
    const r = refusalFrom(
      err(409, { _tag: "SendBlocked", reason: "all_recipients_suppressed", message: "x" }),
      { recipients: ["a@b.co"] },
    )
    expect(r.button).toBe("Can’t send: recipient suppressed")
    expect(r.marked).toEqual(["a@b.co"])
  })
  it("agent_limit: the figures and the reset", () => {
    const r = refusalFrom(
      err(409, {
        _tag: "Conflict",
        reason: "agent_limit",
        limit: 20,
        sentToday: 20,
        resetsAt: Date.UTC(2026, 9, 18),
      }),
      {},
      NOW,
    )
    expect(r.title).toBe("This key has sent 20 of 20 today")
    expect(r.kind).toBe("agent_limit")
  })
  it("recipient_not_allowed: names and marks the addresses", () => {
    const r = refusalFrom(
      err(409, { _tag: "Conflict", reason: "recipient_not_allowed", notAllowed: ["x@y.co"] }),
    )
    expect(r.marked).toEqual(["x@y.co"])
    expect(r.notice.lead).toBe("x@y.co isn’t on this key’s allow-list.")
  })
  it("workspace-deleting", () => {
    const r = refusalFrom(
      err(409, { _tag: "Conflict", reason: "workspace-deleting", deletesAt: Date.UTC(2026, 9, 24, 12) }),
    )
    expect(r.button).toBe("Can’t send: workspace deleting")
    expect(r.who).toMatch(/Sat 24 Oct, 12:00 UTC/)
  })
  it("403 mailbox_role names the owners", () => {
    const r = refusalFrom(err(403, { _tag: "Forbidden", reason: "mailbox_role", owners: ["Kemi Bello"] }))
    expect(r.who).toBe("You’re a viewer on this mailbox. Kemi Bello can give you member access.")
  })
  it("403 role lists the allowed roles", () => {
    expect(
      refusalFrom(err(403, { _tag: "Forbidden", reason: "role", allowedRoles: ["owner", "admin"] })).who,
    ).toBe("Owner, admin can send from here.")
  })
  it("403 insufficient scope", () => {
    expect(
      refusalFrom(err(403, { _tag: "Forbidden", reason: "insufficient-scope", required: "send" })).who,
    ).toBe("Needs a key with the send scope, or the admin key.")
  })
  it("429, idempotency, invalid, unreachable are transient", () => {
    expect(refusalFrom(err(429, { _tag: "RateLimited", retryAfter: 30 })).who).toBe("Try again in 30 s.")
    expect(refusalFrom(err(409, { _tag: "IdempotencyConflict", message: "m" })).kind).toBe("idempotency")
    expect(refusalFrom(err(400, { _tag: "InvalidRequest", field: "to", message: "Bad" })).notice.lead).toBe(
      "Check to.",
    )
    const net = refusalFrom(new TypeError("fetch failed"))
    expect(net.kind).toBe("unreachable")
    expect(net.sticky).toBe(false)
  })
  it("a draft's blockedReason reads the same before Send is pressed", () => {
    expect(blockedRefusal("quota_exhausted", {}, NOW).button).toBe("Quota used")
  })
})

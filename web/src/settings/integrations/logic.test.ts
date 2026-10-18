import { describe, expect, it } from "vitest"
import {
  activityKind,
  addDomains,
  agentStatus,
  anyClient,
  capPercent,
  claudeAdd,
  claudeSwap,
  DEFAULT_LIMITS,
  describeLimits,
  isLocalPart,
  limitsProblems,
  localOf,
  mcpUrl,
  mergeMembers,
  normaliseDomain,
  readRefs,
  suggestLocal,
  toLimits,
  toolsFor,
  waitCurl,
} from "./logic.ts"

describe("tools by scope", () => {
  it("unlocks the read tools, the send tools and track", () => {
    expect(toolsFor(["read"]).map((t) => t.name)).toHaveLength(13)
    expect(toolsFor(["read", "send"])).toHaveLength(17)
    expect(toolsFor(["track"]).map((t) => t.name)).toEqual(["track_event"])
  })
  it("gives admin every built tool", () => {
    expect(toolsFor(["admin"])).toHaveLength(18)
  })
})

describe("snippets", () => {
  it("builds the endpoint and the claude mcp lines", () => {
    const url = mcpUrl("https://mail.coursified.app/")
    expect(url).toBe("https://mail.coursified.app/mcp")
    expect(claudeAdd(url, "sk_x")).toBe(
      'claude mcp add --transport http mailyard https://mail.coursified.app/mcp --header "Authorization: Bearer sk_x"',
    )
    expect(claudeSwap(url, "sk_y").split("\n")[0]).toBe("claude mcp remove mailyard")
    expect(anyClient(url, "sk_x")).toContain("Header  Authorization: Bearer sk_x")
  })
})

describe("agent status and caps", () => {
  it("reads removed, revoked and active", () => {
    expect(agentStatus({ key: { revoked: false }, removedAt: null })).toBe("active")
    expect(agentStatus({ key: { revoked: true }, removedAt: null })).toBe("revoked")
    expect(agentStatus({ key: null, removedAt: null })).toBe("revoked")
    expect(agentStatus({ key: { revoked: true }, removedAt: 1 })).toBe("removed")
  })
  it("computes the cap bar", () => {
    expect(capPercent(12, 50)).toBe(24)
    expect(capPercent(80, 50)).toBe(100)
    expect(capPercent(3, null)).toBeNull()
    expect(capPercent(0, 0)).toBe(100)
  })
})

describe("limits", () => {
  it("reads wire limits", () => {
    expect(
      toLimits({ sendsPerDay: "50", recipients: "any", allowDomains: ["a.com"], requireApproval: false }),
    ).toEqual({
      sendsPerDay: 50,
      recipients: "any",
      allowDomains: ["a.com"],
      requireApproval: false,
    })
    expect(toLimits(null)).toBeNull()
  })
  it("normalises and validates allowed domains", () => {
    expect(normaliseDomain(" https://Gmail.com/inbox ")).toBe("gmail.com")
    expect(normaliseDomain("@outlook.com")).toBe("outlook.com")
    expect(addDomains(["gmail.com"], "gmail.com, yahoo.com nope")).toEqual({
      domains: ["gmail.com", "yahoo.com"],
      invalid: ["nope"],
    })
  })
  it("refuses an empty allow-list and a bad cap", () => {
    expect(limitsProblems(DEFAULT_LIMITS)).toEqual({})
    expect(limitsProblems({ ...DEFAULT_LIMITS, recipients: "domains" }).allowDomains).toBeTruthy()
    expect(limitsProblems({ ...DEFAULT_LIMITS, sendsPerDay: -1 }).sendsPerDay).toBeTruthy()
    expect(limitsProblems({ ...DEFAULT_LIMITS, sendsPerDay: 1.5 }).sendsPerDay).toBeTruthy()
    expect(limitsProblems({ ...DEFAULT_LIMITS, sendsPerDay: null })).toEqual({})
  })
  it("describes limits in words", () => {
    expect(describeLimits(DEFAULT_LIMITS)).toBe("50 sends a day, contacts only, approval on")
    expect(describeLimits(null)).toMatch(/No limits/)
    expect(
      describeLimits({
        sendsPerDay: null,
        recipients: "domains",
        allowDomains: ["a.com"],
        requireApproval: false,
      }),
    ).toBe("no daily cap, only a.com, approval off")
  })
})

describe("mailbox memberships", () => {
  const current = {
    members: [
      { apiKeyId: "key_a", role: "owner" as const },
      { apiKeyId: "key_b", role: "viewer" as const },
    ],
    people: [{ memberId: "mem_1", access: "member" as const }],
  }
  it("adds a key and keeps everyone else", () => {
    expect(mergeMembers(current, "key_new", "member")).toEqual([
      { apiKeyId: "key_a", role: "owner" },
      { apiKeyId: "key_b", role: "viewer" },
      { apiKeyId: "key_new", role: "member" },
      { memberId: "mem_1", access: "member" },
    ])
  })
  it("changes and removes a key, and skips no-ops", () => {
    expect(
      mergeMembers(current, "key_b", "member")?.find((m) => "apiKeyId" in m && m.apiKeyId === "key_b"),
    ).toEqual({
      apiKeyId: "key_b",
      role: "member",
    })
    expect(mergeMembers(current, "key_b", "none")).toHaveLength(2)
    expect(mergeMembers(current, "key_b", "viewer")).toBeNull()
    expect(mergeMembers(current, "key_zzz", "none")).toBeNull()
  })
})

describe("addresses", () => {
  it("suggests a local part and checks it", () => {
    expect(suggestLocal("Enrolment helper")).toBe("enrolment-helper")
    expect(suggestLocal("  Café Bot! ")).toBe("cafe-bot")
    expect(isLocalPart("enrol")).toBe(true)
    expect(isLocalPart("-bad")).toBe(false)
    expect(localOf("support@coursified.app")).toBe("support@")
  })
})

describe("agent activity (HAL-3461)", () => {
  it("names the audited reads, sends and holds", () => {
    expect(activityKind("mcp.search_mail")).toMatchObject({ label: "Searched mail", icon: "search" })
    expect(activityKind("mcp.wait_for_mail").label).toBe("Waited for mail")
    expect(activityKind("message.send")).toMatchObject({ label: "Sent", tone: "is-pass" })
    expect(activityKind("approval.request").tone).toBe("is-warn")
    expect(activityKind("agent.update").label).toBe("")
  })
  it("reads only ids and the query from after", () => {
    expect(readRefs({ mailboxId: "mbx_1", threadId: "thr_1", query: "is:unread", body: "secret" })).toEqual({
      mailboxId: "mbx_1",
      threadId: "thr_1",
      query: "is:unread",
    })
    expect(readRefs(null)).toEqual({})
  })
  it("builds the long-poll line", () => {
    expect(waitCurl("https://m.x/", "mbx_1")).toContain("https://m.x/v1/mailboxes/mbx_1/wait?timeout=50")
  })
})

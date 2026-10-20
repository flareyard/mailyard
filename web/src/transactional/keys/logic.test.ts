import { describe, expect, it } from "vitest"
import {
  addDomain,
  draftProblem,
  isUnlimited,
  type KeyDraft,
  type KeyLike,
  keyState,
  keysMeta,
  limitsProblem,
  limitsSummary,
  normalizeAllowDomain,
  orderScopes,
  parseGrace,
  purposeCounts,
  replacementOf,
  toDraft,
  toggleScope,
  toLimits,
  withKind,
} from "./logic.ts"

const now = Date.UTC(2026, 9, 17, 17, 48)
const key = (over: Partial<KeyLike>): KeyLike => ({
  id: "key_1",
  name: "Billing worker",
  kind: "secret",
  purpose: "api",
  prefix: "sk_x",
  scopes: ["send"],
  revokedAt: null,
  createdAt: now - 86_400_000,
  ...over,
})

describe("key state", () => {
  it("reads active, rotating and revoked from revokedAt", () => {
    expect(keyState(key({}), now)).toBe("active")
    expect(keyState(key({ revokedAt: now + 3600_000 }), now)).toBe("rotating")
    expect(keyState(key({ revokedAt: now - 1 }), now)).toBe("revoked")
    expect(keyState(key({ revokedAt: String(now + 10) }), now)).toBe("rotating")
  })
  it("counts and summarises", () => {
    const keys = [key({}), key({ id: "b", purpose: "mcp" }), key({ id: "c", revokedAt: now - 1 })]
    expect(purposeCounts(keys)).toEqual({ all: 3, api: 2, mcp: 1 })
    expect(keysMeta(keys, now)).toBe("2 active · 1 revoked")
  })
  it("finds a rotation's replacement", () => {
    const old = key({ revokedAt: now + 1000 })
    const fresh = key({ id: "key_2", createdAt: now })
    expect(replacementOf(old, [old, fresh], now)?.id).toBe("key_2")
    expect(replacementOf(old, [old], now)).toBeUndefined()
  })
})

describe("create draft", () => {
  const d: KeyDraft = { name: "Mobile app", kind: "secret", scopes: ["send", "track"], purpose: "mcp" }
  it("narrows a public key to track and api", () => {
    expect(withKind(d, "public")).toEqual({ ...d, kind: "public", scopes: ["track"], purpose: "api" })
    expect(toggleScope(withKind(d, "public"), "send").scopes).toEqual(["track"])
  })
  it("toggles scopes on a secret key", () => {
    expect(toggleScope(d, "read").scopes).toEqual(["send", "track", "read"])
    expect(toggleScope(d, "send").scopes).toEqual(["track"])
  })
  it("names what blocks creation", () => {
    expect(draftProblem(d)).toBeNull()
    expect(draftProblem({ ...d, name: " " })).toMatch(/name/)
    expect(draftProblem({ ...d, scopes: [] })).toMatch(/scope/)
    expect(draftProblem({ ...d, kind: "public", scopes: ["track"] })).toBe(
      "Public keys can’t be used for MCP",
    )
  })
  it("orders scopes canonically", () => {
    expect(orderScopes(["admin", "read", "send"])).toEqual(["send", "read", "admin"])
  })
})

describe("grace", () => {
  it("clamps to 0..604800", () => {
    expect(parseGrace("86400")).toBe(86400)
    expect(parseGrace("-5")).toBe(0)
    expect(parseGrace("9999999")).toBe(604800)
    expect(parseGrace("")).toBeNull()
    expect(parseGrace("abc")).toBeNull()
  })
})

describe("limits", () => {
  it("normalises domains", () => {
    expect(normalizeAllowDomain(" @Gmail.com ")).toBe("gmail.com")
    expect(normalizeAllowDomain("https://coursified.app/x")).toBe("coursified.app")
    expect(normalizeAllowDomain("not a domain")).toBeNull()
    expect(addDomain(["gmail.com"], "GMAIL.com").list).toEqual(["gmail.com"])
    expect(addDomain([], "nope").error).toMatch(/isn’t a domain/)
  })
  it("validates and builds the body", () => {
    const d = toDraft(null)
    expect(d).toEqual({ cap: "", recipients: "any", allowDomains: [], requireApproval: false })
    expect(isUnlimited(toLimits(d))).toBe(true)
    expect(limitsProblem({ ...d, cap: "1.5" })).toMatch(/whole number/)
    expect(limitsProblem({ ...d, recipients: "domains" })).toMatch(/domain/)
    const l = toLimits({
      cap: "50",
      recipients: "domains",
      allowDomains: ["a.com", "b.com"],
      requireApproval: true,
    })
    expect(l).toEqual({
      sendsPerDay: 50,
      recipients: "domains",
      allowDomains: ["a.com", "b.com"],
      requireApproval: true,
    })
    expect(limitsSummary(l)).toBe("50 a day · a.com +1 · approval")
    expect(limitsSummary(null)).toBe("No limits")
    expect(
      toLimits({ cap: "", recipients: "contacts", allowDomains: ["x.com"], requireApproval: false })
        .allowDomains,
    ).toEqual([])
  })
})

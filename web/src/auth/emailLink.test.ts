import { describe, expect, it } from "vitest"
import { ApiError } from "../api/client.ts"
import { emailLooksValid, linkOutcome } from "./emailLink.ts"

describe("email sign-in link outcomes", () => {
  it("reports sent without saying whether the address is a member", () => {
    expect(linkOutcome("tolu@coursified.app", {})).toEqual({ kind: "sent", email: "tolu@coursified.app" })
  })
  it("knows there's no system sender", () => {
    expect(
      linkOutcome("a@b.co", { error: new ApiError(503, { _tag: "NoSystemSender", message: "x" }) }),
    ).toEqual({ kind: "no-sender" })
  })
  it("counts down a rate limit", () => {
    expect(
      linkOutcome("a@b.co", { error: new ApiError(429, { _tag: "RateLimited", retryAfter: 42 }) }),
    ).toEqual({
      kind: "rate-limited",
      retryAfter: 42,
    })
    expect(linkOutcome("a@b.co", { error: new ApiError(429, {}) })).toEqual({
      kind: "rate-limited",
      retryAfter: 60,
    })
  })
  it("separates outages from refusals", () => {
    expect(linkOutcome("a@b.co", { error: new TypeError("Failed to fetch") })).toEqual({
      kind: "unreachable",
    })
    expect(linkOutcome("a@b.co", { error: new ApiError(502, { message: "bad gateway" }) })).toEqual({
      kind: "unreachable",
    })
    expect(
      linkOutcome("a@b.co", { error: new ApiError(400, { message: "Not an email.", requestId: "r1" }) }),
    ).toEqual({
      kind: "other",
      message: "Not an email.",
      requestId: "r1",
    })
  })
  it("checks the address before a round trip", () => {
    expect(emailLooksValid(" tolu@coursified.app ")).toBe(true)
    expect(emailLooksValid("tolu")).toBe(false)
    expect(emailLooksValid("tolu@x")).toBe(false)
  })
})

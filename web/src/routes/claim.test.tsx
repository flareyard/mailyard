// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { takeClaimToken } from "../auth/claimLink.ts"

const at = (hash: string) => window.history.replaceState(null, "", `/claim${hash}`)

describe("takeClaimToken", () => {
  it("reads the token from the fragment and removes it from the address bar", () => {
    at("#token=abc%2D123")
    expect(takeClaimToken()).toBe("abc-123")
    expect(window.location.hash).toBe("")
    expect(window.location.pathname).toBe("/claim")
  })
  it("finds it after other fragment fields, and leaves pages without one alone", () => {
    at("#x=1&token=t9")
    expect(takeClaimToken()).toBe("t9")
    at("")
    expect(takeClaimToken()).toBeNull()
    at("#tokens=nope")
    expect(takeClaimToken()).toBeNull()
    expect(window.location.hash).toBe("#tokens=nope")
  })
})

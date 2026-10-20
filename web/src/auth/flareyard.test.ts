import { describe, expect, it } from "vitest"
import { FLAREYARD_ERRORS, isFlareyardError } from "./flareyard.ts"

describe("Flareyard sign-in errors", () => {
  it("recognises every reason the hand-off can return, and nothing else", () => {
    for (const r of [
      "flareyard_state",
      "flareyard_session_expired",
      "flareyard_denied",
      "flareyard_wrong_install",
      "flareyard_refused",
      "flareyard_unreachable",
    ]) {
      expect(isFlareyardError(r)).toBe(true)
      expect(FLAREYARD_ERRORS[r as keyof typeof FLAREYARD_ERRORS].length).toBeGreaterThan(20)
    }
    expect(isFlareyardError("session-expired")).toBe(false)
    expect(isFlareyardError("toString")).toBe(false)
    expect(isFlareyardError(undefined)).toBe(false)
  })
  it("points people who can't use Flareyard at email sign-in", () => {
    expect(FLAREYARD_ERRORS.flareyard_unreachable).toMatch(/email/)
    expect(FLAREYARD_ERRORS.flareyard_refused).toMatch(/email/)
  })
})

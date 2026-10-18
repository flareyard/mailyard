import { describe, expect, it } from "vitest"
import { countdown, exporting, latestComplete, referrers } from "./logic.ts"

describe("countdown", () => {
  const now = 1_000_000_000
  it("reads days and hours, then hours and minutes", () => {
    expect(countdown(now + 7 * 86_400_000 - 3_600_000, now)).toBe("6 days 23 hours")
    expect(countdown(now + 86_400_000, now)).toBe("1 day")
    expect(countdown(now + 5 * 3_600_000 + 12 * 60_000, now)).toBe("5 hours 12 minutes")
    expect(countdown(now + 12 * 60_000, now)).toBe("12 minutes")
    expect(countdown(now + 30_000, now)).toBe("less than a minute")
  })
})

describe("mailbox removal", () => {
  it("finds what still delivers there", () => {
    const all = [
      { id: "mbx_a", address: "a@x", kind: "user", targetIds: [] },
      { id: "mbx_team", address: "team@x", kind: "group", targetIds: ["mbx_a", "mbx_b"] },
      { id: "mbx_b", address: "b@x", kind: "user", targetIds: [] },
    ]
    expect(referrers(all, "mbx_a").map((m) => m.id)).toEqual(["mbx_team"])
    expect(referrers(all, "mbx_team")).toEqual([])
  })
  it("picks the newest complete export", () => {
    const ex = [
      { id: 1, status: "complete" as const, messageCount: 10, createdAt: 1, completedAt: 2 },
      { id: 2, status: "complete" as const, messageCount: 12, createdAt: 3, completedAt: 4 },
      { id: 3, status: "running" as const, messageCount: 0, createdAt: 5, completedAt: null },
    ]
    expect(latestComplete(ex)?.id).toBe(2)
    expect(latestComplete([])).toBeNull()
    expect(exporting(ex)).toBe(true)
  })
})

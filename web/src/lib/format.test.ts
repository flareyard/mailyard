import { describe, expect, it } from "vitest"
import { fmtAgo, fmtIn, fmtInt, fmtPct, num, toDate } from "./format.ts"

describe("format", () => {
  it("reads numbers the API sends as strings", () => {
    expect(num("412")).toBe(412)
    expect(num(3.5)).toBe(3.5)
    expect(num("NaN")).toBeNull()
    expect(num(null)).toBeNull()
    expect(fmtInt("3786")).toBe("3,786")
    expect(fmtInt(undefined)).toBe("—")
  })
  it("formats rates without trailing zeros", () => {
    expect(fmtPct(0.02)).toBe("2%")
    expect(fmtPct(0.0012, 2)).toBe("0.12%")
  })
  it("reads ISO and epoch-millisecond timestamps", () => {
    expect(toDate("1760000000000")?.getTime()).toBe(1760000000000)
    expect(toDate("2026-10-18T00:00:00Z")?.toISOString()).toBe("2026-10-18T00:00:00.000Z")
  })
  it("says how long ago and how long until", () => {
    const now = Date.parse("2026-10-18T12:00:00Z")
    expect(fmtAgo("2026-10-18T11:30:00Z", now)).toBe("30 minutes ago")
    expect(fmtAgo("2026-10-18T09:00:00Z", now)).toBe("3 hours ago")
    expect(fmtIn("2026-10-19T00:00:00Z", now)).toBe("in 12 h 0 min")
  })
})

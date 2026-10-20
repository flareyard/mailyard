import { describe, expect, it } from "vitest"
import {
  fmtBytes,
  fmtCountdown,
  fmtDuration,
  fmtSeconds,
  fromLocalInput,
  isRecent,
  pct,
  plural,
  toLocalInput,
  utcFull,
  utcShort,
  utcTime,
} from "./format.ts"

describe("pct", () => {
  it("uses two decimals under 1% and one otherwise", () => {
    expect(pct(0.0042)).toBe("0.42%")
    expect(pct(0.021)).toBe("2.1%")
    expect(pct(0.98)).toBe("98%")
    expect(pct(0)).toBe("0%")
    expect(pct("0.001")).toBe("0.1%")
    expect(pct(null)).toBe("—")
  })
})

describe("UTC times", () => {
  const t = Date.UTC(2026, 9, 17, 17, 48, 5)
  it("formats in UTC with the zone written", () => {
    expect(utcTime(t)).toBe("17:48 UTC")
    expect(utcTime(t, true)).toBe("17:48:05 UTC")
    expect(utcFull(t)).toBe("Sat 17 Oct 2026, 17:48 UTC")
    expect(utcShort(t)).toBe("Sat 17 Oct, 17:48 UTC")
    expect(utcTime(null)).toBe("—")
  })
  it("round-trips datetime-local values as UTC", () => {
    expect(toLocalInput(t)).toBe("2026-10-17T17:48")
    expect(fromLocalInput("2026-10-17T17:48")).toBe(Date.UTC(2026, 9, 17, 17, 48))
    expect(fromLocalInput("")).toBeNull()
    expect(fromLocalInput("nope")).toBeNull()
  })
  it("knows what's within a week", () => {
    expect(isRecent(t, t + 86_400_000)).toBe(true)
    expect(isRecent(t, t + 8 * 86_400_000)).toBe(false)
  })
})

describe("sizes and durations", () => {
  it("formats bytes", () => {
    expect(fmtBytes(628)).toBe("628 B")
    expect(fmtBytes(325 * 1024)).toBe("325 KB")
    expect(fmtBytes(1.4 * 1024 * 1024)).toBe("1.4 MB")
    expect(fmtBytes(null)).toBe("—")
  })
  it("formats durations", () => {
    expect(fmtDuration(850)).toBe("850 ms")
    expect(fmtDuration(4200)).toBe("4.2 s")
    expect(fmtDuration(180_000)).toBe("3 min")
    expect(fmtDuration(125 * 60_000)).toBe("2 h 5 min")
    expect(fmtDuration(3 * 86_400_000)).toBe("3 d")
  })
  it("names grace periods", () => {
    expect(fmtSeconds(0)).toBe("Now")
    expect(fmtSeconds(3600)).toBe("1 hour")
    expect(fmtSeconds(86400)).toBe("1 day")
    expect(fmtSeconds(604800)).toBe("7 days")
    expect(fmtSeconds(5400)).toBe("90 minutes")
    expect(fmtSeconds(61)).toBe("61 seconds")
  })
  it("pluralises", () => {
    expect(plural(1, "message")).toBe("1 message")
    expect(plural(1312, "letter")).toBe("1,312 letters")
    expect(plural(2, "entry", "entries")).toBe("2 entries")
  })
})

describe("fmtCountdown", () => {
  const now = Date.UTC(2026, 9, 18, 12, 0)
  it("names the biggest two units", () => {
    expect(fmtCountdown(now + (6 * 1440 + 23 * 60 + 5) * 60_000, now)).toBe("6 days 23 hours")
    expect(fmtCountdown(now + 86_400_000, now)).toBe("1 day")
    expect(fmtCountdown(now + (5 * 60 + 12) * 60_000, now)).toBe("5 hours 12 minutes")
    expect(fmtCountdown(now + 60 * 60_000, now)).toBe("1 hour")
    expect(fmtCountdown(now + 12 * 60_000, now)).toBe("12 minutes")
    expect(fmtCountdown(now + 10_000, now)).toBe("less than a minute")
    expect(fmtCountdown(now - 10_000, now)).toBe("less than a minute")
  })
})

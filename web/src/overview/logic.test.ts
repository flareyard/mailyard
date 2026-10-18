import { describe, expect, it } from "vitest"
import {
  ago,
  classifyRate,
  costBreakdown,
  DEFAULT_POLICY,
  fmtQuantile,
  fmtRate,
  funnelRows,
  niceMax,
  rangeForKey,
  sparkPaths,
  splitOnLabel,
  stackBars,
  subjectHref,
  thresholdGeometry,
  worstCheck,
  worstLevel,
  xLabelShown,
} from "./logic.ts"

const enough = { sent: 1809, minimum: 100 }

describe("classifyRate against Cloudflare's thresholds", () => {
  const bounce = DEFAULT_POLICY.customer_bounce
  const complaint = DEFAULT_POLICY.complaint
  const spam = DEFAULT_POLICY.spam_rejection

  it("bounce: under 2% is ok, from 2% warning, from 5% at risk", () => {
    expect(classifyRate(0.0094, bounce, enough)).toBe("ok")
    expect(classifyRate(0.0199, bounce, enough)).toBe("ok")
    expect(classifyRate(0.02, bounce, enough)).toBe("warning")
    expect(classifyRate(0.049, bounce, enough)).toBe("warning")
    expect(classifyRate(0.05, bounce, enough)).toBe("at-risk")
    expect(classifyRate(0.2, bounce, enough)).toBe("at-risk")
  })

  it("complaint: 0.1% warning, 0.2% at risk", () => {
    expect(classifyRate(0.0006, complaint, enough)).toBe("ok")
    expect(classifyRate(0.001, complaint, enough)).toBe("warning")
    expect(classifyRate(0.002, complaint, enough)).toBe("at-risk")
  })

  it("spam rejection: 1% warning, 3% at risk", () => {
    expect(classifyRate(0.0028, spam, enough)).toBe("ok")
    expect(classifyRate(0.01, spam, enough)).toBe("warning")
    expect(classifyRate(0.03, spam, enough)).toBe("at-risk")
  })

  it("is not enough data under 100 sends, whatever the rate", () => {
    expect(classifyRate(0.5, bounce, { sent: 99, minimum: 100 })).toBe("insufficient-data")
    expect(classifyRate(0.5, bounce, { sent: 100, minimum: 100 })).toBe("at-risk")
    expect(classifyRate(0, bounce, { sent: 0 })).toBe("insufficient-data")
  })

  it("is not enough data when the API says so or the rate is null", () => {
    expect(classifyRate(0.01, bounce, { sent: 5000, insufficient: true })).toBe("insufficient-data")
    expect(classifyRate(null, bounce, enough)).toBe("insufficient-data")
  })

  it("reads wire numbers encoded as strings", () => {
    expect(classifyRate("0.03", { warning_at: "0.02", at_risk_at: "0.05" }, { sent: "1809" })).toBe("warning")
  })

  it("worstLevel picks at-risk over warning over ok, and keeps all-insufficient", () => {
    expect(worstLevel(["ok", "warning", "insufficient-data"])).toBe("warning")
    expect(worstLevel(["ok", "at-risk"])).toBe("at-risk")
    expect(worstLevel(["insufficient-data", "insufficient-data"])).toBe("insufficient-data")
  })
})

describe("thresholdGeometry", () => {
  it("puts the at-risk line at 62.5% and scales the fill to 1.6 × at risk", () => {
    const g = thresholdGeometry(0.0094, 0.02, 0.05)
    expect(g.riskAt).toBeCloseTo(62.5)
    expect(g.warnAt).toBeCloseTo(25)
    expect(g.fill).toBeCloseTo(11.75)
  })
  it("caps the fill at 100% and draws none for a null rate", () => {
    expect(thresholdGeometry(1, 0.02, 0.05).fill).toBe(100)
    expect(thresholdGeometry(null, 0.02, 0.05).fill).toBe(0)
  })
})

describe("fmtRate", () => {
  it("uses two decimals under 1% and one from 1%", () => {
    expect(fmtRate(0.0094)).toBe("0.94%")
    expect(fmtRate(0.001)).toBe("0.10%")
    expect(fmtRate(0.02)).toBe("2.0%")
    expect(fmtRate(0.981)).toBe("98.1%")
    expect(fmtRate(null)).toBe("—")
  })
})

describe("funnelRows", () => {
  const totals = {
    sent: 1809,
    delivered: 1774,
    deferred: 11,
    bouncedHard: 7,
    bouncedSoft: 10,
    complained: 1,
    rejected: 5,
    failed: 2,
  }

  it("gives each outcome as a share of sent", () => {
    const { sent, rows } = funnelRows(totals)
    expect(sent).toBe(1809)
    const by = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(by.delivered?.pct).toBe("98.1%")
    expect(by.delivered?.width).toBeCloseTo(98.07, 2)
    expect(by.deferred?.pct).toBe("0.6%")
    expect(by.bouncedHard?.pct).toBe("0.4%")
    expect(by.complained?.pct).toBe("0.1%")
    expect(by.complained?.width).toBeCloseTo(0.055, 3)
  })

  it("keeps the design's order and labels", () => {
    expect(funnelRows(totals).rows.map((r) => r.label)).toEqual([
      "Delivered",
      "Deferred",
      "Bounced hard",
      "Bounced soft",
      "Complained",
      "Rejected",
      "Failed",
    ])
  })

  it("shows a dash, not 0% or NaN, when nothing was sent", () => {
    const { rows } = funnelRows({ ...totals, sent: 0, delivered: 0 })
    expect(rows.every((r) => r.pct === "—" && r.width === 0)).toBe(true)
  })

  it("reads string-encoded counts and never draws past 100%", () => {
    const { rows } = funnelRows({ ...totals, sent: "10", delivered: "12" })
    expect(rows[0]?.count).toBe(12)
    expect(rows[0]?.width).toBe(100)
  })
})

describe("fmtQuantile", () => {
  it("formats bucket upper bounds", () => {
    expect(fmtQuantile(2000, 401)).toBe("≤ 2 s")
    expect(fmtQuantile(60_000, 401)).toBe("≤ 1 min")
    expect(fmtQuantile(10_800_000, 401)).toBe("≤ 3 h")
  })
  it("says over a day for a null quantile with samples, none yet without", () => {
    expect(fmtQuantile(null, 4)).toBe("over a day")
    expect(fmtQuantile(null, 0)).toBe("none yet")
  })
})

describe("stacked-bar scaling", () => {
  const day = (t: number, c: number, a: number, m: number) => ({
    byStream: { transactional: t, campaign: c, automation: a, mailbox: m },
  })
  const week = [
    day(118, 0, 22, 9),
    day(104, 0, 19, 4),
    day(142, 380, 25, 14),
    day(151, 0, 27, 17),
    day(139, 0, 24, 12),
    day(147, 0, 28, 15),
    day(96, 280, 21, 15),
  ]

  it("niceMax rounds the peak up to four even steps", () => {
    expect(niceMax(561)).toEqual({ top: 800, step: 200 })
    expect(niceMax(149)).toEqual({ top: 200, step: 50 })
    expect(niceMax(1)).toEqual({ top: 40, step: 10 })
    expect(niceMax(40)).toEqual({ top: 40, step: 10 })
    expect(niceMax(41)).toEqual({ top: 80, step: 20 })
    expect(niceMax(3_000_000)).toEqual({ top: 4_000_000, step: 1_000_000 })
  })

  it("scales every segment against the shared axis top, as the design draws it", () => {
    const { top, step, cols, totals } = stackBars(week)
    expect(top).toBe(800)
    expect(step).toBe(200)
    expect(cols[0]?.segs.map((s) => [s.stream, Number(s.height.toFixed(2))])).toEqual([
      ["transactional", 14.75],
      ["automation", 2.75],
      ["mailbox", 1.13],
    ])
    expect(cols[2]?.segs.find((s) => s.stream === "campaign")?.height).toBeCloseTo(47.5)
    expect(totals).toEqual({ transactional: 897, campaign: 660, automation: 166, mailbox: 86 })
  })

  it("omits zero segments and keeps a column's height equal to its total over top", () => {
    const { cols, top } = stackBars(week)
    expect(cols[0]?.segs.some((s) => s.stream === "campaign")).toBe(false)
    for (const c of cols) expect(c.segs.reduce((a, s) => a + s.height, 0)).toBeCloseTo((c.total / top) * 100)
  })

  it("handles an empty range without dividing by zero", () => {
    const { top, cols } = stackBars([day(0, 0, 0, 0)])
    expect(top).toBe(40)
    expect(cols[0]?.segs).toEqual([])
  })

  it("thins x labels to every nth, counted back from the last", () => {
    const shown = Array.from({ length: 24 }, (_, i) => i).filter((i) => xLabelShown(i, 24, 6))
    expect(shown).toEqual([5, 11, 17, 23])
    expect(xLabelShown(3, 7, null)).toBe(true)
  })
})

describe("sparkPaths", () => {
  it("breaks the line at a null day instead of dipping", () => {
    const s = sparkPaths([10, 12, null, 14, 16])
    expect(s.lines).toHaveLength(2)
    expect(s.gaps).toBe(1)
    expect(s.first).toBe(10)
    expect(s.last).toBe(16)
  })
  it("draws a lone point as a dot", () => {
    const s = sparkPaths([10, null, 12, 13])
    expect(s.dots).toHaveLength(1)
    expect(s.lines).toHaveLength(1)
  })
})

describe("cost", () => {
  it("caps the meter at 100% and computes the projected overage", () => {
    const c = costBreakdown({ billed: 3786, included: 3000, projectedBilled: 6628 })
    expect(c.billedPct).toBe(100)
    expect(c.projectedPct).toBe(100)
    expect(c.projectedOverage).toBe(3628)
  })
  it("has no overage under the included sends", () => {
    const c = costBreakdown({ billed: 600, included: 3000, projectedBilled: 1500 })
    expect(c.billedPct).toBe(20)
    expect(c.projectedOverage).toBe(0)
  })
})

describe("small helpers", () => {
  const now = Date.parse("2026-10-18T17:48:00Z")
  it("ago uses the design's short units and a date from 7 days", () => {
    expect(ago(new Date(now - 30_000), now)).toBe("just now")
    expect(ago(new Date(now - 18 * 60_000), now)).toBe("18 min ago")
    expect(ago(new Date(now - 8 * 3_600_000), now)).toBe("8 h ago")
    expect(ago(new Date(now - 4 * 86_400_000), now)).toBe("4 d ago")
    expect(ago(new Date(now - 9 * 86_400_000), now)).toBe("9 Oct 2026")
  })
  it("worstCheck reports checking first, then fail, error, warn", () => {
    expect(worstCheck(["pass", "warn", "fail"])).toBe("fail")
    expect(worstCheck(["pass", "checking", "fail"])).toBe("checking")
    expect(worstCheck(["pass", "pass"])).toBe("pass")
  })
  it("maps range keys", () => {
    expect(rangeForKey("1")).toBe("24h")
    expect(rangeForKey("2")).toBe("7d")
    expect(rangeForKey("3")).toBe("30d")
    expect(rangeForKey("4")).toBeNull()
  })
  it("links feed subjects to the entity routes and only the label", () => {
    expect(subjectHref({ type: "campaign", id: "cmp_1" })).toBe("/campaigns/cmp_1")
    expect(subjectHref({ type: "contact", id: "con_1" })).toBe("/audience/contacts/con_1")
    expect(splitOnLabel('Domain "news.example" created', "news.example")).toEqual([
      'Domain "',
      "news.example",
      '" created',
    ])
    expect(splitOnLabel("No label here", "x")).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import {
  bucketLabel,
  countAxis,
  csvFor,
  effectiveRange,
  extraCost,
  fmtLine,
  fmtStorage,
  forecastStrip,
  hatchSpans,
  heatGrid,
  histogram,
  linePaths,
  niceMax,
  parseRecipients,
  parseSearch,
  providerName,
  quantile,
  rangeForKey,
  rangesFor,
  rateAxis,
  stackBars,
  viewFromPath,
  xLabelShown,
} from "./logic.ts"

describe("ranges", () => {
  it("offers 90d only on inbound and audience", () => {
    expect(rangesFor("inbound")).toEqual(["24h", "7d", "30d", "90d"])
    expect(rangesFor("sending")).toEqual(["24h", "7d", "30d"])
    expect(effectiveRange("sending", "90d")).toBe("30d")
    expect(effectiveRange("audience", "90d")).toBe("90d")
  })
  it("reads the view from the path", () => {
    expect(viewFromPath("/analytics/usage")).toBe("usage")
    expect(viewFromPath("/analytics")).toBe("sending")
    expect(viewFromPath("/analytics/nope")).toBeNull()
  })
  it("maps digits to the offered ranges", () => {
    expect(rangeForKey("1", ["24h", "7d", "30d"])).toBe("24h")
    expect(rangeForKey("4", ["24h", "7d", "30d"])).toBeNull()
    expect(rangeForKey("4", rangesFor("inbound"))).toBe("90d")
    expect(rangeForKey("x", ["24h"])).toBeNull()
  })
  it("parses the search, keeping 7d out and fx only in fixture mode", () => {
    expect(parseSearch({ range: "7d" }, false)).toEqual({})
    expect(parseSearch({ range: "30d", export: "1", fx: "error" }, false)).toEqual({
      range: "30d",
      export: 1,
    })
    expect(parseSearch({ fx: "error" }, true)).toEqual({ fx: "error" })
    expect(parseSearch({ range: "1y", fx: "<script>" }, true)).toEqual({})
  })
})

describe("bars and axes", () => {
  it("rounds axis tops", () => {
    expect(niceMax(149)).toEqual({ top: 200, step: 50 })
    expect(niceMax(561)).toEqual({ top: 800, step: 200 })
    expect(niceMax(3)).toEqual({ top: 4, step: 1 })
  })
  it("stacks four streams on a shared axis", () => {
    const r = stackBars([
      { byStream: { transactional: 118, campaign: 0, automation: 22, mailbox: 9 } },
      { byStream: { transactional: 142, campaign: 380, automation: 25, mailbox: "14" } },
    ])
    expect(r.top).toBe(800)
    expect(r.totals.campaign).toBe(380)
    expect(r.cols[0]?.segs.map((s) => s.stream)).toEqual(["transactional", "automation", "mailbox"])
    expect(r.cols[1]?.segs[1]?.height).toBeCloseTo(47.5)
  })
  it("shows every nth label counted back from the last", () => {
    expect([0, 1, 2, 3, 4, 5, 6].filter((i) => xLabelShown(i, 7, 3))).toEqual([0, 3, 6])
    expect(xLabelShown(5, 7, null)).toBe(true)
  })
  it("puts the at-risk line inside a rate axis", () => {
    const a = rateAxis([0.0088, 0.0101], 0.05)
    expect(a.top).toBeCloseTo(0.06)
    expect(a.ticks.map((t) => t.label)).toEqual(["0.0%", "1.5%", "3.0%", "4.5%", "6.0%"])
    expect(a.at(0.02)).toBeCloseTo(33.3, 1)
    expect(rateAxis([null], 0.002).ticks[1]?.label).toBe("0.06%")
  })
  it("writes compact count ticks", () => {
    expect(countAxis([4812], true).ticks[4]?.label).toBe("8K")
  })
})

describe("line charts", () => {
  it("breaks the line at a null instead of dipping", () => {
    const runs = linePaths([1, 2, null, 2, 4], 4)
    expect(runs).toHaveLength(2)
    expect(runs[0]?.line).toBe("M0.00,75.00 L25.00,50.00")
    expect(runs[1]?.area.endsWith("L100.00,100 L75.00,100 Z")).toBe(true)
  })
  it("draws a lone point as a short stroke", () => {
    const [run] = linePaths([null, 2, null], 4)
    expect(run?.line).toBe("M49.20,50.00 L50.80,50.00")
  })
  it("hatches flagged runs up to the next point", () => {
    const spans = hatchSpans(Array.from({ length: 30 }, (_, i) => [0, 1, 2, 14, 15].includes(i)))
    expect(spans.map((s) => [s.left.toFixed(1), s.width.toFixed(1)])).toEqual([
      ["0.0", "10.3"],
      ["48.3", "6.9"],
    ])
    expect(hatchSpans([true, true, true])).toEqual([{ left: 0, width: 100 }])
    expect(hatchSpans([false, false])).toEqual([])
  })
})

describe("delivery time", () => {
  it("words quantiles as bucket upper bounds", () => {
    expect(quantile(5000, 1940)).toBe("under 5 s")
    expect(quantile(60_000, 1)).toBe("under 1 min")
    expect(quantile(86_400_000, 1)).toBe("under a day")
    expect(quantile(null, 10)).toBe("over a day")
    expect(quantile(null, 0)).toBe("none yet")
  })
  it("labels histogram buckets", () => {
    expect(bucketLabel(1000)).toBe("< 1 s")
    expect(bucketLabel(3_600_000)).toBe("< 1 h")
    expect(bucketLabel(null)).toBe("a day or more")
    expect(
      histogram([
        { underMs: 1000, n: 10 },
        { underMs: 2000, n: 40 },
      ]).map((h) => h.width),
    ).toEqual([25, 100])
  })
})

describe("names and formats", () => {
  it("names providers", () => {
    expect(providerName("gmail")).toBe("Gmail")
    expect(providerName("fastmail")).toBe("Fastmail")
    expect(providerName("mailru")).toBe("Mailru")
    expect(providerName(null)).toBe("No provider")
  })
  it("keeps the zero in threshold labels", () => {
    expect(fmtLine(0.02)).toBe("2.0%")
    expect(fmtLine(0.001)).toBe("0.10%")
  })
  it("formats storage in decimal units", () => {
    expect(fmtStorage(1931400000)).toEqual({ value: "1.93", unit: "GB" })
    expect(fmtStorage(48200000)).toEqual({ value: "48.2", unit: "MB" })
    expect(fmtStorage(9200000)).toEqual({ value: "9.2", unit: "MB" })
    expect(fmtStorage(912000000)).toEqual({ value: "912", unit: "MB" })
    expect(fmtStorage(null).value).toBe("—")
  })
})

describe("heatmap", () => {
  it("fills a 7 × 24 grid and scales to the busiest cell", () => {
    const { grid, peak, summary } = heatGrid(
      [
        {
          weekday: "Mon",
          hours: [
            { hour: 8, opens: 36, clicks: 11 },
            { hour: 9, opens: 18, clicks: 0 },
          ],
        },
      ],
      "opens",
    )
    expect(grid).toHaveLength(7)
    expect(grid[0]?.cells).toHaveLength(24)
    expect(peak).toBe(36)
    expect(grid[0]?.cells[9]?.p).toBe(50)
    expect(grid[3]?.cells[9]?.p).toBe(0)
    expect(summary).toBe("Most opens fall between 07:00 and 10:00 UTC on weekdays")
    expect(heatGrid([], "clicks").summary).toBe("No clicks in this range")
  })
})

describe("CSV", () => {
  it("adds by for volume and delivery, and clamps 30-day charts", () => {
    expect(csvFor("volume", "24h").path).toBe("/v1/stats/volume.csv?range=24h&by=hour")
    expect(csvFor("volume", "7d")).toEqual({
      path: "/v1/stats/volume.csv?range=7d&by=day",
      file: "volume-7d.csv",
      range: "7d",
    })
    expect(csvFor("delivery", "30d").path).toBe("/v1/stats/delivery.csv?range=30d&by=day")
    expect(csvFor("providers", "90d").path).toBe("/v1/stats/providers.csv?range=30d")
    expect(csvFor("inbound", "90d").path).toBe("/v1/stats/inbound.csv?range=90d")
  })
})

describe("usage", () => {
  it("parses recipients", () => {
    expect(parseRecipients("3,400")).toBe(3400)
    expect(parseRecipients(" 12 000 ")).toBe(12000)
    expect(parseRecipients("0")).toBeNull()
    expect(parseRecipients("3.5")).toBeNull()
    expect(parseRecipients("lots")).toBeNull()
  })
  it("draws the forecast strip against the quota", () => {
    const s = forecastStrip(
      [
        { day: "2026-10-17", thisCampaign: 512 },
        { day: "2026-10-18", thisCampaign: 1000 },
        { day: "2026-10-20", thisCampaign: 888 },
      ],
      1000,
    )
    expect(s.map((d) => [d.label, d.height])).toEqual([
      ["Today", 51],
      ["Sun", 100],
      ["Tue", 89],
    ])
  })
  it("prices extra sends from the API's own figures", () => {
    expect(extraCost(3678, 3000, 0.35, 3400)).toBeCloseTo(1.19, 2)
    expect(extraCost(1000, 3000, 0.35, 1500)).toBe(0)
    expect(extraCost(2500, 3000, 0.35, 1500)).toBeCloseTo(0.35, 2)
  })
})

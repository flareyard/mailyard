import { describe, expect, it } from "vitest"
import {
  activeFilters,
  blocksLabel,
  filtersQuery,
  guessColumns,
  parseFilters,
  pushBlocked,
  readCsv,
  removeBlocked,
  removeToastSub,
  splitCsvLine,
} from "./logic.ts"

describe("rules", () => {
  it("says what a row blocks", () => {
    expect(blocksLabel({ reason: "hard_bounce", bulkOnly: false })).toBe("All mail")
    expect(blocksLabel({ reason: "unsubscribe", bulkOnly: false })).toBe("Campaigns and automations only")
    expect(blocksLabel({ reason: "complaint", bulkOnly: true })).toBe("Campaigns and automations only")
  })
  it("never removes a complaint", () => {
    expect(removeBlocked({ reason: "complaint" })?.reason).toMatch(/never be removed/)
    expect(removeBlocked({ reason: "manual" })).toBeNull()
  })
  it("pushes only all-mail rows, when Cloudflare is writable", () => {
    const row = { reason: "manual" as const, bulkOnly: false, cloudflare: "missing" as const }
    expect(pushBlocked(row, { writable: true })).toBeNull()
    expect(pushBlocked(row, { writable: false })?.reason).toMatch(/isn’t connected/)
    expect(pushBlocked({ ...row, bulkOnly: true }, { writable: true })?.reason).toMatch(/bulk mail/)
    expect(pushBlocked({ ...row, reason: "unsubscribe" }, { writable: true })?.reason).toMatch(/bulk mail/)
    expect(pushBlocked({ ...row, cloudflare: "in-sync" }, { writable: true })?.reason).toMatch(/Already/)
  })
  it("words the removal toast", () => {
    expect(removeToastSub("removed", "subscribed")).toBe(
      "Cloudflare’s entry removed too · contact back to subscribed",
    )
    expect(removeToastSub("failed", null)).toBe("Cloudflare still lists it")
  })
})

describe("filters", () => {
  it("keeps only valid values", () => {
    expect(parseFilters({ reason: "complaint", source: "nope", cloudflare: "missing", q: " ada@ " })).toEqual(
      {
        reason: "complaint",
        cloudflare: "missing",
        q: "ada@",
      },
    )
  })
  it("lists chips and the link", () => {
    const f = parseFilters({ cloudflare: "missing" })
    expect(activeFilters(f)).toEqual([{ key: "cloudflare", label: "On Cloudflare", value: "missing" }])
    expect(filtersQuery(f)).toBe("?cloudflare=missing")
    expect(filtersQuery({})).toBe("?")
  })
})

describe("csv", () => {
  it("splits quoted cells", () => {
    expect(splitCsvLine('a,"b, c","d ""e"""')).toEqual(["a", "b, c", 'd "e"'])
  })
  it("reads the header and counts rows", () => {
    const r = readCsv("﻿EMAIL,STATUS,DATE\r\nada@x.com,bounced,2026-01-01\r\nbo@y.com,spam,\r\n\r\n")
    expect(r).toEqual({
      headers: ["EMAIL", "STATUS", "DATE"],
      rows: 2,
      first: ["ada@x.com", "bounced", "2026-01-01"],
    })
  })
  it("guesses columns", () => {
    expect(guessColumns(["EMAIL", "STATUS", "DATE"])).toEqual({
      email: "EMAIL",
      reason: "STATUS",
      note: "DATE",
    })
    expect(guessColumns(["Email Address", "Comments"])).toEqual({ email: "Email Address", note: "Comments" })
    expect(guessColumns(["foo"])).toEqual({})
  })
})

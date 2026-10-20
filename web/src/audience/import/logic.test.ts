import { describe, expect, it } from "vitest"
import {
  arithmeticLine,
  cellIssue,
  checkCsvFile,
  guessMapping,
  importResult,
  importStep,
  type MappingRow,
  previewCsv,
  sampleIssues,
  samplesOf,
  typedValue,
  wireTarget,
} from "./logic.ts"

describe("reading the first rows", () => {
  it("keeps 20 rows with the line each starts on, counting quoted line breaks", () => {
    const csv = 'email,note\na@x.com,"two\nlines"\n\nb@x.com,plain\n'
    const p = previewCsv(csv, { sample: 20 })
    expect(p).toMatchObject({
      rows: 2,
      sample: [
        { line: 2, cells: ["a@x.com", "two\nlines"] },
        { line: 5, cells: ["b@x.com", "plain"] },
      ],
    })
  })
  it("leaves the sample out unless asked, so the first run's shape is unchanged", () => {
    expect(previewCsv("email\na@x.com")).toEqual({ headers: ["email"], firstRow: ["a@x.com"], rows: 1 })
  })
  it("stops sampling at the limit but still counts every row", () => {
    const csv = `email\n${Array.from({ length: 30 }, (_, i) => `u${i}@x.com`).join("\n")}`
    const p = previewCsv(csv, { sample: 20 })
    expect("sample" in p && p.sample?.length).toBe(20)
    expect("rows" in p && p.rows).toBe(30)
  })
})

describe("the file check before anything is sent", () => {
  it("catches workbooks by name and type", () => {
    expect(checkCsvFile({ name: "leads.xlsx", type: "", size: 10 })).toBe(
      "leads.xlsx is a spreadsheet workbook, not a CSV.",
    )
    expect(checkCsvFile({ name: "x", type: "application/vnd.ms-excel", size: 1 })).toMatch(/workbook/)
  })
  it("refuses empty and oversized files and anything not a CSV", () => {
    expect(checkCsvFile({ name: "a.csv", type: "text/csv", size: 0 })).toBe("a.csv is empty.")
    expect(checkCsvFile({ name: "a.csv", type: "text/csv", size: 60 * 1024 * 1024 })).toMatch(
      /limit is 50 MiB/,
    )
    expect(checkCsvFile({ name: "a.pdf", type: "application/pdf", size: 9 })).toBe("a.pdf isn’t a CSV.")
    expect(checkCsvFile({ name: "a.csv", type: "text/csv", size: 9 })).toBeNull()
  })
})

describe("mapping", () => {
  it("matches a column to a field by its registry label too", () => {
    const rows = guessMapping(["Signup Date", "Email Address"], ["signed_up_at"], {
      signed_up_at: "Signup date",
    })
    expect(rows.map((r) => [r.target, r.fieldKey])).toEqual([
      ["fields", "signed_up_at"],
      ["email", "email_address"],
    ])
  })
  it("writes the wire target", () => {
    expect(wireTarget({ column: "Plan", target: "fields", fieldKey: " plan " })).toBe("fields.plan")
    expect(wireTarget({ column: "E", target: "email", fieldKey: "e" })).toBe("email")
  })
})

describe("cells read exactly as the importer reads them", () => {
  it("numbers ignore commas; yes/no; dates parse", () => {
    expect(typedValue("number", "1,200")).toBe(1200)
    expect(typedValue("number", "lots")).toBeUndefined()
    expect(typedValue("boolean", "Y")).toBe(true)
    expect(typedValue("boolean", "maybe")).toBeUndefined()
    expect(typedValue("date", "2026-03-11")).toBe("2026-03-11T00:00:00.000Z")
    expect(typedValue("date", "15/08/2026")).toBeUndefined()
  })
  it("says why a cell won't import, in the importer's words", () => {
    const email: MappingRow = { column: "Email Address", target: "email", fieldKey: "e" }
    expect(cellIssue(email, undefined, "not-an-email")).toBe("Not an email address: not-an-email")
    expect(cellIssue(email, undefined, "")).toBe("No email.")
    expect(cellIssue(email, undefined, "ADA@Gmail.com")).toBeNull()
    expect(cellIssue({ column: "S", target: "status", fieldKey: "s" }, undefined, "active")).toBe(
      'Status must be subscribed or unsubscribed, not "active".',
    )
    expect(cellIssue({ column: "Courses", target: "fields", fieldKey: "courses" }, "number", "lots")).toBe(
      '"Courses" is a number field; "lots" isn\'t one.',
    )
    expect(cellIssue({ column: "Courses", target: "fields", fieldKey: "courses" }, "number", "")).toBeNull()
  })
  it("finds every bad cell in the sample and the first values of a column", () => {
    const mapping: MappingRow[] = [
      { column: "email", target: "email", fieldKey: "email" },
      { column: "n", target: "fields", fieldKey: "n" },
      { column: "notes", target: "ignore", fieldKey: "notes" },
    ]
    const sample = [
      { line: 2, cells: ["a@x.com", "4", "x"] },
      { line: 3, cells: ["bad", "lots", "y"] },
    ]
    const bad = sampleIssues(mapping, sample, () => "number")
    expect([...bad.keys()]).toEqual(["1:0", "1:1"])
    expect(samplesOf(sample, 2)).toEqual(["x", "y"])
  })
})

describe("results", () => {
  it("writes the arithmetic out, with suppressed only when there are some", () => {
    const c = {
      rows: 2418,
      created: 1802,
      updated: 431,
      skipped: 9,
      invalid: 153,
      duplicates: 23,
      suppressed: 9,
    }
    expect(arithmeticLine(c)).toBe(
      "1,802 created (incl. 9 suppressed) + 431 updated + 9 skipped + 153 invalid + 23 duplicates = 2,418 rows",
    )
    expect(arithmeticLine({ ...c, suppressed: 0 })).toMatch(/^1,802 created \+ 431/)
  })
  it("names the result and the step", () => {
    expect(importResult({ status: "completed", invalid: 153 })).toEqual({
      cls: "pill-warn",
      label: "153 rows invalid",
    })
    expect(importResult({ status: "completed", invalid: 0 })).toEqual({
      cls: "pill-pass",
      label: "Completed",
    })
    expect(importResult({ status: "failed", invalid: 3 }).label).toBe("Failed")
    expect(importStep("running")).toBe(4)
    expect(importStep("cancelled")).toBe(5)
    expect(importStep(null)).toBe(1)
  })
})

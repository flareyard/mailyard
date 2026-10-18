import { describe, expect, it } from "vitest"
import {
  downloadName,
  exportState,
  importTone,
  itemsLabel,
  mailImportAction,
  mailImportSummary,
  partCounts,
  took,
} from "./logic.ts"

const part = (status: "pending" | "complete" | "failed") => ({ kind: "mail", status, items: 1, error: null })

describe("workspace export", () => {
  it("reads running, ready, gaps and failed", () => {
    const base = { createdAt: 0, finishedAt: null }
    expect(exportState({ ...base, status: "running", parts: [part("pending")] })).toBe("running")
    expect(exportState({ ...base, status: "completed", parts: [part("complete")] })).toBe("ready")
    expect(exportState({ ...base, status: "completed", parts: [part("complete"), part("failed")] })).toBe(
      "gaps",
    )
    expect(exportState({ ...base, status: "failed", parts: null })).toBe("failed")
  })
  it("counts parts", () => {
    expect(
      partCounts({
        status: "running",
        parts: [part("complete"), part("pending"), part("failed")],
        createdAt: 0,
        finishedAt: null,
      }),
    ).toEqual({ done: 1, failed: 1, total: 3 })
  })
  it("labels items and duration", () => {
    expect(itemsLabel("mail", 51)).toEqual({ n: 51, unit: "messages" })
    expect(itemsLabel("settings", 1)).toEqual({ n: 1, unit: "item" })
    expect(took(0, 124_000)).toBe("2 min 4 s")
    expect(took(0, 48_000)).toBe("48 s")
    expect(took(0, 3_780_000)).toBe("1 h 3 min")
    expect(took(0, null)).toBeNull()
    expect(downloadName("mail/support@x.mbox")).toBe("support@x.mbox")
  })
})

describe("imports", () => {
  const totals = { source: 3300, imported: 3214, duplicates: 12, failed: 0 }
  it("summarises a mail import", () => {
    expect(mailImportSummary({ status: "complete", error: null, totals, folders: [] })).toBe(
      "3,214 copied, 12 duplicates, 0 failed",
    )
    expect(
      mailImportSummary({
        status: "failed",
        error: "Gmail rejected the app password.",
        totals: { ...totals, imported: 1906 },
        folders: [],
      }),
    ).toBe("Gmail rejected the app password. 1,906 copied before it stopped.")
  })
  it("offers resume or retry", () => {
    expect(mailImportAction({ status: "paused", error: null, totals, folders: [] })).toBe("resume")
    expect(mailImportAction({ status: "failed", error: "x", totals, folders: [{ retryable: 3 }] })).toBe(
      "retry",
    )
    expect(mailImportAction({ status: "failed", error: "x", totals, folders: [{ retryable: 0 }] })).toBeNull()
  })
  it("picks a tone", () => {
    expect(importTone("completed")).toBe("pill-pass")
    expect(importTone("failed")).toBe("pill-fail")
    expect(importTone("cancelled")).toBe("pill-neutral")
  })
})

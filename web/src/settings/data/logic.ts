/**
 * Pure logic for Settings → Import and export: the workspace export's state from its parts, the words for each
 * part and import, and how long it took. Tested in logic.test.ts.
 */
import { num } from "../../lib/format.ts"

type Part = {
  kind: string
  status: "pending" | "complete" | "failed"
  items: number | string
  error: string | null
}
type ExportLike = {
  status: "running" | "completed" | "failed"
  parts: readonly Part[] | null
  createdAt: number | string
  finishedAt: number | string | null
}

export type ExportState = "running" | "ready" | "gaps" | "failed"

/** Completed with a failed part is "finished with gaps": the other parts still download. */
export function exportState(e: ExportLike): ExportState {
  if (e.status === "running") return "running"
  if (e.status === "failed") return "failed"
  return (e.parts ?? []).some((p) => p.status === "failed") ? "gaps" : "ready"
}

export function partCounts(e: ExportLike): { done: number; failed: number; total: number } {
  const parts = e.parts ?? []
  return {
    done: parts.filter((p) => p.status === "complete").length,
    failed: parts.filter((p) => p.status === "failed").length,
    total: parts.length,
  }
}

/** "51 messages", "5 items", "1 item". */
export function itemsLabel(kind: string, items: number | string): { n: number; unit: string } {
  const n = num(items) ?? 0
  const unit = kind === "mail" ? (n === 1 ? "message" : "messages") : n === 1 ? "item" : "items"
  return { n, unit }
}

/** "2 min 4 s", "48 s", "1 h 3 min". */
export function took(start: number | string, end: number | string | null): string | null {
  const a = num(start)
  const b = num(end)
  if (a === null || b === null || b < a) return null
  const s = Math.round((b - a) / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/** The download name for a part: its file name without the folder ("mail/support@x.mbox" → "support@x.mbox"). */
export const downloadName = (filename: string) => filename.split("/").pop() || filename

type MailImport = {
  status: "pending" | "running" | "paused" | "complete" | "failed" | "cancelled"
  error: string | null
  totals: {
    source: number | string
    imported: number | string
    duplicates: number | string
    failed: number | string
  }
  folders: readonly { retryable: number | string }[]
}

/** "3,214 copied, 12 duplicates, 0 failed", or the error with how far it got. */
export function mailImportSummary(i: MailImport): string {
  const f = (v: number | string) => new Intl.NumberFormat("en").format(num(v) ?? 0)
  const counts = `${f(i.totals.imported)} copied, ${f(i.totals.duplicates)} duplicates, ${f(i.totals.failed)} failed`
  if (i.status === "failed" && i.error) return `${i.error} ${f(i.totals.imported)} copied before it stopped.`
  return counts
}

/** What can be done to a mail import from the list: resume a paused one, retry failed messages. */
export function mailImportAction(i: MailImport): "resume" | "retry" | null {
  if (i.status === "paused") return "resume"
  const retryable = i.folders.reduce((n, f) => n + (num(f.retryable) ?? 0), 0)
  if ((i.status === "failed" || i.status === "complete") && retryable > 0) return "retry"
  return null
}

export function importTone(status: string): "pill-pass" | "pill-fail" | "pill-warn" | "pill-neutral" {
  if (status === "complete" || status === "completed") return "pill-pass"
  if (status === "failed") return "pill-fail"
  if (status === "paused" || status === "running" || status === "queued" || status === "pending")
    return "pill-warn"
  return "pill-neutral"
}

/**
 * Pure logic for the danger zone: the deletion countdown, which mailboxes still deliver to one being deleted,
 * and whether a mailbox's newest export can protect its mail. Tested in logic.test.ts.
 */
import { num } from "../../lib/format.ts"

/** "6 days 23 hours", "5 hours 12 minutes", "12 minutes", "less than a minute". */
export function countdown(deletesAt: number | string, now = Date.now()): string {
  const ms = (num(deletesAt) ?? now) - now
  if (ms <= 60_000) return "less than a minute"
  const min = Math.floor(ms / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  const part = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`
  if (d) return h ? `${part(d, "day")} ${part(h, "hour")}` : part(d, "day")
  if (h) return m ? `${part(h, "hour")} ${part(m, "minute")}` : part(h, "hour")
  return part(m, "minute")
}

type Box = { id: string; address: string; kind: string; targetIds: readonly string[] }

/** The aliases and groups that still deliver to `id` (the API refuses the delete while any do). */
export function referrers(all: readonly Box[], id: string): Box[] {
  return all.filter((m) => m.id !== id && m.targetIds.includes(id))
}

type MailboxExport = {
  status: "pending" | "running" | "complete" | "failed"
  messageCount: number | string
  createdAt: number | string
  completedAt: number | string | null
}

/** The newest complete export, which is the only kind that can count. */
export function latestComplete<T extends MailboxExport>(exports: readonly T[]): T | null {
  return (
    [...exports]
      .filter((e) => e.status === "complete")
      .sort(
        (a, b) => (num(b.completedAt ?? b.createdAt) ?? 0) - (num(a.completedAt ?? a.createdAt) ?? 0),
      )[0] ?? null
  )
}

/** Whether any export is still being written (so "Export now" would only queue another). */
export const exporting = (exports: readonly MailboxExport[]) =>
  exports.some((e) => e.status === "pending" || e.status === "running")

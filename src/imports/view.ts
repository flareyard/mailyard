import type { mailboxImports } from "../db/schema.ts"

type ImportRow = typeof mailboxImports.$inferSelect

/**
 * An import as the API and the live socket show it: never the password; totals summed across
 * folders; the rate over the time it has been moving (paused time left out) and the ETA from it.
 */
export const importView = (r: ImportRow, now = Date.now()) => {
  const progress = r.progress ?? []
  const sum = (key: "source" | "imported" | "duplicates" | "failed" | "skipped") =>
    progress.reduce((n, p) => n + (p[key] ?? 0), 0)
  const source = sum("source")
  const done = sum("imported") + sum("duplicates") + sum("failed") + sum("skipped")
  const end = r.status === "paused" && r.pausedAt ? r.pausedAt : (r.finishedAt ?? now)
  const movingMs = r.startedAt !== null ? Math.max(0, end - r.startedAt - r.pausedMs) : 0
  // A minute's worth of movement before the rate says anything: the first batch alone is noise.
  const ratePerMinute =
    movingMs >= 60_000 && done > 0 ? Math.round((done / movingMs) * 60_000 * 10) / 10 : null
  const remaining = Math.max(0, source - done)
  const etaAt =
    r.status === "running" && ratePerMinute && remaining > 0
      ? Math.round(now + (remaining / ratePerMinute) * 60_000)
      : null
  return {
    id: r.id,
    source: r.source,
    mode: r.mode,
    host: r.host,
    port: r.port,
    username: r.username,
    status: r.status,
    error: r.error,
    folders: progress.map(({ raw: _, failedUids, ...p }) => ({
      ...p,
      lastError: p.lastError ?? null,
      /** Failed messages a retry can fetch again (IMAP keeps their UIDs). */
      retryable: failedUids?.length ?? 0,
    })),
    totals: {
      source,
      imported: sum("imported"),
      duplicates: sum("duplicates"),
      failed: sum("failed"),
      skipped: sum("skipped"),
    },
    /** Every message the source listed was imported, was already here, or is accounted for as failed or skipped. */
    accountedFor: r.status === "complete" && source === done,
    ratePerMinute,
    etaAt,
    startedAt: r.startedAt,
    pausedAt: r.status === "paused" ? r.pausedAt : null,
    catchupOf: r.catchupOf,
    since: r.since,
    retryOf: r.retryOf,
    credentialsHeld: r.secretCiphertext !== null,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  }
}

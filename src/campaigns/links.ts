import { inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { linkChecks } from "../db/schema.ts"
import { Database, queryIn } from "../services/Database.ts"

/** The most links one check or render follows; the rest are listed unchecked. */
export const MAX_PROBED_LINKS = 30

export interface LinkStatus {
  readonly url: string
  /** The final HTTP status after redirects; null when nothing answered or it hasn't been checked. */
  readonly status: number | null
  /** "timed out" or "unreachable" when there was no status. */
  readonly error: string | null
  /** Where the redirects ended, when somewhere else. */
  readonly redirectsTo: string | null
  /** When it was followed; null when it never has been. */
  readonly checkedAt: number | null
}

/** One link, followed through redirects: HEAD first, a one-byte GET where HEAD isn't allowed. */
const probe = (url: string) =>
  Effect.promise(async (): Promise<LinkStatus> => {
    const attempt = async (method: "HEAD" | "GET") =>
      fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
        headers: {
          "user-agent": "Mailyard link check (+https://flareyard.dev)",
          ...(method === "GET" ? { range: "bytes=0-0" } : {}),
        },
      })
    const checkedAt = Date.now()
    try {
      let response = await attempt("HEAD")
      if ([403, 405, 501].includes(response.status)) response = await attempt("GET")
      const final = response.url && response.url !== url ? response.url : null
      return { url, status: response.status, error: null, redirectsTo: final, checkedAt }
    } catch (e) {
      return {
        url,
        status: null,
        error: e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable",
        redirectsTo: null,
        checkedAt,
      }
    }
  })

/** Whether a followed link is broken: an error status, or nothing at the address (a timeout is only slow). */
export const isBroken = (l: LinkStatus) =>
  l.checkedAt !== null && ((l.status !== null && l.status >= 400) || l.error === "unreachable")

/**
 * Each link's last known status, in the order given. With `followOlderThan`, links never followed
 * or last followed longer ago than that (ms) are followed now, the first MAX_PROBED_LINKS of them,
 * and the results kept for the next caller.
 */
export const linkStatuses = Effect.fn("campaigns.linkStatuses")(function* (
  urls: ReadonlyArray<string>,
  options: { readonly followOlderThan?: number } = {},
) {
  const stored = yield* queryIn("linkChecks.read", urls, (db, chunk) =>
    db.select().from(linkChecks).where(inArray(linkChecks.url, chunk)).all(),
  )
  const known = new Map<string, LinkStatus>(stored.map((r) => [r.url, r]))
  if (options.followOlderThan !== undefined) {
    const cutoff = Date.now() - options.followOlderThan
    const due = urls
      .slice(0, MAX_PROBED_LINKS)
      .filter((u) => (known.get(u)?.checkedAt ?? Number.NEGATIVE_INFINITY) < cutoff)
    const fresh = yield* Effect.forEach(due, probe, { concurrency: 5 })
    const database = yield* Database
    for (const f of fresh) {
      known.set(f.url, f)
      yield* database.query("linkChecks.write", (db) =>
        db
          .insert(linkChecks)
          .values({ ...f, checkedAt: f.checkedAt ?? Date.now() })
          .onConflictDoUpdate({
            target: linkChecks.url,
            set: {
              status: sql`excluded.status`,
              error: sql`excluded.error`,
              redirectsTo: sql`excluded.redirects_to`,
              checkedAt: sql`excluded.checked_at`,
            },
          })
          .run(),
      )
    }
  }
  return urls.map(
    (url): LinkStatus =>
      known.get(url) ?? { url, status: null, error: null, redirectsTo: null, checkedAt: null },
  )
})

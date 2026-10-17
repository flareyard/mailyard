import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { domains } from "../db/schema.ts"
import { CloudflareEmail } from "../services/CloudflareEmail.ts"
import { Database } from "../services/Database.ts"
import { clearAlert, raiseAlert } from "./alerts.ts"

/**
 * Whether Email Sending's delivery events reach Mailyard for each sending domain. Without an
 * `email.sending` event subscription for a domain, its mail stays `sent` forever: no delivered,
 * bounce or complaint ever arrives, so suppression, the reports and the governor's auto-pause are
 * all blind to it. Found in production on 2026-10-17 (HAL-3341): in.flareyard.dev had none.
 *
 * Two sources, either enough to warn:
 * - the account's subscriptions, when the read-only token can see them (exact domain match: a
 *   subscription on in.flareyard.dev was what made its events flow; the apex's wasn't measured);
 * - the ledger itself: mail from the domain sent more than six hours ago with no event at all.
 */

/** How long a message may wait for its first delivery event before its silence counts. */
export const SILENT_AFTER_MS = 6 * 3_600_000
const WINDOW_MS = 7 * 86_400_000

export type DomainCoverage = {
  readonly domain: string
  /** From the account's subscriptions; null when they can't be read. */
  readonly subscribed: boolean | null
  /** Messages sent 6 hours to 7 days ago that have had a delivery event, and that haven't. */
  readonly withEvents: number
  readonly silent: number
  readonly status: "ok" | "warn" | "unknown"
  readonly detail: string
}

const judge = (
  domain: string,
  subscribed: boolean | null,
  withEvents: number,
  silent: number,
): DomainCoverage => {
  const base = { domain, subscribed, withEvents, silent }
  if (subscribed === false)
    return {
      ...base,
      status: "warn",
      detail: `${domain} has no delivery-events subscription, so its deliveries, bounces and complaints never reach Mailyard. Subscribe the events queue to ${domain} (README, "Delivery events").`,
    }
  if (silent > 0 && withEvents === 0)
    return {
      ...base,
      status: "warn",
      detail: `${silent} message${silent === 1 ? "" : "s"} from ${domain} sent over 6 hours ago ${silent === 1 ? "has" : "have"} had no delivery event. Check that the events queue is subscribed to ${domain}.`,
    }
  if (subscribed === true)
    return { ...base, status: "ok", detail: `Delivery events for ${domain} are subscribed.` }
  if (withEvents > 0) return { ...base, status: "ok", detail: `Delivery events are arriving for ${domain}.` }
  return {
    ...base,
    status: "unknown",
    detail: `Nothing sent from ${domain} long enough ago to tell, and the subscriptions can't be read without the read-only token.`,
  }
}

/** Coverage for every sending domain, or for one. */
export const eventCoverage = Effect.fn("events.coverage")(function* (only?: string) {
  const database = yield* Database
  const cloudflare = yield* CloudflareEmail
  const sending = yield* database.query("events.domains", (db) =>
    db.select({ name: domains.name }).from(domains).where(eq(domains.sendingEnabled, true)).all(),
  )
  const names = sending.map((d) => d.name.toLowerCase()).filter((d) => !only || d === only.toLowerCase())
  if (names.length === 0) return []
  const now = Date.now()
  // The sender's domain is everything after the last @ of `sender`, the bare From address.
  const rows = yield* database.query("events.ledger", (db) =>
    db.all<{ domain: string; with_events: number; silent: number }>(sql`
      select lower(substr(sender, instr(sender, '@') + 1)) as domain,
        sum(status in ('delivered', 'deferred', 'bounced', 'complained')) as with_events,
        sum(status = 'sent') as silent
      from messages_out
      where created_at between ${now - WINDOW_MS} and ${now - SILENT_AFTER_MS}
      group by domain`),
  )
  const ledger = new Map(rows.map((r) => [r.domain, r]))
  const subscribed = yield* cloudflare.subscribedDomains
  return names.map((name) =>
    judge(
      name,
      Option.match(subscribed, { onNone: () => null, onSome: (set) => set.has(name) }),
      Number(ledger.get(name)?.with_events ?? 0),
      Number(ledger.get(name)?.silent ?? 0),
    ),
  )
})

const alertKey = (domain: string) => `delivery-events:${domain}`

/**
 * The hourly watchdog: opens an alert for each domain whose events aren't reaching Mailyard, and
 * closes it once they are. A domain that can't be judged keeps whatever alert it had.
 */
export const watchEventCoverage = Effect.fn("events.watch")(function* () {
  const coverage = yield* eventCoverage()
  for (const c of coverage) {
    if (c.status === "warn")
      yield* raiseAlert({
        key: alertKey(c.domain),
        kind: "delivery_events_missing",
        severity: "critical",
        title: `No delivery events for ${c.domain}`,
        detail: c.detail,
        subject: { type: "domain", id: c.domain },
      })
    else if (c.status === "ok") yield* clearAlert(alertKey(c.domain), "watchdog")
  }
  return coverage
})

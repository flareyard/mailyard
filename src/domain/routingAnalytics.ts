import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import { domains } from "../db/schema.ts"
import { cloudflareApi } from "../services/cloudflareApi.ts"
import { Database } from "../services/Database.ts"

/**
 * What Email Routing refused before mail reached Mailyard (HAL-3393): DMARC failures, SPF and DKIM
 * failures, read from its GraphQL analytics with an optional Analytics Read token.
 *
 * Measured live on 2026-10-18 against the flareyard.dev zone: `emailRoutingAdaptiveGroups` answers
 * per day with `count` and the dimensions `status` (`dropped` and `deliveryFailed` seen; rejections,
 * which the docs call "Rejected", not yet), `action` (`worker`), `dmarc`, `spf` and `isSpam`.
 * Cloudflare keeps 31 days. No dimension names a
 * blocklist, so `rbl` stays null. Mail the Worker handled shows as `dropped`: it isn't a refusal.
 */

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql"
/** How far back Cloudflare keeps Email Routing analytics. */
export const RETENTION_DAYS = 31
const CACHE_MS = 5 * 60_000

export interface UpstreamRejections {
  readonly connected: boolean
  /** Why the numbers are missing, when they are. */
  readonly reason: string | null
  readonly zones: number
  /** The first day counted: Cloudflare keeps 31 days, so a longer range starts later. */
  readonly from: string | null
  readonly rejected: number | null
  readonly dmarcFail: number | null
  /** Rejected for failing SPF or DKIM without a DMARC verdict of fail. */
  readonly authFail: number | null
}

const QUERY = `query MailyardRoutingRejections($zone: string!, $from: Date!, $to: Date!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      emailRoutingAdaptiveGroups(filter: { date_geq: $from, date_leq: $to }, limit: 5000) {
        count
        dimensions { status dmarc spf }
      }
    }
  }
}`

type Groups = ReadonlyArray<{ count: number; dimensions: { status?: string; dmarc?: string; spf?: string } }>

/**
 * Whether a routing status is a refusal. The docs call it "Rejected"; the zone measured on 2026-10-18
 * had none in 31 days (only `dropped` and `deliveryFailed`), so the exact identifier is unmeasured and
 * any status naming a rejection counts.
 */
export const isRejection = (status: string | undefined) => /reject/i.test(status ?? "")

const cache = new Map<string, { at: number; value: UpstreamRejections }>()

const notConnected = (reason: string): UpstreamRejections => ({
  connected: false,
  reason,
  zones: 0,
  from: null,
  rejected: null,
  dmarcFail: null,
  authFail: null,
})

const post = (token: string, zone: string, from: string, to: string) =>
  Effect.promise(async (): Promise<{ ok: true; groups: Groups } | { ok: false; message: string }> => {
    try {
      const response = await fetch(GRAPHQL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { zone, from, to } }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = (await response.json().catch(() => null)) as {
        data?: { viewer?: { zones?: Array<{ emailRoutingAdaptiveGroups?: Groups }> } }
        errors?: Array<{ message: string }> | null
      } | null
      if (!response.ok || !body) return { ok: false, message: `Cloudflare answered ${response.status}.` }
      if (body.errors && body.errors.length > 0)
        return { ok: false, message: body.errors.map((e) => e.message).join("; ") }
      return { ok: true, groups: body.data?.viewer?.zones?.[0]?.emailRoutingAdaptiveGroups ?? [] }
    } catch {
      return { ok: false, message: "Cloudflare didn't answer." }
    }
  })

/** A domain's zone id: the one stored with the domain, else looked up by name with the token. */
/** A zone id by name, through Flareyard's relay when installed there (HAL-3558), else directly. */
const zoneOf = (lookup: { readonly base: string; readonly key: string }, name: string) =>
  Effect.promise(async () => {
    const labels = name.toLowerCase().split(".")
    for (let i = 0; labels.length - i >= 2; i++) {
      try {
        const response = await fetch(
          `${lookup.base}/zones?name=${encodeURIComponent(labels.slice(i).join("."))}`,
          {
            headers: { authorization: `Bearer ${lookup.key}` },
            signal: AbortSignal.timeout(10_000),
          },
        )
        const body = (await response.json().catch(() => null)) as { result?: Array<{ id: string }> } | null
        const id = body?.result?.[0]?.id
        if (id) return id
      } catch {
        return null
      }
    }
    return null
  })

/**
 * Email Routing's own rejections across the zones the workspace receives on, for the days given
 * (`YYYY-MM-DD`, oldest first). Days older than Cloudflare keeps are skipped and `from` says so.
 */
export const upstreamRejections = Effect.fn("overview.upstreamRejections")(function* (
  days: ReadonlyArray<string>,
  now = Date.now(),
) {
  const env = yield* Bindings
  // GraphQL goes straight to Cloudflare: Flareyard's relay doesn't pass /graphql (contract v1.3). The
  // zone lookup uses the relay when there is one.
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN
  const relay = cloudflareApi(env, token)
  const lookup = { base: relay.base, key: relay.token ?? token ?? "" }
  if (!token)
    return notConnected(
      "Set CLOUDFLARE_ANALYTICS_TOKEN (Analytics Read on the receiving zones) to count what Email Routing rejects before Mailyard sees it.",
    )
  const oldest = new Date(now - (RETENTION_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
  const kept = days.filter((d) => d >= oldest)
  const from = kept[0]
  const to = kept.at(-1)
  if (!from || !to) return notConnected("Cloudflare keeps Email Routing analytics for 31 days.")
  const key = `${from}:${to}`
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.value

  const database = yield* Database
  const receiving = yield* database.query("overview.receivingDomains", (db) =>
    db
      .select({ name: domains.name, zoneId: domains.zoneId })
      .from(domains)
      .where(eq(domains.routingEnabled, true))
      .limit(200)
      .all(),
  )
  const zones = new Set<string>()
  for (const d of receiving) {
    const zone = d.zoneId ?? (yield* zoneOf(lookup, d.name))
    if (zone) zones.add(zone)
  }
  if (receiving.length > 0 && zones.size === 0)
    return notConnected("The analytics token can't see the zones of the receiving domains.")

  let rejected = 0
  let dmarcFail = 0
  for (const zone of zones) {
    const answer = yield* post(token, zone, from, to)
    if (!answer.ok) return notConnected(`Email Routing analytics: ${answer.message}`)
    for (const g of answer.groups) {
      if (!isRejection(g.dimensions.status)) continue
      rejected += g.count
      if ((g.dimensions.dmarc ?? "").toLowerCase() === "fail") dmarcFail += g.count
    }
  }
  const value: UpstreamRejections = {
    connected: true,
    reason: null,
    zones: zones.size,
    from,
    rejected,
    dmarcFail,
    authFail: rejected - dmarcFail,
  }
  cache.set(key, { at: now, value })
  return value
})

/** For tests. */
export const clearUpstreamCache = () => cache.clear()

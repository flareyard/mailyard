import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { Bindings } from "../Bindings.ts"
import { domains } from "../db/schema.ts"
import {
  cloudflareApi,
  DIRECT_API,
  type RelayRefusal,
  relayMessage,
  relayRefusalOf,
} from "../services/cloudflareApi.ts"
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
  /** Set when Flareyard's relay refused the zone lookup or the query (HAL-3558). */
  readonly relay?: RelayRefusal
}

/**
 * Declared word for word in cloudflare-app.json's `cloudflareApi.graphql` (MailyardRoutingRejections):
 * Flareyard's relay sends only declared queries, so a change here is a change there too.
 */
export const QUERY = `query MailyardRoutingRejections($zone: string!, $from: Date!, $to: Date!) {
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

const notConnected = (reason: string, relay?: RelayRefusal | null): UpstreamRejections => ({
  connected: false,
  reason,
  zones: 0,
  from: null,
  rejected: null,
  dmarcFail: null,
  authFail: null,
  ...(relay ? { relay } : {}),
})

type Target = { readonly base: string; readonly key: string }

const post = (target: Target, zone: string, from: string, to: string) =>
  Effect.promise(
    async (): Promise<
      { ok: true; groups: Groups } | { ok: false; message: string; relay: RelayRefusal | null }
    > => {
      try {
        const response = await fetch(`${target.base}/graphql`, {
          method: "POST",
          headers: { authorization: `Bearer ${target.key}`, "content-type": "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { zone, from, to } }),
          signal: AbortSignal.timeout(10_000),
        })
        const body = (await response.json().catch(() => null)) as {
          data?: { viewer?: { zones?: Array<{ emailRoutingAdaptiveGroups?: Groups }> } }
          errors?: Array<{ message: string }> | null
        } | null
        const relay = relayRefusalOf(body, target.base)
        if (relay) return { ok: false, message: relayMessage(relay), relay }
        if (!response.ok || !body)
          return { ok: false, message: `Cloudflare answered ${response.status}.`, relay: null }
        if (body.errors && body.errors.length > 0)
          return { ok: false, message: body.errors.map((e) => e.message).join("; "), relay: null }
        return { ok: true, groups: body.data?.viewer?.zones?.[0]?.emailRoutingAdaptiveGroups ?? [] }
      } catch {
        return { ok: false, message: "Cloudflare didn't answer.", relay: null }
      }
    },
  )

/** A zone id by name, through Flareyard's relay when installed there (HAL-3558), else directly. */
const zoneOf = (lookup: Target, name: string) =>
  Effect.promise(async (): Promise<{ id: string | null; relay: RelayRefusal | null }> => {
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
        const relay = relayRefusalOf(body, lookup.base)
        if (relay) return { id: null, relay }
        const id = body?.result?.[0]?.id
        if (id) return { id, relay: null }
      } catch {
        return { id: null, relay: null }
      }
    }
    return { id: null, relay: null }
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
  // Installed through Flareyard, the zone lookup and the declared query both go through its relay
  // (HAL-3570); self-hosted, straight to Cloudflare with the analytics token.
  const api = cloudflareApi(env, env.CLOUDFLARE_ANALYTICS_TOKEN)
  if (!api.token)
    return notConnected(
      "Install Mailyard through Flareyard (granting Account Analytics: Read), or set CLOUDFLARE_ANALYTICS_TOKEN (Analytics Read on the receiving zones), to count what Email Routing rejects before Mailyard sees it.",
    )
  const target: Target = { base: api.base, key: api.token }
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
  let refused: RelayRefusal | null = null
  for (const d of receiving) {
    if (d.zoneId) {
      zones.add(d.zoneId)
      continue
    }
    const found = yield* zoneOf(target, d.name)
    if (found.id) zones.add(found.id)
    refused ??= found.relay
  }
  if (receiving.length > 0 && zones.size === 0)
    return refused
      ? notConnected(relayMessage(refused), refused)
      : notConnected(
          api.base === DIRECT_API
            ? "The analytics token can't see the zones of the receiving domains."
            : "Mailyard can't see the zones of the receiving domains.",
        )

  let rejected = 0
  let dmarcFail = 0
  for (const zone of zones) {
    const answer = yield* post(target, zone, from, to)
    if (!answer.ok)
      return answer.relay
        ? notConnected(answer.message, answer.relay)
        : notConnected(`Email Routing analytics: ${answer.message}`)
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

import type { Env } from "../Bindings.ts"

/**
 * Where Mailyard's Cloudflare API calls go, and with what key (HAL-3558, apps contract v1.3).
 *
 * Installed through Flareyard, the platform sets `FLAREYARD_CF_API` to a relay that takes the same
 * paths, bodies and answers as `api.cloudflare.com/client/v4`, and `FLAREYARD_CF_TOKEN` to this
 * install's key for it. The relay makes each call with the user's own OAuth grant, so nobody pastes
 * an API token. Every call the code makes is declared in the manifest's `cloudflareApi.routes`.
 *
 * Self-hosted, both are unset and each service falls back to calling Cloudflare directly with the
 * token given to it through `wrangler secret put`.
 */
export const DIRECT_API = "https://api.cloudflare.com/client/v4"

export interface CloudflareApiTarget {
  /** The base URL: the relay's, or Cloudflare's own. */
  readonly base: string
  /** The bearer: the relay key, or the given fallback token. */
  readonly token: string | undefined
  /** True when calls go through Flareyard's relay. */
  readonly relayed: boolean
}

/** The base and bearer for one service, given the token it would use off the platform. */
export const cloudflareApi = (env: Env, fallbackToken: string | undefined): CloudflareApiTarget => {
  const relay = env.FLAREYARD_CF_API?.trim().replace(/\/+$/, "")
  if (relay && env.FLAREYARD_CF_TOKEN) return { base: relay, token: env.FLAREYARD_CF_TOKEN, relayed: true }
  return { base: DIRECT_API, token: fallbackToken || undefined, relayed: false }
}

/**
 * The relay's own refusals, in Cloudflare's error envelope (contract v1.3), worded for a person. A
 * code that isn't the relay's answers null, so the caller keeps its usual message.
 */
export const relayRefusal = (body: unknown): string | null => {
  const code = (body as { errors?: Array<{ code?: number }> } | null)?.errors?.[0]?.code
  switch (code) {
    case 10401:
      return "Flareyard doesn't recognise this install's key. Reinstall Mailyard from Flareyard."
    case 10402:
      return "Flareyard is disconnected from Cloudflare. Reconnect Cloudflare on app.flareyard.dev."
    case 10403:
      return "This Cloudflare call isn't declared in Mailyard's manifest."
    case 10404:
      return "This needs a Cloudflare permission you haven't granted Mailyard yet. Grant it on its page in Flareyard."
    case 10405:
      return "That zone or account isn't the one Mailyard is installed in."
    case 10413:
      return "The request was too large for Flareyard's relay."
    case 10429:
      return "Too many Cloudflare calls this minute; try again shortly."
    case 10502:
      return "Cloudflare didn't answer the relay."
    default:
      return null
  }
}

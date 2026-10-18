import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
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

/** The relay's refusals by name (contract v1.3), so a screen can act on one without parsing words. */
export const RELAY_REASONS = {
  10401: "install_key_invalid",
  10402: "relay_disconnected",
  10403: "route_undeclared",
  10404: "scope_not_granted",
  10405: "wrong_account",
  10413: "request_too_large",
  10429: "rate_limited",
  10502: "cloudflare_unreachable",
} as const

export type RelayReason = (typeof RELAY_REASONS)[keyof typeof RELAY_REASONS]

/**
 * A refusal from Flareyard's relay, beside the message wherever one surfaces (HAL-3558). `scope` is
 * the Cloudflare OAuth scope to grant, on `scope_not_granted`, when the relay names it.
 */
export interface RelayRefusal {
  readonly reason: RelayReason
  readonly code: number
  readonly scope?: string
}

/** A read, and the relay's refusal when that's why it came back empty. */
export interface Lookup<A> {
  readonly value: Option.Option<A>
  readonly relay: RelayRefusal | null
}

/** RelayRefusal as a schema, for every response and error that carries one. */
export const RelayRefusalSchema = Schema.Struct({
  reason: Schema.Literals(Object.values(RELAY_REASONS)).annotate({
    description:
      "Why Flareyard's relay refused the Cloudflare call: install_key_invalid (10401, reinstall), relay_disconnected (10402, reconnect Cloudflare in Flareyard), route_undeclared (10403), scope_not_granted (10404, grant `scope` on the app's page in Flareyard), wrong_account (10405), request_too_large (10413), rate_limited (10429), cloudflare_unreachable (10502).",
  }),
  code: Schema.Number.annotate({ description: "The relay's error code, 10401 to 10502." }),
  scope: Schema.optionalKey(
    Schema.String.annotate({ description: "On scope_not_granted: the Cloudflare OAuth scope to grant." }),
  ),
}).annotate({
  identifier: "RelayRefusal",
  description:
    "Present when Flareyard's Cloudflare relay, not Cloudflare, refused the call (installs through Flareyard only).",
})

const firstError = (body: unknown) =>
  (body as { errors?: Array<{ code?: unknown; message?: unknown }> } | null)?.errors?.[0]

/**
 * The relay's refusal in a Cloudflare error envelope, or null when the code isn't the relay's. Read
 * only from answers that came through the relay (`base` isn't Cloudflare's own), so a code of
 * Cloudflare's that happens to share a number is never taken for one.
 */
export const relayRefusalOf = (body: unknown, base: string): RelayRefusal | null => {
  if (base === DIRECT_API) return null
  const error = firstError(body)
  const code = typeof error?.code === "number" ? error.code : null
  if (code === null || !(code in RELAY_REASONS)) return null
  const reason = RELAY_REASONS[code as keyof typeof RELAY_REASONS]
  // The relay words it "This needs <name> (<scope>). Grant it …"; a scope is dotted lowercase.
  const scope =
    reason === "scope_not_granted" && typeof error?.message === "string"
      ? /\(([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+)\)/.exec(error.message)?.[1]
      : undefined
  return { reason, code, ...(scope ? { scope } : {}) }
}

/** `relay` beside `message`, only when there is one: the shape every refusal carries. */
export const withRelay = (relay: RelayRefusal | null | undefined) => (relay ? { relay } : {})

/**
 * The relay's own refusals worded for a person. A code that isn't the relay's answers null, so the
 * caller keeps its usual message.
 */
export const relayRefusal = (body: unknown, base: string): string | null => {
  const refusal = relayRefusalOf(body, base)
  return refusal ? relayMessage(refusal) : null
}

export const relayMessage = (refusal: RelayRefusal): string => {
  switch (refusal.reason) {
    case "install_key_invalid":
      return "Flareyard doesn't recognise this install's key. Reinstall Mailyard from Flareyard."
    case "relay_disconnected":
      return "Flareyard is disconnected from Cloudflare. Reconnect Cloudflare on app.flareyard.dev."
    case "route_undeclared":
      return "This Cloudflare call isn't declared in Mailyard's manifest."
    case "scope_not_granted":
      return refusal.scope
        ? `This needs the Cloudflare permission ${refusal.scope}, which you haven't granted Mailyard yet. Grant it on its page in Flareyard.`
        : "This needs a Cloudflare permission you haven't granted Mailyard yet. Grant it on its page in Flareyard."
    case "wrong_account":
      return "That zone or account isn't the one Mailyard is installed in."
    case "request_too_large":
      return "The request was too large for Flareyard's relay."
    case "rate_limited":
      return "Too many Cloudflare calls this minute; try again shortly."
    case "cloudflare_unreachable":
      return "Cloudflare didn't answer the relay."
  }
}

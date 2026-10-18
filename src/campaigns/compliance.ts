import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { settings } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { Dns } from "../services/Dns.ts"

/**
 * What bulk mail must carry and where tests go (docs/email-ui.html: Settings, Tracking and
 * compliance). A postal address is a CAN-SPAM requirement for commercial mail; the link allowlist
 * names outside domains a campaign may link to without a warning; seeds are the addresses test
 * sends go to.
 */
/**
 * A live check of the tracking hostname (HAL-3376): its CNAME, whether HTTPS completes (a
 * certificate covers it), and whether it reaches this Worker (`/healthz` answers as Mailyard).
 */
export const TrackingOriginCheck = Schema.Struct({
  host: Schema.String,
  cname: Schema.NullOr(Schema.String),
  certificate: Schema.Literals(["valid", "failed"]),
  routesHere: Schema.Boolean,
  checkedAt: Schema.Number,
})
export type TrackingOriginCheck = typeof TrackingOriginCheck.Type

export const ComplianceSettings = Schema.Struct({
  postalAddress: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
  linkAllowlist: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+\.[a-z]{2,}$/i))),
  seedAddresses: Schema.Array(Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))).check(
    Schema.isMaxLength(5),
  ),
  /**
   * Where tracking links point: a hostname on your own sending domain (a custom domain on this
   * Worker), so links don't lead off to workers.dev. The request's own origin when unset.
   */
  trackingOrigin: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9.-]+$/i))),
  ),
  /** The sender's privacy policy, linked in the footer of the preference and signup pages (HAL-3377). */
  privacyUrl: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/)))),
  /**
   * What new campaigns and topics start with when the request doesn't say (HAL-3376). Null (or
   * left out) falls back to the deploy's settings (`MAILYARD_TRACK_OPENS`, `MAILYARD_TRACK_CLICKS`)
   * and to double opt-in on.
   */
  trackOpensDefault: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  trackClicksDefault: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  doubleOptInDefault: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  /** How the preference page looks: in the brand or Flareyard's look, with or without topic descriptions. */
  preferencePage: Schema.optionalKey(
    Schema.Struct({ useBrand: Schema.Boolean, showTopicDescriptions: Schema.Boolean }),
  ),
  /** What the last live check of `trackingOrigin` found; written by Mailyard, never by a PUT. */
  trackingOriginCheck: Schema.optionalKey(Schema.NullOr(TrackingOriginCheck)),
})
export type ComplianceSettings = typeof ComplianceSettings.Type

export const DEFAULT_COMPLIANCE: ComplianceSettings = {
  postalAddress: null,
  linkAllowlist: [],
  seedAddresses: [],
  trackingOrigin: null,
  privacyUrl: null,
  trackOpensDefault: null,
  trackClicksDefault: null,
  doubleOptInDefault: null,
  preferencePage: { useBrand: true, showTopicDescriptions: true },
  trackingOriginCheck: null,
}

/** The origin tracking links use: the configured one, else the API's own. */
export const trackingOrigin = (settings: ComplianceSettings, requestOrigin: string) =>
  settings.trackingOrigin ?? requestOrigin

export const getCompliance = Effect.fn("compliance.get")(function* () {
  const database = yield* Database
  const row = yield* database.query("compliance.get", (db) =>
    db.select().from(settings).where(eq(settings.key, "compliance")).get(),
  )
  if (!row) return DEFAULT_COMPLIANCE
  return Schema.decodeUnknownOption(ComplianceSettings)(row.value).pipe((o) =>
    o._tag === "Some" ? o.value : DEFAULT_COMPLIANCE,
  )
})

/** Follows a tracking origin live: its CNAME, whether HTTPS completes, and whether it's this Worker. */
export const checkTrackingOrigin = Effect.fn("compliance.checkTracking")(function* (origin: string) {
  const host = new URL(origin).hostname
  const dns = yield* Dns
  const cname = yield* dns.resolve(host, "CNAME").pipe(
    Effect.map((r) => r.answers.find((a) => a.type === "CNAME")?.data.replace(/\.$/, "") ?? null),
    Effect.orElseSucceed(() => null),
  )
  const probe = yield* Effect.promise(async () => {
    try {
      const res = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000), redirect: "manual" })
      const body = (await res.json().catch(() => null)) as { app?: unknown } | null
      return { certificate: "valid" as const, routesHere: body?.app === "mailyard" }
    } catch {
      return { certificate: "failed" as const, routesHere: false }
    }
  })
  return { host, cname, ...probe, checkedAt: Date.now() } satisfies TrackingOriginCheck
})

const save = (value: ComplianceSettings) =>
  Database.use((d) =>
    d.query("compliance.put", (db) =>
      db
        .insert(settings)
        .values({ key: "compliance", value, updatedAt: Date.now() })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
        .run(),
    ),
  )

export const putCompliance = Effect.fn("compliance.put")(function* (
  value: Omit<ComplianceSettings, "trackingOriginCheck">,
) {
  const before = yield* getCompliance()
  const trackingOrigin = value.trackingOrigin?.replace(/\/$/, "").toLowerCase() ?? null
  // A new tracking hostname is checked at once; an unchanged one keeps its last check.
  const trackingOriginCheck = !trackingOrigin
    ? null
    : trackingOrigin === before.trackingOrigin && before.trackingOriginCheck
      ? before.trackingOriginCheck
      : yield* checkTrackingOrigin(trackingOrigin)
  const normalized: ComplianceSettings = {
    postalAddress: value.postalAddress?.trim() || null,
    linkAllowlist: [...new Set(value.linkAllowlist.map((d) => d.toLowerCase()))],
    seedAddresses: [...new Set(value.seedAddresses.map((a) => a.trim().toLowerCase()))],
    trackingOrigin,
    privacyUrl: value.privacyUrl?.trim() || null,
    trackOpensDefault: value.trackOpensDefault ?? null,
    trackClicksDefault: value.trackClicksDefault ?? null,
    doubleOptInDefault: value.doubleOptInDefault ?? null,
    preferencePage: value.preferencePage ?? DEFAULT_PREFERENCE_PAGE,
    trackingOriginCheck,
  }
  yield* save(normalized)
  return normalized
})

/** Checks the tracking hostname again and keeps the answer. */
export const recheckTrackingOrigin = Effect.fn("compliance.recheckTracking")(function* () {
  const current = yield* getCompliance()
  if (!current.trackingOrigin) return current
  const next = { ...current, trackingOriginCheck: yield* checkTrackingOrigin(current.trackingOrigin) }
  yield* save(next)
  return next
})

export const DEFAULT_PREFERENCE_PAGE = { useBrand: true, showTopicDescriptions: true } as const

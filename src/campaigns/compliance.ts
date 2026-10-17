import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { settings } from "../db/schema.ts"
import { Database } from "../services/Database.ts"

/**
 * What bulk mail must carry and where tests go (docs/email-ui.html: Settings, Tracking and
 * compliance). A postal address is a CAN-SPAM requirement for commercial mail; the link allowlist
 * names outside domains a campaign may link to without a warning; seeds are the addresses test
 * sends go to.
 */
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
})
export type ComplianceSettings = typeof ComplianceSettings.Type

export const DEFAULT_COMPLIANCE: ComplianceSettings = {
  postalAddress: null,
  linkAllowlist: [],
  seedAddresses: [],
  trackingOrigin: null,
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

export const putCompliance = Effect.fn("compliance.put")(function* (value: ComplianceSettings) {
  const database = yield* Database
  const normalized: ComplianceSettings = {
    postalAddress: value.postalAddress?.trim() || null,
    linkAllowlist: [...new Set(value.linkAllowlist.map((d) => d.toLowerCase()))],
    seedAddresses: [...new Set(value.seedAddresses.map((a) => a.trim().toLowerCase()))],
    trackingOrigin: value.trackingOrigin?.replace(/\/$/, "").toLowerCase() ?? null,
  }
  yield* database.query("compliance.put", (db) =>
    db
      .insert(settings)
      .values({ key: "compliance", value: normalized, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value: normalized, updatedAt: Date.now() } })
      .run(),
  )
  return normalized
})

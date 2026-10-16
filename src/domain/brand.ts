import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { settings } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { DEFAULT_THEME, type Theme } from "../templates/kit.ts"
import type { Brand } from "../templates/render.ts"

const Hex = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))

/** The sender's brand, as stored in `settings.brand`. Anything left out falls back to Mailyard's default. */
export const BrandSettings = Schema.Struct({
  name: Schema.NonEmptyString,
  siteUrl: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  tagline: Schema.String,
  logoUrl: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^https?:\/\//))),
  fontsHref: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^https:\/\//))),
  colors: Schema.optionalKey(
    Schema.Struct({
      bg: Schema.optionalKey(Hex),
      surface: Schema.optionalKey(Hex),
      fg: Schema.optionalKey(Hex),
      muted: Schema.optionalKey(Hex),
      border: Schema.optionalKey(Hex),
      lime: Schema.optionalKey(Hex),
      indigo: Schema.optionalKey(Hex),
      body: Schema.optionalKey(Hex),
      red: Schema.optionalKey(Hex),
      white: Schema.optionalKey(Hex),
    }),
  ),
  fonts: Schema.optionalKey(
    Schema.Struct({
      display: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(Schema.String),
      mono: Schema.optionalKey(Schema.String),
    }),
  ),
})
export type BrandSettings = typeof BrandSettings.Type

export const DEFAULT_BRAND: BrandSettings = {
  name: "Mailyard",
  siteUrl: "https://example.com",
  tagline: "Sent with Mailyard.",
}

export const toBrand = (s: BrandSettings): Brand => {
  const theme: Theme = {
    ...DEFAULT_THEME,
    name: s.name,
    logoUrl: s.logoUrl,
    fontsHref: s.fontsHref ?? DEFAULT_THEME.fontsHref,
    colors: { ...DEFAULT_THEME.colors, ...s.colors },
    fonts: { ...DEFAULT_THEME.fonts, ...s.fonts },
  }
  return { theme, siteUrl: s.siteUrl, tagline: s.tagline }
}

export const getBrandSettings = Effect.fn("brand.get")(function* () {
  const database = yield* Database
  const row = yield* database.query("settings.brand", (db) =>
    db.select().from(settings).where(eq(settings.key, "brand")).get(),
  )
  if (!row) return DEFAULT_BRAND
  return Schema.decodeUnknownOption(BrandSettings)(row.value).pipe((o) =>
    o._tag === "Some" ? o.value : DEFAULT_BRAND,
  )
})

export const getBrand = Effect.fn("brand.resolve")(function* () {
  return toBrand(yield* getBrandSettings())
})

export const putBrandSettings = Effect.fn("brand.put")(function* (value: BrandSettings) {
  const database = yield* Database
  const now = Date.now()
  yield* database.query("settings.brand.put", (db) =>
    db
      .insert(settings)
      .values({ key: "brand", value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run(),
  )
  return value
})

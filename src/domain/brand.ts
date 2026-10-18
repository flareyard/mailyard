import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { settings, uploads } from "../db/schema.ts"
import { BlobStore } from "../kit/index.ts"
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

/** The workspace's own brand, or null when it hasn't set one (public pages then use Flareyard's look). */
export const customBrandSettings = Effect.fn("brand.custom")(function* () {
  const database = yield* Database
  const row = yield* database.query("settings.brand", (db) =>
    db.select().from(settings).where(eq(settings.key, "brand")).get(),
  )
  if (!row) return null
  return Schema.decodeUnknownOption(BrandSettings)(row.value).pipe((o) =>
    o._tag === "Some" ? o.value : null,
  )
})

export const getBrandSettings = Effect.fn("brand.get")(function* () {
  return (yield* customBrandSettings()) ?? DEFAULT_BRAND
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

/** WCAG relative luminance of `#rrggbb`. */
const luminance = (hex: string) => {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** The contrast ratio between two `#rrggbb` colours, 1 to 21. */
export const contrastRatio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Whether a brand's text stays readable (HAL-3376): WCAG AA's 4.5:1 for white button text on the
 * accent, and for body, heading and muted text on the page and card backgrounds. Checked on the
 * colours as they'll be used, the brand's merged over the defaults. Null when everything passes.
 */
export const brandContrastProblem = (s: BrandSettings): { field: string; message: string } | null => {
  const c = toBrand(s).theme.colors
  const pairs: ReadonlyArray<readonly [field: string, fg: string, bg: string, what: string]> = [
    ["colors.indigo", c.white, c.indigo, "White text on the accent"],
    ["colors.fg", c.fg, c.bg, "Heading text on the page background"],
    ["colors.body", c.body, c.bg, "Body text on the page background"],
    ["colors.muted", c.muted, c.bg, "Muted text on the page background"],
    ["colors.fg", c.fg, c.white, "Heading text on the card"],
    ["colors.muted", c.muted, c.white, "Muted text on the card"],
  ]
  for (const [field, fg, bg, what] of pairs) {
    const ratio = contrastRatio(fg, bg)
    if (ratio < 4.5)
      return {
        field,
        message: `${what} is ${ratio.toFixed(1)}:1; AA needs 4.5:1. Darken or lighten one of them.`,
      }
  }
  return null
}

export class LogoInvalid extends Schema.TaggedError<LogoInvalid>()("LogoInvalid", {
  message: Schema.String,
}) {}

export const MAX_LOGO_BYTES = 1024 * 1024
/** Where a stored logo is served from, by its content hash: `GET /brand/logo/<sha256>.<ext>`. */
export const BRAND_LOGO_PATH = /^\/brand\/logo\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))$/
export const logoKey = (file: string) => `brand/logo/${file}`

/** The image a file's first bytes say it is; SVG isn't accepted, since it can carry script. */
const sniff = (b: Uint8Array) =>
  b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    ? { ext: "png", type: "image/png" }
    : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
      ? { ext: "jpg", type: "image/jpeg" }
      : b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46
        ? { ext: "gif", type: "image/gif" }
        : b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
          ? { ext: "webp", type: "image/webp" }
          : null

/**
 * Keeps an uploaded logo (HAL-3376): checks it's a PNG, JPEG, WebP or GIF by its bytes and at most
 * 1 MiB, copies it under a key named by its hash, and answers the URL it's served at on this Worker.
 */
export const storeLogo = Effect.fn("brand.storeLogo")(function* (uploadId: string, origin: string) {
  const database = yield* Database
  const upload = yield* database.query("brand.logoUpload", (db) =>
    db.select().from(uploads).where(eq(uploads.id, uploadId)).get(),
  )
  if (!upload) return yield* new LogoInvalid({ message: `Upload ${uploadId} not found.` })
  if (upload.size > MAX_LOGO_BYTES) return yield* new LogoInvalid({ message: "A logo is at most 1 MiB." })
  const store = yield* BlobStore
  const blob = yield* store.get(upload.key)
  if (Option.isNone(blob)) return yield* new LogoInvalid({ message: "The upload is no longer stored." })
  const bytes = blob.value.body
  const kind = sniff(bytes)
  if (!kind) return yield* new LogoInvalid({ message: "A logo is a PNG, JPEG, WebP or GIF image." })
  const file = `${upload.sha256}.${kind.ext}`
  yield* store.put(logoKey(file), bytes, kind.type)
  return `${origin}/brand/logo/${file}`
})

import { Schema } from "effect"

/**
 * `cloudflare-app.json`, version 1: the contract every Flareyard app signs. The platform reads it to
 * build the catalog page, the consent request, the settings form and the health check.
 * Draft: docs/plans/platform-plan.html#manifest.
 */

const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/))
const SemVer = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/))
const SecretName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/))
const Reason = Schema.NonEmptyString.check(Schema.isMaxLength(200))

/**
 * A Cloudflare OAuth scope. The real list comes from `GET /client/v4/oauth/scopes` (HAL-2816), so
 * this only checks the shape `<resource>.<access>` until that list is measured and pinned.
 */
export const Scope = Schema.Struct({
  scope: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/)),
  why: Reason,
  enables: Schema.optionalKey(Schema.String),
})

export const Secret = Schema.Union([
  Schema.Struct({
    name: SecretName,
    generate: Schema.Literals(["random-32", "random-64", "keypair-ed25519"]),
  }),
  Schema.Struct({
    name: SecretName,
    ask: Reason,
    help: Schema.optionalKey(Schema.String),
    optional: Schema.optionalKey(Schema.Boolean),
  }),
])

export const Manifest = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  manifestVersion: Schema.Literal(1),
  id: Slug,
  name: Schema.NonEmptyString.check(Schema.isMaxLength(60)),
  description: Reason,
  version: SemVer,
  stack: Schema.NonEmptyString,
  plan: Schema.Literals(["free", "workers-paid"]),
  scopes: Schema.Struct({
    required: Schema.NonEmptyArray(Scope),
    optional: Schema.Array(Scope),
  }),
  secrets: Schema.Array(Secret),
  domain: Schema.Struct({
    supported: Schema.Boolean,
    suggest: Schema.optionalKey(Slug),
  }),
  health: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9/_-]*$/)),
  cost: Schema.Struct({
    /** Plain words, not a number we invented: "0–1 above the $5 plan" or "unmeasured". */
    typicalMonthlyUsd: Schema.NonEmptyString,
  }),
  upgrade: Schema.Struct({
    migrations: Schema.Literals(["drizzle", "none"]),
    notes: Schema.NonEmptyString,
  }),
})
export type Manifest = typeof Manifest.Type

export const decodeManifest = Schema.decodeUnknownEffect(Manifest)
export const decodeManifestExit = Schema.decodeUnknownExit(Manifest)

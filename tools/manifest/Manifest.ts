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
 * A Cloudflare OAuth scope, shaped `<resource>.<access>` (14 of the measured IDs use `_`, e.g.
 * `d1.metadata_read`). Whether the ID exists is checked against the measured list (HAL-2816,
 * `src/scopes.ts`) in `crossFieldProblems`, so a typo is reported by name rather than as a shape error.
 */
export const Scope = Schema.Struct({
  scope: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/)),
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

/**
 * Contract v1.2 (proposed by Mailyard, adopted 2026-10-17). A setting is a Worker `var` the platform sets
 * at deploy and changes with an update; the install and settings forms render from this list. `when`
 * shows a field only while another setting has that value.
 */
const SettingBase = {
  name: SecretName,
  label: Schema.NonEmptyString.check(Schema.isMaxLength(60)),
  help: Schema.optionalKey(Reason),
  when: Schema.optionalKey(Schema.Struct({ setting: SecretName, equals: Schema.String })),
}
export const Setting = Schema.Union([
  Schema.Struct({
    ...SettingBase,
    type: Schema.Literal("integer"),
    default: Schema.Number,
    min: Schema.Number,
    max: Schema.Number,
  }),
  Schema.Struct({ ...SettingBase, type: Schema.Literal("boolean"), default: Schema.Boolean }),
  Schema.Struct({
    ...SettingBase,
    type: Schema.Literal("enum"),
    default: Schema.String,
    options: Schema.NonEmptyArray(Schema.Struct({ value: Schema.String, label: Schema.NonEmptyString })),
  }),
  Schema.Struct({
    ...SettingBase,
    type: Schema.Literals(["string", "url"]),
    default: Schema.optionalKey(Schema.String),
    optional: Schema.optionalKey(Schema.Boolean),
  }),
])
export type Setting = typeof Setting.Type

/** A Cloudflare price the app's bill is made of, as the pricing page states it, with the page and date. */
export const CostUnit = Schema.Struct({
  product: Schema.NonEmptyString,
  unit: Schema.NonEmptyString,
  included: Schema.NonEmptyString,
  price: Schema.NonEmptyString,
  source: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  measuredAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
})
export type CostUnit = typeof CostUnit.Type

/**
 * Contract v1.3 (HAL-3507): the Cloudflare API calls the app makes while it runs, through the platform.
 * Flareyard sets `url` (a var) to a relay that takes the same paths, bodies and answers as
 * `https://api.cloudflare.com/client/v4`, and `token` (a secret) to a key for it. The relay makes each call
 * with the user's own OAuth grant, so nobody pastes an API token. It forwards only the routes listed here,
 * only while their `scope` is granted, and only inside the account the app is installed in.
 *
 * Path segments are literal or a placeholder: `{account}` must be the install's account, `{zone}` a zone
 * in that account, `{id}` any one segment. The query string passes through, except that `GET /zones` is
 * always narrowed to the install's account.
 */
export const ApiMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"])
export const ApiRoute = Schema.Struct({
  method: ApiMethod,
  path: Schema.String.check(
    Schema.isPattern(/^(?:\/(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+|\{account\}|\{zone\}|\{id\}))+$/),
  ),
  scope: Schema.String,
  why: Reason,
})
export type ApiRoute = typeof ApiRoute.Type

/**
 * A GraphQL analytics query the relay may send to `POST /graphql`, word for word (HAL-3570). Only the
 * variables change between calls, and `zoneVariable` must name a zone in the install's account. The
 * query may read `viewer.zones` filtered by that variable alone; `crossFieldProblems` checks the text.
 */
export const GraphqlQuery = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)),
  query: Schema.NonEmptyString.check(Schema.isMaxLength(8000)),
  zoneVariable: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)),
  scope: Schema.String,
  why: Reason,
})
export type GraphqlQuery = typeof GraphqlQuery.Type

export const CloudflareApi = Schema.Struct({
  /** A var the platform sets to the install's Cloudflare account id. */
  accountId: Schema.optionalKey(SecretName),
  /** A var the platform sets to the relay's base URL, used in place of api.cloudflare.com/client/v4. */
  url: SecretName,
  /** A secret the platform sets to this install's key for the relay. */
  token: SecretName,
  routes: Schema.NonEmptyArray(ApiRoute),
  /** Analytics queries for `POST /graphql`, each bound to one of the install's zones. */
  graphql: Schema.optionalKey(Schema.Array(GraphqlQuery)),
})
export type CloudflareApi = typeof CloudflareApi.Type

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
  /** v1.2: an authenticated route with more than health, read by the dashboard with a generated secret. */
  status: Schema.optionalKey(
    Schema.Struct({
      path: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9/_-]*$/)),
      auth: Schema.Struct({ bearer: SecretName }),
    }),
  ),
  /** v1.2: settings the user picks at install and can change later. */
  settings: Schema.optionalKey(Schema.Array(Setting)),
  /** v1.3: Cloudflare API calls made at runtime with the user's grant, through the platform. */
  cloudflareApi: Schema.optionalKey(CloudflareApi),
  cost: Schema.Struct({
    /** Plain words, not a number we invented: "0–1 above the $5 plan" or "unmeasured". */
    typicalMonthlyUsd: Schema.NonEmptyString,
    /** v1.2: the unit prices behind the estimate, each with its pricing page and date. */
    units: Schema.optionalKey(Schema.Array(CostUnit)),
  }),
  upgrade: Schema.Struct({
    migrations: Schema.Literals(["drizzle", "none"]),
    notes: Schema.NonEmptyString,
  }),
})
export type Manifest = typeof Manifest.Type

export const decodeManifest = Schema.decodeUnknownEffect(Manifest)
export const decodeManifestExit = Schema.decodeUnknownExit(Manifest)

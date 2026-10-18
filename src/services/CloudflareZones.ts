import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import type { WriteOutcome } from "./CloudflareEmail.ts"

/**
 * The zones a workspace's domains live in, read and repaired with the optional CLOUDFLARE_DNS_TOKEN
 * (HAL-3365). Field names measured against the live API on 2026-10-18: `GET /zones` (status,
 * name_servers, original_name_servers, original_registrar), `GET /zones/{id}/dnssec` (status),
 * `GET /zones/{id}/email/sending/subdomains` (id, name, return_path_domain), and the complaints count,
 * whose window is at most seven days.
 */
export const Zone = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  name_servers: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  original_name_servers: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  original_registrar: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type Zone = typeof Zone.Type

export const SendingSubdomain = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  return_path_domain: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type SendingSubdomain = typeof SendingSubdomain.Type

/**
 * An Email Routing rule (HAL-3378), as `GET /zones/{id}/email/routing/rules` returns it: measured
 * against Cloudflare's published API schema 2026-10-18. `matchers` are `literal` on `to` (one
 * address) or `all`; `actions` hold one `forward`, `worker` or `drop` with at most one value.
 */
export const RoutingRule = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  enabled: Schema.optionalKey(Schema.Boolean),
  priority: Schema.optionalKey(Schema.Number),
  matchers: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      field: Schema.optionalKey(Schema.String),
      value: Schema.optionalKey(Schema.String),
    }),
  ),
  actions: Schema.Array(
    Schema.Struct({ type: Schema.String, value: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
})
export type RoutingRule = typeof RoutingRule.Type

/** A DNS record as `GET /zones/{id}/dns_records` lists it; only the fields Mailyard reads. */
export const DnsRecord = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  name: Schema.String,
  content: Schema.String,
})
export type DnsRecord = typeof DnsRecord.Type

const Envelope = <A extends Schema.Top>(result: A) =>
  Schema.Struct({
    success: Schema.Boolean,
    result: Schema.optionalKey(Schema.NullOr(result)),
    result_info: Schema.optionalKey(Schema.Struct({ total_pages: Schema.optionalKey(Schema.Number) })),
    errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String }))),
  })

const API = "https://api.cloudflare.com/client/v4"
const DAY = 86_400_000

const call = (token: string, method: string, path: string, body?: unknown) =>
  Effect.promise(async (): Promise<{ status: number; body: unknown }> => {
    try {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      })
      return { status: response.status, body: await response.json().catch(() => undefined) }
    } catch {
      return { status: 0, body: undefined }
    }
  })

const Loose = Envelope(Schema.Unknown)

const read = <A, I>(token: string, path: string, schema: Schema.Codec<A, I>) =>
  call(token, "GET", path).pipe(
    Effect.map(({ body }) =>
      Option.flatMap(Schema.decodeUnknownOption(Loose)(body), (e) =>
        e.success && e.result !== undefined && e.result !== null
          ? Schema.decodeUnknownOption(schema)(e.result)
          : Option.none(),
      ),
    ),
  )

const write = (token: string, method: string, path: string, body?: unknown) =>
  call(token, method, path, body).pipe(
    Effect.map(({ status, body: answer }): WriteOutcome<unknown> => {
      const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Loose)(answer))
      if (status >= 200 && status < 300 && decoded?.success)
        return { ok: true, value: decoded.result ?? null }
      const message = decoded?.errors?.map((e) => e.message).join("; ")
      return {
        ok: false,
        status,
        message: message || (status === 0 ? "Cloudflare didn't answer." : `Cloudflare answered ${status}.`),
      }
    }),
  )

export class CloudflareZones extends Context.Service<
  CloudflareZones,
  {
    readonly connected: boolean
    /** The zone a domain lives in: the domain itself, else its nearest parent the token can see. */
    readonly zoneFor: (name: string) => Effect.Effect<Option.Option<Zone>>
    /** Every zone the token can see, up to 1,000. */
    readonly zones: Effect.Effect<Option.Option<ReadonlyArray<Zone>>>
    /** DNSSEC's status (`active`, `pending`, `disabled`, …). */
    readonly dnssec: (zoneId: string) => Effect.Effect<Option.Option<string>>
    readonly sendingSubdomain: (
      zoneId: string,
      name: string,
    ) => Effect.Effect<Option.Option<SendingSubdomain>>
    /** Complaints to a sending subdomain over the last `days`, summed in seven-day windows. */
    readonly complaints: (
      zoneId: string,
      subdomainId: string,
      days: number,
    ) => Effect.Effect<Option.Option<number>>
    /** Email Routing's own records for a name (MX, SPF, DKIM), re-added and locked. */
    readonly enableRouting: (zoneId: string, name: string) => Effect.Effect<WriteOutcome<unknown>>
    /** A sending subdomain's records, re-applied by Email Sending (or the subdomain onboarded). */
    readonly fixSending: (zoneId: string, name: string) => Effect.Effect<WriteOutcome<unknown>>
    readonly createTxt: (
      zoneId: string,
      name: string,
      content: string,
    ) => Effect.Effect<WriteOutcome<unknown>>
    /** The TXT records at exactly `name` (HAL-3375). */
    readonly txtRecords: (
      zoneId: string,
      name: string,
    ) => Effect.Effect<Option.Option<ReadonlyArray<DnsRecord>>>
    /** Replaces one TXT record's content, keeping its name. */
    readonly updateTxt: (
      zoneId: string,
      recordId: string,
      name: string,
      content: string,
    ) => Effect.Effect<WriteOutcome<unknown>>
    /** The zone's Email Routing rules (catch-all excluded), up to 1,000. */
    readonly routingRules: (zoneId: string) => Effect.Effect<Option.Option<ReadonlyArray<RoutingRule>>>
    /** Points a rule at a Worker, keeping its matcher. */
    readonly routeToWorker: (
      zoneId: string,
      rule: RoutingRule,
      worker: string,
    ) => Effect.Effect<WriteOutcome<unknown>>
  }
>()("mailyard/CloudflareZones") {
  static readonly layer = Layer.effect(
    CloudflareZones,
    Effect.gen(function* () {
      const token = (yield* Bindings).CLOUDFLARE_DNS_TOKEN
      if (!token) {
        const refused = Effect.succeed<WriteOutcome<unknown>>({
          ok: false,
          status: 0,
          message: "No CLOUDFLARE_DNS_TOKEN: give Mailyard a zone token to fix records from here.",
        })
        return CloudflareZones.of({
          connected: false,
          zoneFor: () => Effect.succeedNone,
          zones: Effect.succeedNone,
          dnssec: () => Effect.succeedNone,
          sendingSubdomain: () => Effect.succeedNone,
          complaints: () => Effect.succeedNone,
          enableRouting: () => refused,
          fixSending: () => refused,
          createTxt: () => refused,
          txtRecords: () => Effect.succeedNone,
          updateTxt: () => refused,
          routingRules: () => Effect.succeedNone,
          routeToWorker: () => refused,
        })
      }
      const zoneFor = (name: string) =>
        Effect.gen(function* () {
          const labels = name.toLowerCase().split(".")
          for (let i = 0; labels.length - i >= 2; i++) {
            const candidate = labels.slice(i).join(".")
            const found = yield* read(
              token,
              `/zones?name=${encodeURIComponent(candidate)}`,
              Schema.Array(Zone),
            )
            const zone = Option.flatMap(found, (zs) => Option.fromNullishOr(zs[0]))
            if (Option.isSome(zone)) return zone
          }
          return Option.none<Zone>()
        })
      const sendingSubdomain = (zoneId: string, name: string) =>
        read(token, `/zones/${zoneId}/email/sending/subdomains`, Schema.Array(SendingSubdomain)).pipe(
          Effect.map((subs) =>
            Option.flatMap(subs, (s) => Option.fromNullishOr(s.find((x) => x.name === name))),
          ),
        )
      return CloudflareZones.of({
        connected: true,
        zoneFor,
        zones: Effect.gen(function* () {
          const all: Array<Zone> = []
          for (let page = 1; page <= 20; page++) {
            const { body } = yield* call(token, "GET", `/zones?per_page=50&page=${page}`)
            const decoded = Schema.decodeUnknownOption(Loose)(body)
            const zones = Option.flatMap(decoded, (e) =>
              e.success ? Schema.decodeUnknownOption(Schema.Array(Zone))(e.result ?? []) : Option.none(),
            )
            if (Option.isNone(decoded) || Option.isNone(zones))
              return page === 1 ? Option.none<ReadonlyArray<Zone>>() : Option.some<ReadonlyArray<Zone>>(all)
            all.push(...zones.value)
            if (page >= (decoded.value.result_info?.total_pages ?? 1)) break
          }
          return Option.some<ReadonlyArray<Zone>>(all)
        }),
        dnssec: (zoneId) =>
          read(token, `/zones/${zoneId}/dnssec`, Schema.Struct({ status: Schema.String })).pipe(
            Effect.map(Option.map((d) => d.status)),
          ),
        sendingSubdomain,
        complaints: (zoneId, subdomainId, days) =>
          Effect.gen(function* () {
            const end = Date.now()
            let total = 0
            for (let from = end - days * DAY; from < end; from += 7 * DAY) {
              const to = Math.min(from + 7 * DAY - 1000, end)
              const window = yield* read(
                token,
                `/zones/${zoneId}/email/sending/subdomains/${subdomainId}/reputation/complaints?start_at=${new Date(from).toISOString()}&end_at=${new Date(to).toISOString()}`,
                Schema.Struct({ complaints: Schema.Number }),
              )
              if (Option.isNone(window)) return Option.none<number>()
              total += window.value.complaints
            }
            return Option.some(total)
          }),
        enableRouting: (zoneId, name) => write(token, "POST", `/zones/${zoneId}/email/routing/dns`, { name }),
        fixSending: (zoneId, name) =>
          Effect.gen(function* () {
            const sub = yield* sendingSubdomain(zoneId, name)
            return Option.isSome(sub)
              ? yield* write(token, "POST", `/zones/${zoneId}/email/sending/subdomains/${sub.value.id}/dns`)
              : yield* write(token, "POST", `/zones/${zoneId}/email/sending/subdomains`, { name })
          }),
        createTxt: (zoneId, name, content) =>
          write(token, "POST", `/zones/${zoneId}/dns_records`, { type: "TXT", name, content, ttl: 1 }),
        txtRecords: (zoneId, name) =>
          read(
            token,
            `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}&per_page=100`,
            Schema.Array(DnsRecord),
          ),
        updateTxt: (zoneId, recordId, name, content) =>
          write(token, "PATCH", `/zones/${zoneId}/dns_records/${recordId}`, { type: "TXT", name, content }),
        routingRules: (zoneId) =>
          Effect.gen(function* () {
            const all: Array<RoutingRule> = []
            for (let page = 1; page <= 20; page++) {
              const { body } = yield* call(
                token,
                "GET",
                `/zones/${zoneId}/email/routing/rules?per_page=50&page=${page}`,
              )
              const decoded = Schema.decodeUnknownOption(Loose)(body)
              const rules = Option.flatMap(decoded, (e) =>
                e.success
                  ? Schema.decodeUnknownOption(Schema.Array(RoutingRule))(e.result ?? [])
                  : Option.none(),
              )
              if (Option.isNone(decoded) || Option.isNone(rules))
                return Option.none<ReadonlyArray<RoutingRule>>()
              all.push(...rules.value)
              if (page >= (decoded.value.result_info?.total_pages ?? 1)) break
            }
            return Option.some<ReadonlyArray<RoutingRule>>(all)
          }),
        routeToWorker: (zoneId, rule, worker) =>
          write(token, "PUT", `/zones/${zoneId}/email/routing/rules/${rule.id}`, {
            name: rule.name ?? `Mailyard: ${rule.matchers[0]?.value ?? ""}`,
            enabled: true,
            ...(rule.priority !== undefined ? { priority: rule.priority } : {}),
            matchers: rule.matchers,
            actions: [{ type: "worker", value: [worker] }],
          }),
      })
    }),
  )
}

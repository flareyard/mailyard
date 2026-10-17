import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"

/**
 * Read-only views of the account's Email Sending limits and reputation, from the Cloudflare API.
 * Mailyard holds no Cloudflare token by default, so this is optional: with CLOUDFLARE_ACCOUNT_ID and a
 * read-only CLOUDFLARE_EMAIL_READ_TOKEN set it reads them; without, every call answers `None` and the
 * screens say "not connected" instead of guessing. Shapes measured on 2026-10-16
 * (GET /accounts/{id}/email/sending/limits and /reputation).
 */
const Threshold = Schema.Struct({
  warning_at: Schema.Number,
  at_risk_at: Schema.Number,
  minimum_denominator: Schema.Number,
})

export const Limits = Schema.Struct({
  quota: Schema.Struct({ value: Schema.Number, unit: Schema.String }),
  usage: Schema.Struct({
    sent: Schema.Number,
    over_quota: Schema.Boolean,
    resets_at: Schema.NullOr(Schema.String),
  }),
})
export type Limits = typeof Limits.Type

export const Reputation = Schema.Struct({
  status: Schema.String,
  status_since: Schema.NullOr(Schema.String),
  grace_started_at: Schema.NullOr(Schema.String),
  evaluated_at: Schema.NullOr(Schema.String),
  active_policy: Schema.Struct({
    customer_bounce: Threshold,
    complaint: Threshold,
    spam_rejection: Threshold,
    suspension_after_hours: Schema.Number,
  }),
})
export type Reputation = typeof Reputation.Type

const LimitsEnvelope = Schema.Struct({ success: Schema.Boolean, result: Schema.NullOr(Limits) })
const ReputationEnvelope = Schema.Struct({ success: Schema.Boolean, result: Schema.NullOr(Reputation) })

/** One `email.sending` event subscription (GET /accounts/{id}/event_subscriptions/subscriptions, measured 2026-10-17). */
const Subscription = Schema.Struct({
  enabled: Schema.Boolean,
  source: Schema.Struct({ type: Schema.String, domain: Schema.optionalKey(Schema.String) }),
  destination: Schema.Struct({ type: Schema.String, queue_id: Schema.optionalKey(Schema.String) }),
})
const SubscriptionsEnvelope = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.NullOr(Schema.Array(Subscription)),
  result_info: Schema.optionalKey(Schema.Struct({ total_pages: Schema.Number })),
})
const QueuesEnvelope = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.NullOr(Schema.Array(Schema.Struct({ queue_id: Schema.String, queue_name: Schema.String }))),
})

/**
 * One entry on Cloudflare's Email Sending suppression list
 * (GET /accounts/{id}/email/sending/suppressions, measured 2026-10-17). Cloudflare adds its own for
 * hard bounces, scoped to the sending domain and sometimes expiring; `read_only` ones can't be deleted.
 */
export const CloudflareSuppression = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  reason: Schema.String,
  created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  expires_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  read_only: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(
    Schema.Struct({ type: Schema.String, value: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
})
export type CloudflareSuppression = typeof CloudflareSuppression.Type

const SuppressionPage = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.NullOr(Schema.Array(CloudflareSuppression)),
  result_info: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
})
const Created = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.NullOr(Schema.Struct({ id: Schema.String })),
})
const BulkResult = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.NullOr(
    Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          index: Schema.Number,
          email: Schema.String,
          status: Schema.String,
          id: Schema.optionalKey(Schema.String),
          error: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
})
const Errors = Schema.Struct({
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))),
})

/** What a write to Cloudflare's list came to: done, or refused with Cloudflare's status and words. */
export type WriteOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly status: number; readonly message: string }

/** The queue Email Sending's events land on, unless MAILYARD_EVENTS_QUEUE renames it. */
export const EVENTS_QUEUE = "mailyard-email-events"

/** A Cloudflare API call that never throws: the status and parsed body, or status 0 on a network error. */
const request = (url: string, token: string, init: { method: string; body?: unknown }) =>
  Effect.promise(async (): Promise<{ status: number; body: unknown }> => {
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      })
      return { status: response.status, body: await response.json().catch(() => undefined) }
    } catch {
      return { status: 0, body: undefined }
    }
  })

const refusal = (status: number, body: unknown) => {
  const errors = Option.getOrUndefined(Schema.decodeUnknownOption(Errors)(body))?.errors ?? []
  const message = errors
    .map((e) => e.message)
    .filter(Boolean)
    .join("; ")
  return {
    ok: false as const,
    status,
    message: message || (status === 0 ? "Cloudflare didn't answer." : `Cloudflare answered ${status}.`),
  }
}

const fetchJson = (url: string, token: string) =>
  Effect.promise(async (): Promise<unknown> => {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })
      return await response.json()
    } catch {
      return undefined
    }
  })

export class CloudflareEmail extends Context.Service<
  CloudflareEmail,
  {
    readonly connected: boolean
    readonly limits: Effect.Effect<Option.Option<Limits>>
    readonly reputation: Effect.Effect<Option.Option<Reputation>>
    /**
     * The sending domains whose delivery events reach this app's events queue: enabled
     * `email.sending` subscriptions pointing at it. `None` when not connected, or when the token
     * can't read event subscriptions or queues (it needs Queues: Read as well as Email Sending: Read).
     */
    readonly subscribedDomains: Effect.Effect<Option.Option<ReadonlySet<string>>>
    /**
     * Cloudflare's Email Sending suppression list. Reads use the read token (or the write token
     * when there's no read token); writes need CLOUDFLARE_EMAIL_WRITE_TOKEN (Email Sending: Edit).
     */
    readonly suppressions: {
      readonly canRead: boolean
      readonly canWrite: boolean
      /** One page of the list, up to 1,000; `None` when it can't be read. */
      readonly page: (
        cursor: string | null,
      ) => Effect.Effect<
        Option.Option<{ readonly items: ReadonlyArray<CloudflareSuppression>; readonly next: string | null }>
      >
      /** Every entry for one address, across scopes. */
      readonly find: (email: string) => Effect.Effect<Option.Option<ReadonlyArray<CloudflareSuppression>>>
      /** Adds an account-wide suppression. */
      readonly create: (email: string, note: string) => Effect.Effect<WriteOutcome<{ readonly id: string }>>
      /** Adds up to 1,000 account-wide suppressions in one call; each item's id, or why not. */
      readonly bulk: (
        items: ReadonlyArray<{ readonly email: string; readonly note: string }>,
      ) => Effect.Effect<
        WriteOutcome<
          ReadonlyArray<{ readonly email: string; readonly id: string | null; readonly error: string | null }>
        >
      >
      readonly remove: (id: string) => Effect.Effect<WriteOutcome<null>>
    }
  }
>()("mailyard/CloudflareEmail") {
  static readonly layer = Layer.effect(
    CloudflareEmail,
    Effect.gen(function* () {
      const env = yield* Bindings
      const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_EMAIL_READ_TOKEN: token } = env
      const readToken = token || env.CLOUDFLARE_EMAIL_WRITE_TOKEN
      const writeToken = env.CLOUDFLARE_EMAIL_WRITE_TOKEN
      const queueName = env.MAILYARD_EVENTS_QUEUE ?? EVENTS_QUEUE
      if (!account || !token) {
        return CloudflareEmail.of({
          connected: false,
          limits: Effect.succeedNone,
          reputation: Effect.succeedNone,
          subscribedDomains: Effect.succeedNone,
          suppressions: suppressionsApi(account, readToken, writeToken),
        })
      }
      const base = `https://api.cloudflare.com/client/v4/accounts/${account}`
      const limits = fetchJson(`${base}/email/sending/limits`, token).pipe(
        Effect.map((body) =>
          Option.flatMap(Schema.decodeUnknownOption(LimitsEnvelope)(body), (d) =>
            d.success && d.result ? Option.some(d.result) : Option.none(),
          ),
        ),
      )
      const reputation = fetchJson(`${base}/email/sending/reputation`, token).pipe(
        Effect.map((body) =>
          Option.flatMap(Schema.decodeUnknownOption(ReputationEnvelope)(body), (d) =>
            d.success && d.result ? Option.some(d.result) : Option.none(),
          ),
        ),
      )
      const subscribedDomains = Effect.gen(function* () {
        const queues = Schema.decodeUnknownOption(QueuesEnvelope)(
          yield* fetchJson(`${base}/queues?name=${encodeURIComponent(queueName)}`, token),
        )
        const queueId = Option.flatMap(queues, (q) =>
          Option.fromNullishOr(
            q.success ? q.result?.find((x) => x.queue_name === queueName)?.queue_id : undefined,
          ),
        )
        if (Option.isNone(queueId)) return Option.none<ReadonlySet<string>>()
        const found = new Set<string>()
        for (let page = 1; page <= 20; page++) {
          const body = Schema.decodeUnknownOption(SubscriptionsEnvelope)(
            yield* fetchJson(`${base}/event_subscriptions/subscriptions?per_page=50&page=${page}`, token),
          )
          if (Option.isNone(body) || !body.value.success || !body.value.result)
            return Option.none<ReadonlySet<string>>()
          for (const s of body.value.result) {
            if (
              s.enabled &&
              s.source.type === "email.sending" &&
              s.source.domain &&
              s.destination.queue_id === queueId.value
            )
              found.add(s.source.domain.toLowerCase())
          }
          if (page >= (body.value.result_info?.total_pages ?? 1)) break
        }
        return Option.some<ReadonlySet<string>>(found)
      })
      return CloudflareEmail.of({
        connected: true,
        limits,
        reputation,
        subscribedDomains,
        suppressions: suppressionsApi(account, readToken, writeToken),
      })
    }),
  )
}

const NOT_CONNECTED = {
  ok: false as const,
  status: 0,
  message:
    "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_WRITE_TOKEN (Email Sending: Edit) to change Cloudflare's list.",
}

const suppressionsApi = (
  account: string | undefined,
  readToken: string | undefined,
  writeToken: string | undefined,
): CloudflareEmail["Service"]["suppressions"] => {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/suppressions`
  const canRead = Boolean(account && readToken)
  const canWrite = Boolean(account && writeToken)
  const list = (query: string) =>
    canRead
      ? request(`${base}?${query}`, readToken as string, { method: "GET" }).pipe(
          Effect.map(({ body }) =>
            Option.flatMap(Schema.decodeUnknownOption(SuppressionPage)(body), (d) =>
              d.success && d.result
                ? Option.some({ items: d.result, next: d.result_info?.next_cursor ?? null })
                : Option.none(),
            ),
          ),
        )
      : Effect.succeedNone
  return {
    canRead,
    canWrite,
    page: (cursor) => list(`per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    find: (email) =>
      list(`per_page=100&email=${encodeURIComponent(email)}`).pipe(Effect.map(Option.map((p) => p.items))),
    create: (email, note) =>
      canWrite
        ? request(base, writeToken as string, {
            method: "POST",
            body: { email, note: note.slice(0, 1000) },
          }).pipe(
            Effect.map(({ status, body }) => {
              const created = Option.getOrUndefined(Schema.decodeUnknownOption(Created)(body))
              return created?.success && created.result
                ? { ok: true as const, value: { id: created.result.id } }
                : refusal(status, body)
            }),
          )
        : Effect.succeed(NOT_CONNECTED),
    bulk: (items) =>
      canWrite
        ? request(`${base}/bulk`, writeToken as string, {
            method: "POST",
            body: { items: items.map((i) => ({ email: i.email, note: i.note.slice(0, 1000) })) },
          }).pipe(
            Effect.map(({ status, body }) => {
              const done = Option.getOrUndefined(Schema.decodeUnknownOption(BulkResult)(body))
              if (!done?.success || !done.result) return refusal(status, body)
              return {
                ok: true as const,
                value: done.result.items.map((i) => ({
                  email: i.email,
                  id: i.status === "processed" ? (i.id ?? null) : null,
                  error: i.status === "processed" ? null : (i.error ?? i.status),
                })),
              }
            }),
          )
        : Effect.succeed(NOT_CONNECTED),
    remove: (id) =>
      canWrite
        ? request(`${base}/${encodeURIComponent(id)}`, writeToken as string, { method: "DELETE" }).pipe(
            Effect.map(({ status, body }) =>
              status >= 200 && status < 300 ? { ok: true as const, value: null } : refusal(status, body),
            ),
          )
        : Effect.succeed(NOT_CONNECTED),
  }
}

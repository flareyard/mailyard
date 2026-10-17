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

/** The queue Email Sending's events land on, unless MAILYARD_EVENTS_QUEUE renames it. */
export const EVENTS_QUEUE = "mailyard-email-events"

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
  }
>()("mailyard/CloudflareEmail") {
  static readonly layer = Layer.effect(
    CloudflareEmail,
    Effect.gen(function* () {
      const env = yield* Bindings
      const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_EMAIL_READ_TOKEN: token } = env
      const queueName = env.MAILYARD_EVENTS_QUEUE ?? EVENTS_QUEUE
      if (!account || !token) {
        return CloudflareEmail.of({
          connected: false,
          limits: Effect.succeedNone,
          reputation: Effect.succeedNone,
          subscribedDomains: Effect.succeedNone,
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
      })
    }),
  )
}

import { Context, Effect, Layer, Option, Schema } from "effect"
import { Bindings } from "../Bindings.ts"

/**
 * Read-only views of the account's Email Sending limits and reputation, from the Cloudflare API.
 * Mailflare holds no Cloudflare token by default, so this is optional: with CLOUDFLARE_ACCOUNT_ID and a
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
  }
>()("mailflare/CloudflareEmail") {
  static readonly layer = Layer.effect(
    CloudflareEmail,
    Effect.gen(function* () {
      const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_EMAIL_READ_TOKEN: token } = yield* Bindings
      if (!account || !token) {
        return CloudflareEmail.of({
          connected: false,
          limits: Effect.succeedNone,
          reputation: Effect.succeedNone,
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
      return CloudflareEmail.of({
        connected: true,
        limits,
        reputation,
      })
    }),
  )
}

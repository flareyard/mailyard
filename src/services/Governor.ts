import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import type { GovernorConfig } from "../campaigns/governor.ts"
import type { Grant, Outcome, Recipient, SendGovernorDO } from "../objects/SendGovernorDO.ts"
import { CloudflareEmail } from "./CloudflareEmail.ts"

export class GovernorUnavailable extends Schema.TaggedError<GovernorUnavailable>()("GovernorUnavailable", {
  cause: Schema.Defect(),
}) {}

/** The account has one governor: every campaign shares one quota. */
const ACCOUNT = "account"

/** Cloudflare's quota is read at most this often per isolate; it changes rarely and the API is slow. */
const QUOTA_TTL_MS = 10 * 60_000

export type GovernorOverview = ReturnType<SendGovernorDO["overview"]>
export type CampaignPace = ReturnType<SendGovernorDO["campaign"]>

/**
 * Talks to SendGovernorDO. Bulk senders ask it before sending; transactional sends tell it after,
 * and a failure to tell it never fails the send.
 */
export class Governor extends Context.Service<
  Governor,
  {
    acquire(input: {
      readonly campaignId: string
      readonly stream?: "campaign" | "automation"
      readonly sendingDomain: string
      readonly recipients: ReadonlyArray<Recipient>
      readonly now?: number
    }): Effect.Effect<Grant, GovernorUnavailable>
    consume(stream: "transactional" | "mailbox", count: number): Effect.Effect<void>
    record(input: {
      readonly campaignId: string | null
      readonly sendingDomain: string
      readonly outcome: Outcome
      readonly now?: number
    }): Effect.Effect<{ readonly paused: boolean; readonly reason: string | null }, GovernorUnavailable>
    pause(campaignId: string, reason: string): Effect.Effect<void, GovernorUnavailable>
    resume(campaignId: string): Effect.Effect<void, GovernorUnavailable>
    campaign(input: {
      readonly campaignId: string
      readonly sendingDomain: string
      readonly remaining: number
    }): Effect.Effect<CampaignPace, GovernorUnavailable>
    overview: Effect.Effect<GovernorOverview, GovernorUnavailable>
    configure(patch: Partial<GovernorConfig>): Effect.Effect<GovernorConfig, GovernorUnavailable>
  }
>()("mailyard/Governor") {
  static readonly layer = Layer.effect(
    Governor,
    Effect.gen(function* () {
      const { SEND_GOVERNOR } = yield* Bindings
      const cloudflare = yield* CloudflareEmail
      const stub = () => SEND_GOVERNOR.get(SEND_GOVERNOR.idFromName(ACCOUNT))
      const call = <A>(run: (s: DurableObjectStub<SendGovernorDO>) => Promise<A>) =>
        Effect.tryPromise({ try: () => run(stub()), catch: (cause) => new GovernorUnavailable({ cause }) })
      let cached: { readonly value: number | null; readonly at: number } | null = null
      const liveQuota = Effect.gen(function* () {
        if (!cloudflare.connected) return null
        if (cached && Date.now() - cached.at < QUOTA_TTL_MS) return cached.value
        const limits = yield* cloudflare.limits
        const value = Option.match(limits, { onNone: () => null, onSome: (l) => l.quota.value })
        cached = { value, at: Date.now() }
        return value
      })
      return Governor.of({
        acquire: (input) =>
          liveQuota.pipe(
            Effect.flatMap((quota) =>
              call(
                (s) =>
                  s.acquire({ ...input, now: input.now ?? Date.now(), liveQuota: quota }) as Promise<Grant>,
              ),
            ),
          ),
        consume: (stream, count) =>
          call((s) => s.consume({ stream, count, now: Date.now() })).pipe(
            Effect.catchCause((cause) => Effect.logWarning("governor: could not record a send", cause)),
          ),
        record: (input) => call((s) => s.record({ ...input, now: input.now ?? Date.now() })),
        pause: (campaignId, reason) => call((s) => s.pause(campaignId, reason, Date.now())),
        resume: (campaignId) => call((s) => s.resume(campaignId, Date.now())),
        campaign: (input) =>
          liveQuota.pipe(
            Effect.flatMap((quota) =>
              call(
                (s) => s.campaign({ ...input, now: Date.now(), liveQuota: quota }) as Promise<CampaignPace>,
              ),
            ),
          ),
        overview: liveQuota.pipe(
          Effect.flatMap((quota) =>
            call((s) => s.overview({ now: Date.now(), liveQuota: quota }) as Promise<GovernorOverview>),
          ),
        ),
        configure: (patch) => call((s) => s.configure(patch) as Promise<GovernorConfig>),
      })
    }),
  )
}

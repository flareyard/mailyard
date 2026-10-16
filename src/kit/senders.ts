import { Effect, Layer } from "effect"
import { makeCloudflareSender, type SendEmailBinding } from "./cloudflare.ts"
import { failover } from "./failover.ts"
import { Ids } from "./Ids.ts"
import { Sender } from "./Sender.ts"
import { makeSmtpSender, type SmtpConfig, type SmtpTransport } from "./smtp.ts"

/** Sender over Cloudflare Email Service (the Worker's `send_email` binding). */
export const SenderCloudflare = (binding: SendEmailBinding) =>
  Layer.succeed(Sender, Sender.of(makeCloudflareSender(binding)))

/** Sender over SMTP. Pass `workerSmtpTransport` from `@flareyard/kit/smtp-worker` inside a Worker. */
export const SenderSmtp = (config: SmtpConfig, transport: SmtpTransport) =>
  Layer.effect(
    Sender,
    Effect.gen(function* () {
      const ids = yield* Ids
      return Sender.of(makeSmtpSender(config, transport, ids))
    }),
  )

/**
 * Email Service first, SMTP when Email Service can't take the message (MBPrep's production setup since
 * 2026-10-02, HAL-1857). Without SMTP settings it's Email Service alone.
 */
export const SenderCloudflareWithSmtpFallback = (
  binding: SendEmailBinding,
  smtp: { readonly config: SmtpConfig; readonly transport: SmtpTransport } | undefined,
) =>
  Layer.effect(
    Sender,
    Effect.gen(function* () {
      const cloudflare = makeCloudflareSender(binding)
      if (!smtp) return Sender.of(cloudflare)
      const ids = yield* Ids
      return Sender.of(failover(cloudflare, makeSmtpSender(smtp.config, smtp.transport, ids)))
    }),
  )

import * as Effect from "effect/Effect"
import type { Ids } from "./Ids.ts"
import {
  type Outgoing,
  QuotaExceeded,
  SendDeferred,
  type SendError,
  SendRejected,
  type SendResult,
  validate,
} from "./Sender.ts"

export interface SmtpConfig {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
}

/**
 * Sends one message over SMTP. The Workers implementation (`./smtp-worker.ts`) uses `cloudflare:sockets`;
 * tests pass a fake. The message already carries its Message-ID header.
 */
export interface SmtpTransport {
  send(config: SmtpConfig, message: Outgoing): Promise<void>
}

/**
 * SMTP replies carry their meaning in the code: 4xx is "try again later", 5xx is "no". A failure with
 * no code at all (refused connection, TLS or socket timeout) never reached a verdict, so it's transient.
 * `554 5.7.1` is how Spacemail answers when a sender exceeds its hourly cap (measured by MBPrep,
 * 2026-10-02), which is a quota, not a refusal of the message.
 */
export const classifySmtpError = (error: unknown): SendError => {
  const text = error instanceof Error ? error.message : String(error)
  const reply = /\b([245]\d\d)[ -](\d\.\d{1,3}\.\d{1,3})?/.exec(text)
  const code = reply?.[1]
  if (!code) return new SendDeferred({ code: "SMTP_NO_REPLY", message: text })
  if (code.startsWith("4")) return new SendDeferred({ code: `SMTP_${code}`, message: text })
  if (code === "554" && reply?.[2] === "5.7.1" && /rate|limit|quota|exceed/i.test(text)) {
    return new QuotaExceeded({ message: text })
  }
  return new SendRejected({ code: `SMTP_${code}`, message: text })
}

/** A Sender over SMTP with implicit TLS. It assigns the Message-ID itself, since SMTP doesn't return one. */
export const makeSmtpSender = (config: SmtpConfig, transport: SmtpTransport, ids: Ids["Service"]) => ({
  send: (message: Outgoing): Effect.Effect<SendResult, SendError> =>
    Effect.gen(function* () {
      const valid = yield* validate(message)
      const domain = valid.from.email.split("@")[1] ?? "localhost"
      const messageId = `${yield* ids.next}@${domain}`
      const withId: Outgoing = { ...valid, headers: { ...valid.headers, "Message-ID": `<${messageId}>` } }
      yield* Effect.tryPromise({ try: () => transport.send(config, withId), catch: classifySmtpError })
      return { messageId }
    }),
})

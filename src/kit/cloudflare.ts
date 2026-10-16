import { Effect, Predicate } from "effect"
import {
  type Address,
  InvalidMessage,
  type Outgoing,
  QuotaExceeded,
  SendDeferred,
  type SendError,
  SendRejected,
  type SendResult,
  SendSuppressed,
  validate,
} from "./Sender.ts"

type Party = string | { readonly email: string; readonly name: string }

/**
 * The structured `send()` of a Worker's `send_email` binding (Email Service Workers API, read 2026-10-16).
 * Declared here rather than taken from workers-types so the mapping can be tested without a binding.
 */
export interface SendEmailBinding {
  send(message: {
    from: Party
    to: Party | Array<Party>
    cc?: Party | Array<Party>
    bcc?: Party | Array<Party>
    replyTo?: Party
    subject: string
    html?: string
    text?: string
    headers?: Record<string, string>
    attachments?: Array<{
      content: ArrayBufferView
      filename: string
      type: string
      disposition: "attachment" | "inline"
      contentId?: string
    }>
  }): Promise<{ messageId: string }>
}

/** Codes that mean the message itself is wrong: fix it, don't retry it or send it elsewhere. */
const INVALID = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
])

/** Codes for a temporary condition at Cloudflare: retry with backoff. */
const TRANSIENT = new Set(["E_RATE_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR"])

/**
 * Turns an error thrown by the binding into a typed send error. Every code in the Workers API error
 * table maps somewhere; an error with no code (a network failure inside the runtime) is treated as
 * transient, because nothing says the message was refused.
 */
export const classifyCloudflareError = (error: unknown, message: Outgoing): SendError => {
  const code = Predicate.hasProperty(error, "code") && Predicate.isString(error.code) ? error.code : undefined
  const text = error instanceof Error ? error.message : String(error)
  if (code === undefined) return new SendDeferred({ code: "E_NO_CODE", message: text })
  if (INVALID.has(code)) return new InvalidMessage({ reason: `${code}: ${text}` })
  if (TRANSIENT.has(code)) return new SendDeferred({ code, message: text })
  if (code === "E_DAILY_LIMIT_EXCEEDED") return new QuotaExceeded({ message: text })
  if (code === "E_RECIPIENT_SUPPRESSED") {
    const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map((a) => a.email)
    return new SendSuppressed({ recipients })
  }
  // E_SENDER_NOT_VERIFIED, E_SENDER_DOMAIN_NOT_AVAILABLE, E_RECIPIENT_NOT_ALLOWED, E_DELIVERY_FAILED,
  // and any code added after this was written: refused, with the code kept for the log.
  return new SendRejected({ code, message: text })
}

const party = (a: Address): Party => (a.name ? { email: a.email, name: a.name } : a.email)

/** A Sender over Cloudflare Email Service. */
export const makeCloudflareSender = (binding: SendEmailBinding) => ({
  send: (message: Outgoing): Effect.Effect<SendResult, SendError> =>
    validate(message).pipe(
      Effect.flatMap((m) =>
        Effect.tryPromise({
          try: () =>
            binding.send({
              from: party(m.from),
              to: m.to.map(party),
              ...(m.cc ? { cc: m.cc.map(party) } : {}),
              ...(m.bcc ? { bcc: m.bcc.map(party) } : {}),
              ...(m.replyTo ? { replyTo: party(m.replyTo) } : {}),
              subject: m.subject,
              ...(m.html !== undefined ? { html: m.html } : {}),
              ...(m.text !== undefined ? { text: m.text } : {}),
              ...(m.headers ? { headers: { ...m.headers } } : {}),
              ...(m.attachments
                ? {
                    attachments: m.attachments.map((a) => ({
                      content: a.content,
                      filename: a.filename,
                      type: a.type,
                      disposition: a.disposition,
                      ...(a.contentId ? { contentId: a.contentId } : {}),
                    })),
                  }
                : {}),
            }),
          catch: (error) => classifyCloudflareError(error, m),
        }),
      ),
      Effect.map(({ messageId }) => ({ messageId })),
    ),
})

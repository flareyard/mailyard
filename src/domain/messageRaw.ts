import type { Outgoing } from "../kit/index.ts"
import { buildMime, encodeWord, formatAddress } from "../mail/mime.ts"

/** Email Service's id with angle brackets, as a Message-ID header carries it. */
const messageIdHeader = (cfMessageId: string | null) =>
  cfMessageId ? (cfMessageId.startsWith("<") ? cfMessageId : `<${cfMessageId}>`) : null

/**
 * The headers Mailyard handed Email Service for a message (HAL-3413), in order. Email Service adds
 * its own on the way out (Received, DKIM-Signature, its Date), so this is what Mailyard decided, not
 * a capture of the wire.
 */
export const sentHeaders = (m: Outgoing, cfMessageId: string | null) => {
  const out: Array<{ name: string; value: string }> = [
    { name: "From", value: formatAddress(m.from) },
    { name: "To", value: m.to.map(formatAddress).join(", ") },
  ]
  if (m.cc?.length) out.push({ name: "Cc", value: m.cc.map(formatAddress).join(", ") })
  if (m.replyTo) out.push({ name: "Reply-To", value: formatAddress(m.replyTo) })
  out.push({ name: "Subject", value: m.subject })
  const id = messageIdHeader(cfMessageId)
  if (id) out.push({ name: "Message-ID", value: id })
  for (const [name, value] of Object.entries(m.headers ?? {})) out.push({ name, value })
  return out
}

/**
 * `GET /v1/messages/{id}/raw`: the stored rendered copy as an RFC 5322 message, dated when it was
 * created and carrying Email Service's Message-ID once it has one. A rebuild from what Mailyard sent,
 * marked as such, since Email Service builds the MIME it actually transmits.
 */
export const rawMessage = (
  m: Outgoing,
  row: { readonly cfMessageId: string | null; readonly createdAt: number },
) =>
  buildMime(
    { ...m, headers: { ...m.headers, "X-Mailyard-Copy": encodeWord("rebuilt from the message log") } },
    { messageId: messageIdHeader(row.cfMessageId), date: new Date(row.createdAt) },
  )

import { env } from "cloudflare:workers"
import { NO_AUTH_RESULTS } from "../../src/inbound/auth.ts"
import type { InboundDelivery, Party } from "../../src/mailbox/types.ts"

let n = 0

/** An InboundDelivery with sensible defaults, as the inbound pipeline would hand a mailbox. */
export const delivery = (
  fields: Partial<InboundDelivery> & { readonly fromAddress?: string } = {},
): InboundDelivery => {
  const id = fields.id ?? `inb_t${++n}_${crypto.randomUUID().slice(0, 8)}`
  const from: Party | null =
    fields.from === undefined
      ? { name: "Ada Lovelace", address: fields.fromAddress ?? "ada@example.org" }
      : fields.from
  return {
    id,
    receivedAt: Date.now(),
    envelopeFrom: from?.address ?? "bounce@example.org",
    envelopeTo: "sam@acme.test",
    via: "mailbox",
    tag: null,
    rawKey: `raw/${id}.eml`,
    bodyKey: `body/${id}.json`,
    size: 1000,
    messageId: `<${id}@example.org>`,
    inReplyTo: null,
    references: [],
    subject: "Hello",
    date: null,
    sender: null,
    replyTo: [],
    to: [{ name: "Sam", address: "sam@acme.test" }],
    cc: [],
    snippet: "Hello there.",
    bodyText: "Hello there.",
    hasHtml: false,
    auth: NO_AUTH_RESULTS,
    automated: false,
    listId: null,
    listUnsubscribe: null,
    attachments: [],
    ...fields,
    from,
  }
}

/** A fresh, empty mailbox Durable Object. */
export const freshMailbox = () => env.MAILBOX.get(env.MAILBOX.idFromName(`test-${crypto.randomUUID()}`))

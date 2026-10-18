import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  DELIVERY_KINDS,
  decodeMailEvent,
  MAIL_EVENT_TYPES,
  type MailEvent,
} from "../../src/contracts/mailEvents.ts"
import { mailEventsJsonSchema, SCHEMA_FILE } from "../../tools/contracts/mailEventsSchema.ts"

/**
 * A consumer's view of the lane (HAL-3306): what Hermes does with each queue message. The samples
 * here are the shapes the producer writes (test/mailEvents.test.ts checks the producer against the
 * same decoder).
 */
const base = { version: 1, id: "mev_1", at: 1_792_000_000_000, mailboxId: "mbx_1" } as const
const SAMPLES: ReadonlyArray<MailEvent> = [
  {
    ...base,
    type: "message.received",
    threadId: "thr_1",
    messageId: "msg_1",
    internetMessageId: "<a@example.org>",
    from: { email: "ada@example.org", name: "Ada" },
    to: "support+billing@example.com",
    subject: "Invoice",
    snippet: "Hello",
    folder: "inbox",
    spam: false,
    automated: false,
    attachments: 1,
  },
  {
    ...base,
    type: "message.sent",
    outId: "out_1",
    messageId: "msg_2",
    recipient: "ada@example.org",
    subject: "Re: Invoice",
  },
  { ...base, type: "thread.assigned", threadId: "thr_1", assignee: "key_1", by: "rule" },
  ...DELIVERY_KINDS.map(
    (kind): MailEvent => ({
      ...base,
      type: "delivery",
      kind,
      outId: "out_1",
      recipient: "ada@example.org",
      subject: "Re: Invoice",
      bounce: kind === "bounced" ? "hard" : null,
      smtpResponse: null,
    }),
  ),
]

/** A minimal consumer: decode, then switch on the type. */
const consume = (body: unknown) => {
  const event = decodeMailEvent(body)
  switch (event.type) {
    case "message.received":
      return `${event.type}:${event.threadId}`
    case "message.sent":
      return `${event.type}:${event.outId}`
    case "thread.assigned":
      return `${event.type}:${event.assignee}`
    case "delivery":
      return `${event.type}:${event.kind}`
  }
}

describe("the mail-events contract", () => {
  it("decodes every event type a consumer can receive", () => {
    const seen = new Set(SAMPLES.map((s) => s.type))
    expect([...seen].sort()).toEqual([...MAIL_EVENT_TYPES].sort())
    for (const sample of SAMPLES) expect(consume(JSON.parse(JSON.stringify(sample)))).toContain(sample.type)
  })

  it("refuses another version, an unknown type and a missing field", () => {
    const [received] = SAMPLES
    expect(() => decodeMailEvent({ ...received, version: 2 })).toThrow()
    expect(() => decodeMailEvent({ ...received, type: "message.exploded" })).toThrow()
    const { threadId: _, ...missing } = received as Extract<MailEvent, { type: "message.received" }>
    expect(() => decodeMailEvent(missing)).toThrow()
  })

  it("keeps docs/mail-events.schema.json in step with the Schema (bun run contracts)", () => {
    expect(readFileSync(SCHEMA_FILE, "utf8")).toBe(mailEventsJsonSchema())
  })
})

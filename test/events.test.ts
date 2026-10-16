import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import worker from "../src/workers/api.ts"
import { call, createKey, json } from "./helpers.ts"

let secret = ""
beforeAll(async () => {
  secret = (await createKey("secret")).key
})

/** Shaped like the documented examples (email-service/reference/event-subscriptions, read 2026-10-16). */
const event = (
  type: "delivered" | "deferred" | "bounced" | "failed" | "rejected" | "complained",
  messageId: string,
  recipient: string,
  extra: Record<string, unknown> = {},
  eventId = crypto.randomUUID(),
) => ({
  type: `cf.email.sending.message.${type}`,
  source: { type: "email.sending", zoneId: "023e105f4ecef8ad9ca31a8372d0c353", domain: "mailyard.test" },
  payload: {
    eventId,
    messageId,
    sender: "hello@mailyard.test",
    recipient,
    subject: "Welcome",
    terminal: type !== "deferred",
    delivery: { status: type, provider: "gmail", deliveryTimeMs: 1234, smtpStatusCode: "250" },
    ...extra,
  },
  metadata: {
    accountId: "f9f79265f388666de8122cfb508d7776",
    eventSubscriptionId: "1830c4bb612e43c3af7f4cada31fbf3f",
    eventSchemaVersion: 1,
    eventTimestamp: "2026-10-16T02:48:57.132Z",
  },
})

const deliver = async (...bodies: Array<unknown>) => {
  const batch = createMessageBatch(
    "mailyard-email-events",
    bodies.map((body, i) => ({
      id: `e${i}-${crypto.randomUUID()}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  )
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  return getQueueResult(batch, ctx)
}

const sendOne = async (to: string) => {
  const response = await call("/v1/send", {
    method: "POST",
    key: secret,
    json: { to, subject: "Welcome", body: "<p>hi</p>", from: "hello@mailyard.test" },
  })
  const { data } = await json<{ data: { emails: Array<{ email: string; contact: { id: string } }> } }>(
    response,
  )
  const id = data.emails[0]?.email ?? ""
  const row = await env.DB.prepare("select cf_message_id from messages_out where id = ?")
    .bind(id)
    .first<{ cf_message_id: string }>()
  return { id, cfMessageId: row?.cf_message_id ?? "", contactId: data.emails[0]?.contact.id ?? "" }
}

const status = async (id: string) =>
  (await env.DB.prepare("select status, bounce_type, provider, smtp_response from messages_out where id = ?")
    .bind(id)
    .first()) as {
    status: string
    bounce_type: string | null
    provider: string | null
    smtp_response: string | null
  }

describe("Email Sending events", () => {
  it("marks a message delivered and records it on the contact's timeline", async () => {
    const { id, cfMessageId, contactId } = await sendOne("delivered@example.net")
    const result = await deliver(event("delivered", cfMessageId, "delivered@example.net"))
    expect(result.explicitAcks).toHaveLength(1)
    expect(await status(id)).toMatchObject({ status: "delivered", provider: "gmail" })
    const timeline = await env.DB.prepare("select name from events where contact_id = ? order by at")
      .bind(contactId)
      .all<{ name: string }>()
    expect(timeline.results.map((r) => r.name)).toContain("email.delivered")
  })

  it("suppresses a hard bounce and marks the contact bounced; the next send is refused locally", async () => {
    const { id, cfMessageId } = await sendOne("gone@example.net")
    await deliver(
      event("bounced", cfMessageId, "gone@example.net", {
        delivery: {
          status: "bounced",
          provider: "external_smtp",
          smtpStatusCode: "550",
          smtpResponse: "550 5.1.1 User unknown",
        },
        bounce: { type: "hard", classification: "permanent_failure", reason: "550 5.1.1 User unknown" },
      }),
    )
    expect(await status(id)).toMatchObject({
      status: "bounced",
      bounce_type: "hard",
      smtp_response: "550 5.1.1 User unknown",
    })
    expect(
      await env.DB.prepare("select reason, source from suppressions where email = ?")
        .bind("gone@example.net")
        .first(),
    ).toEqual({ reason: "hard_bounce", source: "events" })
    expect(
      await env.DB.prepare("select status from contacts where email = ?").bind("gone@example.net").first(),
    ).toEqual({ status: "bounced" })

    const again = await sendOne("gone@example.net")
    expect((await status(again.id)).status).toBe("rejected")
  })

  it("doesn't suppress a soft bounce", async () => {
    const { cfMessageId } = await sendOne("soft@example.net")
    await deliver(
      event("bounced", cfMessageId, "soft@example.net", {
        delivery: { status: "bounced", provider: "external_smtp", smtpStatusCode: "452" },
        bounce: { type: "soft", classification: "temporary_failure", reason: "452 4.2.2 Mailbox full" },
      }),
    )
    expect(
      await env.DB.prepare("select email from suppressions where email = ?").bind("soft@example.net").first(),
    ).toBeNull()
  })

  it("suppresses a complaint, which outranks an earlier delivery", async () => {
    const { id, cfMessageId } = await sendOne("annoyed@example.net")
    await deliver(event("delivered", cfMessageId, "annoyed@example.net"))
    await deliver(
      event("complained", cfMessageId, "annoyed@example.net", {
        delivery: { status: "complained" },
        complaint: { type: "abuse" },
      }),
    )
    expect((await status(id)).status).toBe("complained")
    expect(
      await env.DB.prepare("select reason from suppressions where email = ?")
        .bind("annoyed@example.net")
        .first(),
    ).toEqual({ reason: "complaint" })
  })

  it("never moves a delivered message back to deferred when events arrive out of order", async () => {
    const { id, cfMessageId } = await sendOne("order@example.net")
    await deliver(event("delivered", cfMessageId, "order@example.net"))
    await deliver(event("deferred", cfMessageId, "order@example.net"))
    expect((await status(id)).status).toBe("delivered")
  })

  it("applies a redelivered event once", async () => {
    const { cfMessageId } = await sendOne("twice@example.net")
    const same = event("delivered", cfMessageId, "twice@example.net", {}, "fixed-event-id")
    await deliver(same)
    await deliver(same)
    const day = await env.DB.prepare(
      "select sum(delivered) as delivered from daily_stats where day = '2026-10-16' and provider = 'gmail'",
    ).first<{ delivered: number }>()
    const count = await env.DB.prepare(
      "select count(*) as n from processed_events where event_id = 'fixed-event-id'",
    ).first<{
      n: number
    }>()
    expect(count?.n).toBe(1)
    expect(day?.delivered).toBeGreaterThanOrEqual(1)
  })

  it("counts events for mail sent outside Mailyard as the external stream", async () => {
    await deliver(event("delivered", "not-ours-123", "someone@example.net"))
    const row = await env.DB.prepare(
      "select delivered from daily_stats where day = '2026-10-16' and stream = 'external' and provider = 'gmail'",
    ).first<{ delivered: number }>()
    expect(row?.delivered).toBeGreaterThanOrEqual(1)
  })

  it("acks and drops a malformed event instead of retrying it forever", async () => {
    const result = await deliver({ type: "cf.email.sending.message.delivered", payload: {} })
    expect(result.explicitAcks).toHaveLength(1)
    expect(result.retryMessages).toHaveLength(0)
  })

  it("counts each successful send in the daily stats", async () => {
    const before = await env.DB.prepare(
      "select coalesce(sum(sent), 0) as sent from daily_stats where stream = 'transactional'",
    ).first<{ sent: number }>()
    await sendOne("counted@example.net")
    const after = await env.DB.prepare(
      "select coalesce(sum(sent), 0) as sent from daily_stats where stream = 'transactional'",
    ).first<{ sent: number }>()
    expect((after?.sent ?? 0) - (before?.sent ?? 0)).toBe(1)
  })
})

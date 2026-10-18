import { and, asc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { domains, messageEvents, messagesOut, testSends } from "../db/schema.ts"
import type { AuthResults } from "../inbound/auth.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { Dns, unquoteTxt } from "../services/Dns.ts"
import { parseParty, sendBulkMessage } from "./outbox.ts"

/**
 * First-run test sends (HAL-3378). By default the message goes to Mailyard's own probe address on a
 * receiving domain, `mailyard-test@`, and the inbound pipeline reads the receiving side's verdicts
 * (SPF, DKIM, DMARC) when it arrives, then drops it instead of filing it. Sent to an address the
 * person gives, it reports delivery only: that inbox's verdicts aren't visible from here.
 */
export const PROBE_LOCAL = "mailyard-test"
/** The header that carries the test's id, so the probe can match the arrival to its send. */
export const TEST_HEADER = "x-mailyard-test"

export class TestSendInvalid extends Schema.TaggedError<TestSendInvalid>()("TestSendInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
export class TestSendNotFound extends Schema.TaggedError<TestSendNotFound>()("TestSendNotFound", {
  id: Schema.String,
}) {}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export const startTestSend = Effect.fn("testSend.start")(function* (
  input: { readonly from: string; readonly to?: string | undefined },
  actor: string,
) {
  const from = parseParty(input.from)
  const bad = (field: string, message: string) => Effect.fail(new TestSendInvalid({ field, message }))
  if (!EMAIL.test(from.email)) return yield* bad("from", 'A sender is "Name <address>" or an address.')
  const fromDomain = from.email.slice(from.email.lastIndexOf("@") + 1).toLowerCase()
  const database = yield* Database
  const all = yield* database.query("testSend.domains", (db) =>
    db
      .select({
        name: domains.name,
        sendingEnabled: domains.sendingEnabled,
        routingEnabled: domains.routingEnabled,
      })
      .from(domains)
      .all(),
  )
  if (!all.find((d) => d.name === fromDomain)?.sendingEnabled)
    return yield* bad("from", `${fromDomain} isn't a sending domain in Mailyard.`)
  let to: string
  let probe: boolean
  if (input.to?.trim()) {
    to = input.to.trim().toLowerCase()
    if (!EMAIL.test(to)) return yield* bad("to", "Not an email address.")
    probe =
      to.split("@")[0] === PROBE_LOCAL && all.some((d) => d.routingEnabled && d.name === to.split("@")[1])
  } else {
    // The sender's own domain when it receives too, so the verdicts are about the domain itself.
    const receiving =
      all.find((d) => d.name === fromDomain && d.routingEnabled) ?? all.find((d) => d.routingEnabled)
    if (!receiving)
      return yield* bad(
        "to",
        "No receiving domain to measure on: turn on receiving for a domain, or give an address to send to.",
      )
    to = `${PROBE_LOCAL}@${receiving.name}`
    probe = true
  }
  const id = `tst_${yield* (yield* Ids).next}`
  const sentAt = Date.now()
  const result = yield* sendBulkMessage({
    stream: "test",
    message: {
      from: from.name ? { email: from.email, name: from.name } : { email: from.email },
      to: [{ email: to }],
      subject: `Mailyard test send (${id})`,
      text: `This is a test from Mailyard, sent from ${from.email} to check that mail from it arrives authenticated.\n\nTest ${id}`,
      html: `<p>This is a test from Mailyard, sent from <b>${from.email}</b> to check that mail from it arrives authenticated.</p><p style="color:#6b7280">Test ${id}</p>`,
      headers: { "X-Mailyard-Test": id },
    },
    contactId: null,
    campaignId: null,
    idempotencyKey: `test-send:${id}`,
  })
  yield* database.query("testSend.insert", (db) =>
    db
      .insert(testSends)
      .values({
        id,
        fromAddress: from.email,
        toAddress: to,
        probe,
        messageId: result.id,
        sentAt,
        createdBy: actor,
      })
      .run(),
  )
  return yield* getTestSend(id)
})

/** The sender's DMARC policy (`p=`), read from DNS: `none`, `quarantine`, `reject`, or null with no record. */
const dmarcPolicyOf = (domain: string) =>
  Effect.gen(function* () {
    const dns = yield* Dns
    const answer = yield* dns.resolve(`_dmarc.${domain}`, "TXT").pipe(Effect.option)
    if (Option.isNone(answer)) return null
    const record = answer.value.answers
      .map((a) => unquoteTxt(a.data))
      .find((t) => /^v=DMARC1/i.test(t.trim()))
    const p = record ? /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(record)?.[1] : undefined
    return p ? p.toLowerCase() : null
  })

/** The DKIM verdict that matters: a signature by the sender's domain (or a parent), else the first. */
const dkimFor = (auth: AuthResults, fromDomain: string) => {
  const aligned = auth.dkim.find(
    (d) => d.domain !== null && (fromDomain === d.domain || fromDomain.endsWith(`.${d.domain}`)),
  )
  const pick = aligned ?? auth.dkim[0]
  return { dkim: pick?.result ?? null, dkimDomain: pick?.domain ?? null }
}

/**
 * Called by the inbound pipeline for mail to the probe address: records the verdicts on the test it
 * belongs to. False when it's no test of ours, so the mail is handled like any other.
 */
export const recordProbeArrival = Effect.fn("testSend.arrival")(function* (input: {
  readonly envelopeTo: string
  readonly headers: ReadonlyArray<{ readonly key: string; readonly value: string }>
  readonly auth: AuthResults
  readonly receivedAt: number
}) {
  if (input.envelopeTo.trim().toLowerCase().split("@")[0] !== PROBE_LOCAL) return false
  const id = input.headers.find((h) => h.key.toLowerCase() === TEST_HEADER)?.value.trim()
  if (!id) return false
  const database = yield* Database
  const row = yield* database.query("testSend.find", (db) =>
    db.select().from(testSends).where(eq(testSends.id, id)).get(),
  )
  if (!row) return false
  if (row.receivedAt !== null) return true
  const fromDomain = row.fromAddress.slice(row.fromAddress.lastIndexOf("@") + 1)
  // The verdicts are the receiving side's; the policy is what DNS says the sender asks for.
  const dmarcPolicy = yield* dmarcPolicyOf(fromDomain)
  yield* database.query("testSend.arrived", (db) =>
    db
      .update(testSends)
      .set({
        receivedAt: input.receivedAt,
        auth: {
          spf: input.auth.spf,
          spfDomain: input.auth.spfDomain,
          ...dkimFor(input.auth, fromDomain),
          dmarc: input.auth.dmarc,
          dmarcPolicy,
        },
      })
      .where(eq(testSends.id, id))
      .run(),
  )
  return true
})

/**
 * A test send's progress: `sending` until Email Service takes it, then `sent`; for a probe,
 * `received` with the verdicts once it arrives; otherwise `delivered` or `bounced` from the delivery
 * events. `deliveryTimeMs` is from the send to the arrival (probe) or the delivered event.
 */
export const getTestSend = Effect.fn("testSend.get")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("testSend.get", (db) =>
    db.select().from(testSends).where(eq(testSends.id, id)).get(),
  )
  if (!row) return yield* new TestSendNotFound({ id })
  const message = row.messageId
    ? yield* database.query("testSend.message", (db) =>
        db
          .select({ status: messagesOut.status, error: messagesOut.error })
          .from(messagesOut)
          .where(eq(messagesOut.id, row.messageId as string))
          .get(),
      )
    : undefined
  const delivered = row.messageId
    ? yield* database.query("testSend.delivered", (db) =>
        db
          .select({ at: messageEvents.at })
          .from(messageEvents)
          .where(
            and(eq(messageEvents.messageId, row.messageId as string), eq(messageEvents.type, "delivered")),
          )
          .orderBy(asc(messageEvents.at))
          .get(),
      )
    : undefined
  const failed = message && ["failed", "rejected", "bounced"].includes(message.status)
  const status = row.receivedAt
    ? ("received" as const)
    : failed
      ? ("failed" as const)
      : message?.status === "delivered" || delivered
        ? ("delivered" as const)
        : message && message.status !== "queued"
          ? ("sent" as const)
          : ("sending" as const)
  const arrivedAt = row.receivedAt ?? delivered?.at ?? null
  return {
    id: row.id,
    from: row.fromAddress,
    to: row.toAddress,
    probe: row.probe,
    messageId: row.messageId,
    status,
    error: failed ? (message?.error ?? message?.status ?? null) : null,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
    deliveryTimeMs: arrivedAt === null ? null : Math.max(0, arrivedAt - row.sentAt),
    authentication: row.auth ?? null,
  }
})

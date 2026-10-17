import { and, eq, gte } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { autoReplies, type mailboxes } from "../db/schema.ts"
import { sendFromMailbox } from "../domain/outbox.ts"
import { emitSafely } from "../domain/webhooks.ts"
import type { ParsedMessage } from "../inbound/parse.ts"
import type { Outgoing } from "../kit/index.ts"
import { referencesFor, replySubject } from "../mail/compose.ts"
import { Database } from "../services/Database.ts"
import type { FilingPlan } from "./filing.ts"

/** RFC 3834 §2: at most one automatic reply per sender per period; a week is what mail clients use. */
export const AUTO_REPLY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000
/** Marks mail a mailbox forwarded, so a loop between two forwarding mailboxes stops at the first hop back. */
export const FORWARDED_HEADER = "X-Mailyard-Forwarded"
/** What a forward may carry inline before attachments are left out (Email Service's 5 MiB, less headroom). */
const FORWARD_ATTACHMENT_BUDGET = 3.5 * 1024 * 1024

/** Senders that are never people: bounces, daemons, no-reply addresses. */
const MACHINE_SENDER =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?|listserv|majordomo|owner-[^@]+|[^@]+-request)@/i

type MailboxRow = typeof mailboxes.$inferSelect

export interface EffectContext {
  readonly mailbox: MailboxRow
  /** The addresses that reach this mailbox: its own and its aliases'. */
  readonly ownAddresses: ReadonlyArray<string>
  readonly parsed: ParsedMessage
  readonly envelopeFrom: string
  readonly inboundId: string
  readonly threadId: string
}

const header = (parsed: ParsedMessage, key: string) =>
  parsed.headers.find((h) => h.key === key.toLowerCase())?.value

/**
 * Why an auto-reply must not go out, or null when it may. RFC 3834 §2: never answer automated mail,
 * mailing lists, bounces or machines; only answer mail addressed to the mailbox itself (not a Bcc or a
 * list copy); and never answer yourself.
 */
export const autoReplyBlocked = (
  ctx: Omit<EffectContext, "mailbox" | "inboundId" | "threadId">,
): string | null => {
  const { parsed } = ctx
  if (parsed.automated) return "the message is automated (Auto-Submitted or Precedence)"
  if (parsed.listId || parsed.listUnsubscribe || header(parsed, "list-post"))
    return "the message came from a mailing list"
  const sender = ctx.envelopeFrom.trim().replace(/^<|>$/g, "").toLowerCase()
  if (!sender) return "the message is a bounce (empty envelope sender)"
  if (MACHINE_SENDER.test(sender) || (parsed.from && MACHINE_SENDER.test(parsed.from.address)))
    return "the sender is a machine"
  const own = new Set(ctx.ownAddresses.map((a) => a.toLowerCase()))
  if (own.has(sender) || (parsed.from && own.has(parsed.from.address.toLowerCase())))
    return "the sender is this mailbox"
  const addressed = [...parsed.to, ...parsed.cc].some((p) => own.has(p.address.toLowerCase()))
  if (!addressed) return "the mailbox isn't in To or Cc"
  if (header(parsed, FORWARDED_HEADER)) return "the message was forwarded by a Mailyard mailbox"
  return null
}

const fromOf = (mailbox: MailboxRow) =>
  mailbox.displayName ? { email: mailbox.address, name: mailbox.displayName } : { email: mailbox.address }

const sendAutoReply = Effect.fn("rules.autoReply")(function* (
  ctx: EffectContext,
  reply: FilingPlan["effects"]["autoReplies"][number],
) {
  const blocked = autoReplyBlocked(ctx)
  if (blocked) return `skipped: ${blocked}`
  const to = ctx.envelopeFrom.trim().replace(/^<|>$/g, "").toLowerCase()
  const database = yield* Database
  const recent = yield* database.query("rules.autoReplyRecent", (db) =>
    db
      .select({ sentAt: autoReplies.sentAt })
      .from(autoReplies)
      .where(
        and(
          eq(autoReplies.mailboxId, ctx.mailbox.id),
          eq(autoReplies.address, to),
          eq(autoReplies.source, reply.source),
          gte(autoReplies.sentAt, Date.now() - AUTO_REPLY_PERIOD_MS),
        ),
      )
      .get(),
  )
  if (recent) return "skipped: already answered this sender this week"
  const references = referencesFor({
    messageId: ctx.parsed.messageId,
    references: ctx.parsed.references,
    inReplyTo: ctx.parsed.inReplyTo,
  })
  const headers: Record<string, string> = {
    // RFC 3834 §5: marks the reply automatic, so other responders don't answer it back.
    "Auto-Submitted": "auto-replied",
    "X-Auto-Response-Suppress": "All",
    ...(ctx.parsed.messageId ? { "In-Reply-To": ctx.parsed.messageId } : {}),
    ...(references.length ? { References: references.join(" ") } : {}),
  }
  const message: Outgoing = {
    from: fromOf(ctx.mailbox),
    to: [{ email: to }],
    subject: reply.subject || replySubject(ctx.parsed.subject, "reply"),
    text: reply.body,
    headers,
  }
  const sent = yield* sendFromMailbox({
    mailboxId: ctx.mailbox.id,
    sentCopyId: null,
    apiKeyId: null,
    message,
  })
  if (sent.status === "sent" || sent.status === "deferred") {
    yield* database.query("rules.autoReplyRecord", (db) =>
      db
        .insert(autoReplies)
        .values({ mailboxId: ctx.mailbox.id, address: to, source: reply.source, sentAt: Date.now() })
        .onConflictDoUpdate({
          target: [autoReplies.mailboxId, autoReplies.address, autoReplies.source],
          set: { sentAt: Date.now() },
        })
        .run(),
    )
  }
  return sent.status
})

const formatParty = (p: { name: string | null; address: string } | null) =>
  p ? (p.name ? `${p.name} <${p.address}>` : p.address) : "unknown"

/**
 * Forwards a received message from the mailbox's own address, so DMARC passes at the destination
 * (resending under the original From would fail it). Reply-To keeps the original sender, so replying
 * from the forward reaches them. Attachments ride along while they fit; past that they're listed.
 */
const sendForward = Effect.fn("rules.forward")(function* (
  ctx: EffectContext,
  forward: FilingPlan["effects"]["forwards"][number],
) {
  if (
    header(ctx.parsed, FORWARDED_HEADER)
      ?.split(/[,\s]+/)
      .includes(ctx.mailbox.id)
  )
    return "skipped: forwarding loop"
  const own = new Set(ctx.ownAddresses.map((a) => a.toLowerCase()))
  const [first, ...rest] = forward.to.map((a) => a.toLowerCase()).filter((a) => !own.has(a))
  if (!first) return "skipped: no destination outside this mailbox"
  const parsed = ctx.parsed
  const when = new Date(parsed.date ?? Date.now()).toUTCString()
  const preface = [
    "---------- Forwarded message ---------",
    `From: ${formatParty(parsed.from)}`,
    `Date: ${when}`,
    `Subject: ${parsed.subject}`,
    `To: ${parsed.to.map(formatParty).join(", ")}`,
    ...(parsed.cc.length ? [`Cc: ${parsed.cc.map(formatParty).join(", ")}`] : []),
    "",
  ].join("\n")
  const files = parsed.attachments.filter((a) => !a.related)
  const inline: typeof files = []
  const left: typeof files = []
  let used = 0
  for (const f of [...files].sort((a, b) => a.size - b.size)) {
    if (used + Math.ceil((f.size * 4) / 3) <= FORWARD_ATTACHMENT_BUDGET) {
      inline.push(f)
      used += Math.ceil((f.size * 4) / 3)
    } else left.push(f)
  }
  const omitted = left.length
    ? `\n\n(${left.length} attachment${left.length === 1 ? " was" : "s were"} too large to forward: ${left.map((f) => f.filename ?? "attachment").join(", ")}. Open the message in Mailyard.)`
    : ""
  const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const previous = header(parsed, FORWARDED_HEADER)
  const message: Outgoing = {
    from: fromOf(ctx.mailbox),
    to: [{ email: first }, ...rest.map((email) => ({ email }))],
    ...(parsed.from
      ? {
          replyTo: parsed.from.name
            ? { email: parsed.from.address, name: parsed.from.name }
            : { email: parsed.from.address },
        }
      : {}),
    subject: replySubject(parsed.subject, "forward"),
    text: `${preface}\n${parsed.text}${omitted}`,
    ...(parsed.html
      ? {
          html: `<pre style="font-family:inherit">${escapeHtml(preface)}</pre>${parsed.html}${omitted ? `<p>${escapeHtml(omitted.trim())}</p>` : ""}`,
        }
      : {}),
    headers: { [FORWARDED_HEADER]: previous ? `${previous}, ${ctx.mailbox.id}` : ctx.mailbox.id },
    ...(inline.length
      ? {
          attachments: inline.map((f) => ({
            filename: f.filename ?? "attachment",
            type: f.mimeType,
            content: f.content,
            disposition: "attachment" as const,
          })),
        }
      : {}),
  }
  const sent = yield* sendFromMailbox({
    mailboxId: ctx.mailbox.id,
    sentCopyId: null,
    apiKeyId: null,
    message,
  })
  return sent.status
})

/**
 * Carries out what the plan asked for, after the message is safely filed. Each effect is on its own:
 * one failing is logged and never undoes the filing or stops the others.
 */
export const runEffects = Effect.fn("rules.runEffects")(function* (plan: FilingPlan, ctx: EffectContext) {
  const results: Array<{ readonly effect: string; readonly result: string }> = []
  const attempt = <R>(effect: string, run: Effect.Effect<string, unknown, R>) =>
    run.pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`rules: ${effect} failed`, cause).pipe(Effect.as("failed")),
      ),
      Effect.tap((result) => Effect.sync(() => results.push({ effect, result }))),
    )
  for (const forward of plan.effects.forwards) {
    yield* attempt(`forward (${forward.source})`, sendForward(ctx, forward))
  }
  for (const reply of plan.effects.autoReplies) {
    yield* attempt(`auto-reply (${reply.source})`, sendAutoReply(ctx, reply))
  }
  for (const hook of plan.effects.webhooks) {
    yield* emitSafely(
      "mail.rule_matched",
      {
        id: ctx.inboundId,
        mailboxId: ctx.mailbox.id,
        ruleId: hook.ruleId,
        threadId: ctx.threadId,
        from: ctx.parsed.from,
        subject: ctx.parsed.subject,
        messageId: ctx.parsed.messageId,
      },
      hook.endpointId,
    )
    results.push({ effect: `webhook (${hook.ruleId})`, result: "queued" })
  }
  return results
})

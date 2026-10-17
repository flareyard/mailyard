import { and, asc, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { mailboxes, mailboxRules, mailboxSenders } from "../db/schema.ts"
import type { ParsedMessage } from "../inbound/parse.ts"
import type { FilingOptions } from "../mailbox/types.ts"
import { Classifier } from "../services/Classifier.ts"
import { Database } from "../services/Database.ts"
import { evaluate, type Rule, type RuleOutcome } from "./engine.ts"
import { authScore, CLASSIFY_BETWEEN, classifierPoints, SPAM_THRESHOLD, type SpamReason } from "./spam.ts"

/** Characters of body text the rules see; long enough for any sensible "body contains". */
export const RULE_BODY_LIMIT = 20_000

export interface FilingPlan {
  readonly filing: FilingOptions
  readonly spam: {
    readonly score: number
    readonly reasons: ReadonlyArray<SpamReason>
    readonly isSpam: boolean
  }
  readonly rulesMatched: ReadonlyArray<string>
  readonly effects: {
    readonly forwards: ReadonlyArray<{ readonly source: string; readonly to: ReadonlyArray<string> }>
    readonly autoReplies: ReadonlyArray<{
      readonly source: string
      readonly subject: string
      readonly body: string
    }>
    readonly webhooks: RuleOutcome["webhooks"]
  }
}

const senderKeys = (address: string | null | undefined) => {
  if (!address) return []
  const lower = address.toLowerCase()
  return [lower, `@${lower.slice(lower.lastIndexOf("@") + 1)}`]
}

/**
 * Decides how one mailbox files one message: its rules (in order), its allow and block lists, the
 * authentication score, and the classifier where the score alone is in doubt. A rule moving mail to
 * trash wins; then spam; then a rule's archive; then the inbox, or the archive when forwarding without
 * keeping a copy. Spam is never forwarded or auto-answered.
 */
export const planFiling = Effect.fn("rules.planFiling")(function* (input: {
  readonly mailboxId: string
  readonly parsed: ParsedMessage
  readonly tag: string | null
}) {
  const database = yield* Database
  const { parsed } = input
  const mailbox = yield* database.query("rules.mailbox", (db) =>
    db.select().from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).get(),
  )
  const rows = yield* database.query("rules.list", (db) =>
    db
      .select()
      .from(mailboxRules)
      .where(and(eq(mailboxRules.mailboxId, input.mailboxId), eq(mailboxRules.enabled, true)))
      .orderBy(asc(mailboxRules.position), asc(mailboxRules.createdAt))
      .all(),
  )
  const rules: Array<Rule> = rows.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    match: r.match,
    conditions: r.conditions,
    actions: r.actions,
    stop: r.stop,
  }))
  const outcome = evaluate(rules, {
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    listId: parsed.listId,
    tag: input.tag,
    body: parsed.text.slice(0, RULE_BODY_LIMIT),
    hasAttachment: parsed.attachments.some((a) => !a.related),
    automated: parsed.automated,
  })

  const keys = senderKeys(parsed.from?.address)
  const listed = keys.length
    ? yield* database.query("rules.senders", (db) =>
        db
          .select({ value: mailboxSenders.value, list: mailboxSenders.list })
          .from(mailboxSenders)
          .where(and(eq(mailboxSenders.mailboxId, input.mailboxId), inArray(mailboxSenders.value, keys)))
          .all(),
      )
    : []
  // An exact address outranks its domain, so one trusted sender at a blocked domain still gets through.
  const exact = listed.find((l) => l.value === keys[0])
  const listing = exact ?? listed.find((l) => l.value === keys[1])

  let reasons: Array<SpamReason> = []
  let score = 0
  if (listing?.list === "allow") reasons = [{ rule: `allowlisted (${listing.value})`, points: 0 }]
  else if (outcome.skipSpamCheck) reasons = [{ rule: "a rule skipped the spam check", points: 0 }]
  else {
    const fromDomain = parsed.from?.address.slice(parsed.from.address.lastIndexOf("@") + 1) ?? null
    const auth = authScore(parsed.auth, { fromDomain })
    reasons = [...auth.reasons]
    score = auth.score
    if (listing?.list === "block") {
      reasons.push({ rule: `blocklisted (${listing.value})`, points: SPAM_THRESHOLD })
      score += SPAM_THRESHOLD
    } else if (score >= CLASSIFY_BETWEEN.low && score < CLASSIFY_BETWEEN.high) {
      const verdict = yield* (yield* Classifier).classify({
        from: parsed.from ? `${parsed.from.name ?? ""} <${parsed.from.address}>`.trim() : "",
        subject: parsed.subject,
        text: parsed.text,
      })
      if (verdict.spamProbability !== null) {
        const points = classifierPoints(verdict.spamProbability)
        reasons.push({ rule: `${verdict.source} classifier p=${verdict.spamProbability.toFixed(2)}`, points })
        score += points
      }
    }
    score = Math.round(score * 10) / 10
  }
  // A blocked sender is spam however well it authenticates; an allowed one never is (unless a rule says so).
  const isSpam =
    listing?.list === "block" ||
    (listing?.list !== "allow" && !outcome.skipSpamCheck && score >= SPAM_THRESHOLD) ||
    outcome.folder === "spam"

  const forwarding = mailbox?.forwarding?.enabled ? mailbox.forwarding : null
  const folder =
    outcome.folder === "trash"
      ? "trash"
      : isSpam
        ? "spam"
        : (outcome.folder ?? (forwarding && !forwarding.keepCopy ? "archive" : "inbox"))

  const now = Date.now()
  const autoReply = mailbox?.autoReply
  const outOfOffice =
    autoReply?.enabled &&
    (autoReply.startsAt === null || autoReply.startsAt <= now) &&
    (autoReply.endsAt === null || autoReply.endsAt > now)
      ? [{ source: "mailbox", subject: autoReply.subject, body: autoReply.body }]
      : []

  return {
    filing: {
      folder,
      labelIds: outcome.labelIds,
      seen: outcome.markRead,
      starred: outcome.star,
      assignee: isSpam ? null : outcome.assignee,
    },
    spam: { score, reasons, isSpam },
    rulesMatched: outcome.matched,
    effects: isSpam
      ? { forwards: [], autoReplies: [], webhooks: outcome.webhooks }
      : {
          forwards: [
            ...(forwarding ? [{ source: "mailbox", to: forwarding.to }] : []),
            ...outcome.forwards.map((f) => ({ source: `rule:${f.ruleId}`, to: f.to })),
          ],
          autoReplies: [
            ...outOfOffice,
            ...outcome.autoReplies.map((a) => ({
              source: `rule:${a.ruleId}`,
              subject: a.subject,
              body: a.body,
            })),
          ],
          webhooks: outcome.webhooks,
        },
  } satisfies FilingPlan
})

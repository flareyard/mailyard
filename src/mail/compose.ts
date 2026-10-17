import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { BlobStore } from "../kit/index.ts"
import { subjectKey } from "../mailbox/threading.ts"
import type { DraftAttachment, DraftInput, Party, ReplyMode, StoredMessage } from "../mailbox/types.ts"
import { callMailbox } from "./rpc.ts"

export class ComposeInvalid extends Schema.TaggedError<ComposeInvalid>()("ComposeInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

/** RFC 5322 §3.6.4: keep the root and the most recent ancestors when References grows long. */
export const MAX_REFERENCES = 20

export const referencesFor = (source: Pick<StoredMessage, "messageId" | "references" | "inReplyTo">) => {
  const chain = [...source.references]
  if (chain.length === 0 && source.inReplyTo) chain.push(source.inReplyTo)
  if (source.messageId) chain.push(source.messageId)
  const unique = chain.filter((id, i) => chain.indexOf(id) === i)
  if (unique.length <= MAX_REFERENCES) return unique
  return [unique[0] as string, ...unique.slice(-(MAX_REFERENCES - 1))]
}

export const replySubject = (subject: string, mode: ReplyMode) => {
  const trimmed = subject.trim()
  if (mode === "forward") return /^\s*(fwd?|tr|wg)\s*:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`
  return subjectKey(trimmed).reply && /^\s*re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`
}

const sameParty = (a: Party, b: Party) => a.address.toLowerCase() === b.address.toLowerCase()
const uniqueParties = (parties: ReadonlyArray<Party>) =>
  parties.filter((p, i) => parties.findIndex((q) => sameParty(p, q)) === i)

/**
 * Who a reply goes to. Reply: the Reply-To, else the sender. Reply all: that, plus everyone else in To
 * and Cc. The mailbox's own addresses are never included, so a reply never goes to yourself.
 */
export const replyRecipients = (source: StoredMessage, mode: ReplyMode, own: ReadonlyArray<string>) => {
  const mine = new Set(own.map((a) => a.toLowerCase()))
  const notMine = (p: Party) => !mine.has(p.address.toLowerCase())
  if (mode === "forward") return { to: [] as Array<Party>, cc: [] as Array<Party> }
  const author = source.replyTo.length > 0 ? [...source.replyTo] : source.from ? [source.from] : []
  // Replying to your own sent message goes to its original recipients.
  const primary = author.filter(notMine).length > 0 ? author.filter(notMine) : source.to.filter(notMine)
  if (mode === "reply") return { to: uniqueParties(primary), cc: [] as Array<Party> }
  const to = uniqueParties([...primary, ...source.to.filter(notMine)])
  const cc = uniqueParties(source.cc.filter(notMine)).filter((p) => !to.some((q) => sameParty(p, q)))
  return { to, cc }
}

const formatParty = (p: Party | null) =>
  p ? (p.name ? `${p.name} <${p.address}>` : p.address) : "unknown sender"

/** The "On …, … wrote:" block with the original quoted, or the forwarded-message header for a forward. */
export const quoteBody = (source: StoredMessage, text: string, mode: ReplyMode) => {
  const when = new Date(source.date ?? source.receivedAt).toUTCString()
  if (mode === "forward") {
    return [
      "",
      "---------- Forwarded message ---------",
      `From: ${formatParty(source.from)}`,
      `Date: ${when}`,
      `Subject: ${source.subject}`,
      `To: ${source.to.map(formatParty).join(", ")}`,
      ...(source.cc.length ? [`Cc: ${source.cc.map(formatParty).join(", ")}`] : []),
      "",
      text,
    ].join("\n")
  }
  const quoted = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n")
  return ["", "", `On ${when}, ${formatParty(source.from)} wrote:`, quoted].join("\n")
}

/** The full text of a stored message, from its body object in R2; its snippet if that's gone. */
export const bodyTextOf = (message: StoredMessage) =>
  Effect.gen(function* () {
    const blob = yield* (yield* BlobStore)
      .get(message.bodyKey)
      .pipe(Effect.orElseSucceed(() => Option.none()))
    if (Option.isNone(blob)) return message.snippet
    try {
      const body = JSON.parse(new TextDecoder().decode(blob.value.body)) as { text?: string }
      return body.text ?? message.snippet
    } catch {
      return message.snippet
    }
  })

/**
 * Builds the draft for a reply, reply-all or forward of a message in this mailbox: recipients, subject,
 * threading headers, the quoted original, and for a forward its attachments.
 */
export const draftFromMessage = Effect.fn("mail.draftFromMessage")(function* (input: {
  readonly mailboxId: string
  readonly sourceMessageId: string
  readonly mode: ReplyMode
  readonly ownAddresses: ReadonlyArray<string>
  readonly from: string
  readonly bodyText?: string | undefined
}) {
  const source = yield* callMailbox(input.mailboxId, (stub) => stub.message(input.sourceMessageId))
  if (!source)
    return yield* new ComposeInvalid({
      field: "sourceMessageId",
      message: `No message ${input.sourceMessageId} in this mailbox.`,
    })
  const original = yield* bodyTextOf(source)
  const recipients = replyRecipients(source, input.mode, input.ownAddresses)
  const attachments: Array<DraftAttachment> =
    input.mode === "forward"
      ? source.attachments
          .filter((a) => !a.related)
          .map((a) => ({
            key: a.r2Key,
            filename: a.filename ?? "attachment",
            mimeType: a.mimeType,
            size: a.size,
          }))
      : []
  return {
    threadId: input.mode === "forward" ? null : source.threadId,
    replyMode: input.mode,
    sourceMessageId: source.id,
    inReplyTo: input.mode === "forward" ? null : source.messageId,
    references: input.mode === "forward" ? [] : referencesFor(source),
    from: input.from,
    to: recipients.to,
    cc: recipients.cc,
    subject: replySubject(source.subject, input.mode),
    bodyText: `${input.bodyText ?? ""}${quoteBody(source, original, input.mode)}`,
    attachments,
  } satisfies DraftInput
})

/** Upload keys are scoped to their mailbox; attachment keys must belong to a message it holds. */
export const checkDraftAttachments = Effect.fn("mail.checkDraftAttachments")(function* (
  mailboxId: string,
  attachments: ReadonlyArray<DraftAttachment> | undefined,
) {
  for (const a of attachments ?? []) {
    if (a.key.startsWith(`upl/${mailboxId}/`)) continue
    if (a.key.startsWith("att/") && (yield* callMailbox(mailboxId, (stub) => stub.hasAttachmentKey(a.key))))
      continue
    return yield* new ComposeInvalid({
      field: "attachments",
      message: `${a.filename} isn't an upload or attachment of this mailbox.`,
    })
  }
  return attachments
})

import { and, eq, inArray, isNull } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { alerts, domains, mailboxes, suppressions } from "../db/schema.ts"
import type { Caller } from "../domain/apiKeys.ts"
import { canSendAs } from "../domain/mailboxes.ts"
import { sendFromMailbox } from "../domain/outbox.ts"
import { htmlToText } from "../domain/render.ts"
import { NO_AUTH_RESULTS } from "../inbound/auth.ts"
import { sha256Hex, snippetOf } from "../inbound/parse.ts"
import { attachmentKeyOf, bodyKeyOf, rawKeyOf } from "../inbound/pipeline.ts"
import { BlobStore, type Outgoing } from "../kit/index.ts"
import type { Draft, InboundDelivery } from "../mailbox/types.ts"
import { CloudflareEmail } from "../services/CloudflareEmail.ts"
import { Database } from "../services/Database.ts"
import { planAttachments } from "./attachmentPlan.ts"
import { fileUrl, LARGE_ATTACHMENT_LINK_TTL_SECONDS, signFileToken } from "./files.ts"
import { buildMime } from "./mime.ts"
import { callMailbox } from "./rpc.ts"

export class SendInvalid extends Schema.TaggedError<SendInvalid>()("SendInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

export const BLOCK_REASONS = ["quota_exhausted", "domain_unhealthy", "all_recipients_suppressed"] as const
export type BlockReason = (typeof BLOCK_REASONS)[number]

/**
 * What really stops a mailbox send (HAL-3397), checked when it's asked for and again when it goes
 * out. Reputation never does: person-to-person mail isn't held by the governor (decision M5.4, so the
 * composer warns and keeps Send enabled).
 */
export class SendBlocked extends Schema.TaggedError<SendBlocked>()(
  "SendBlocked",
  {
    reason: Schema.Literals(BLOCK_REASONS),
    message: Schema.String,
    resetsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    domainId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  },
  { httpApiStatus: 409 },
) {}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase()

/** Null when the message can go; otherwise why it can't, as a SendBlocked to fail with. */
export const sendBlock = Effect.fn("mail.sendBlock")(function* (input: {
  readonly from: string
  readonly recipients: ReadonlyArray<string>
}) {
  const database = yield* Database
  const name = domainOf(input.from)
  const domain = yield* database.query("mail.blockDomain", (db) =>
    db.select().from(domains).where(eq(domains.name, name)).get(),
  )
  if (!domain || !domain.sendingEnabled)
    return new SendBlocked({
      reason: "domain_unhealthy",
      message: domain ? `Sending is off for ${name}.` : `${name} isn't a domain Mailyard sends from.`,
      domainId: domain?.id ?? null,
    })
  // Broken DNS counts once the domain had fully worked and then drifted (a critical dns_drift alert):
  // a domain still being set up, or one stored check gone stale, doesn't stop mail.
  const drift = yield* database.query("mail.blockDrift", (db) =>
    db
      .select({ title: alerts.title })
      .from(alerts)
      .where(
        and(
          eq(alerts.key, `dns_drift:${domain.id}`),
          isNull(alerts.resolvedAt),
          eq(alerts.severity, "critical"),
        ),
      )
      .get(),
  )
  if (drift)
    return new SendBlocked({
      reason: "domain_unhealthy",
      message: `${drift.title}. Fix the records, then send again.`,
      domainId: domain.id,
    })
  const limits = yield* (yield* CloudflareEmail).limits
  if (Option.isSome(limits) && limits.value.usage.over_quota) {
    const resetsAt = limits.value.usage.resets_at ? Date.parse(limits.value.usage.resets_at) : null
    return new SendBlocked({
      reason: "quota_exhausted",
      message: "Today's sending quota is used up; mail goes again when it resets.",
      resetsAt,
    })
  }
  const recipients = [...new Set(input.recipients.map((r) => r.trim().toLowerCase()))]
  if (recipients.length > 0) {
    const blocked = yield* database.query("mail.blockRecipients", (db) =>
      db
        .select({ email: suppressions.email })
        .from(suppressions)
        .where(and(inArray(suppressions.email, recipients.slice(0, 90)), eq(suppressions.bulkOnly, false)))
        .all(),
    )
    if (recipients.length <= 90 && blocked.length === recipients.length)
      return new SendBlocked({
        reason: "all_recipients_suppressed",
        message: `Every recipient is on the suppression list (${recipients.join(", ")}).`,
      })
  }
  return null
})

export { MAX_MESSAGE_BYTES } from "./attachmentPlan.ts"
export const MAX_RECIPIENTS = 50

export const MailboxSendJob = Schema.Struct({
  mailboxId: Schema.String,
  draftId: Schema.String,
  origin: Schema.NullOr(Schema.String),
})
export type MailboxSendJob = typeof MailboxSendJob.Type

export const undoWindowMs = (env: { readonly MAILYARD_UNDO_SECONDS?: string | undefined }) => {
  const seconds = Number(env.MAILYARD_UNDO_SECONDS ?? "10")
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 10) * 1000
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const textToHtml = (text: string) => `<div>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</div>`

/**
 * Sends a draft: after the undo window when `sendAt` is absent, or at `sendAt`. Either way it goes on
 * the mailbox's schedule, so undoing or cancelling is just taking it off, and nothing reaches Email
 * Service until the alarm hands it over. The sender address must be one the key may send as.
 */
export const sendDraft = Effect.fn("mail.sendDraft")(function* (input: {
  readonly caller: Caller
  readonly mailboxId: string
  readonly mailboxAddress: string
  readonly draftId: string
  readonly sendAt?: number | undefined
  /** Overrides the account's undo window for this send. */
  readonly undoSeconds?: number | undefined
  /** Track opens and clicks on this one message; never on unless asked (HAL-3335). */
  readonly track?: { readonly opens?: boolean | undefined; readonly clicks?: boolean | undefined } | undefined
  readonly origin: string | null
}) {
  const env = yield* Bindings
  const draft = yield* callMailbox(input.mailboxId, (stub) => stub.draft(input.draftId))
  if (!draft) return yield* new SendInvalid({ field: "draftId", message: `No draft ${input.draftId}.` })
  const recipients = draft.to.length + draft.cc.length + draft.bcc.length
  if (recipients === 0) return yield* new SendInvalid({ field: "to", message: "Add at least one recipient." })
  if (recipients > MAX_RECIPIENTS) {
    return yield* new SendInvalid({
      field: "to",
      message: `At most ${MAX_RECIPIENTS} recipients per message.`,
    })
  }
  const from = (draft.from ?? input.mailboxAddress).toLowerCase()
  if (!(yield* canSendAs(input.caller, from))) {
    return yield* new SendInvalid({ field: "from", message: `This key may not send as ${from}.` })
  }
  const blocked = yield* sendBlock({
    from,
    recipients: [...draft.to, ...draft.cc, ...draft.bcc].map((p) => p.address),
  })
  if (blocked) return yield* blocked
  const now = Date.now()
  const undoable = input.sendAt === undefined
  // An undo window of 0 means "at once": a quarter-second ahead, so the mailbox, which refuses a
  // time already past, still accepts it when the call takes a moment to arrive.
  const at =
    input.sendAt ??
    now + Math.max(250, input.undoSeconds !== undefined ? input.undoSeconds * 1000 : undoWindowMs(env))
  if (!undoable && at <= now)
    return yield* new SendInvalid({ field: "sendAt", message: "A scheduled send is in the future." })
  const result = yield* callMailbox(input.mailboxId, (stub) =>
    stub.scheduleDraft(
      input.draftId,
      at,
      { mailboxId: input.mailboxId, origin: input.origin },
      input.track ? { opens: input.track.opens === true, clicks: input.track.clicks === true } : null,
    ),
  )
  return { draft: result.draft, sendAt: at, undoUntil: undoable ? at : null }
})

/** Undoes a send inside its window, or cancels a scheduled one: the draft goes back to drafts. */
export const cancelSend = Effect.fn("mail.cancelSend")(function* (mailboxId: string, draftId: string) {
  const result = yield* callMailbox(mailboxId, (stub) => stub.unscheduleDraft(draftId))
  return result.draft
})

interface Prepared {
  readonly message: Outgoing
  readonly linked: ReadonlyArray<{ readonly filename: string; readonly url: string; readonly size: number }>
  readonly attached: ReadonlyArray<{
    readonly key: string
    readonly storedKey: string
    readonly filename: string
    readonly mimeType: string
    readonly size: number
    readonly sha256: string
  }>
}

/**
 * The message as sent. Attachments go inline while the whole message fits Email Service's limit; past
 * it, the largest become signed links (a week) listed at the end of the body.
 */
const prepare = Effect.fn("mail.prepare")(function* (
  draft: Draft,
  from: { email: string; name?: string },
  origin: string | null,
) {
  const store = yield* BlobStore
  const files = yield* Effect.forEach(draft.attachments, (a) =>
    store.get(a.key).pipe(
      Effect.flatMap((blob) =>
        Option.isNone(blob)
          ? Effect.fail(
              new SendInvalid({ field: "attachments", message: `${a.filename} is no longer stored.` }),
            )
          : Effect.promise(() => sha256Hex(blob.value.body)).pipe(
              // Sent attachments live content-addressed, like received ones; links point there.
              Effect.map((sha256) => ({
                ...a,
                bytes: blob.value.body,
                sha256,
                storedKey: a.key.startsWith("att/") ? a.key : attachmentKeyOf(sha256),
              })),
            ),
      ),
    ),
  )
  // Same plan as the draft shows the composer (src/mail/attachmentPlan.ts).
  const plan = planAttachments({
    bodyText: draft.bodyText,
    bodyHtml: draft.bodyHtml,
    attachments: files.map((f) => ({ key: f.key, size: f.bytes.byteLength })),
  })
  const inline = files.filter((f) => plan.get(f.key) === "inline")
  const links = files.filter((f) => plan.get(f.key) !== "inline")
  if (links.length > 0 && !origin) {
    return yield* new SendInvalid({
      field: "attachments",
      message: "Attachments too large to send need a link, and no public URL is known.",
    })
  }
  const linked = yield* Effect.forEach(links, (f) =>
    signFileToken(
      { k: f.storedKey, n: f.filename, t: f.mimeType, d: "attachment" },
      LARGE_ATTACHMENT_LINK_TTL_SECONDS,
    ).pipe(
      Effect.map((token) => ({
        filename: f.filename,
        url: fileUrl(origin as string, token),
        size: f.bytes.byteLength,
      })),
    ),
  )
  const expires = new Date(Date.now() + LARGE_ATTACHMENT_LINK_TTL_SECONDS * 1000).toUTCString()
  const linkText = linked.length
    ? `\n\nAttachments too large to send by email (links work until ${expires}):\n${linked.map((l) => `- ${l.filename}: ${l.url}`).join("\n")}`
    : ""
  const linkHtml = linked.length
    ? `<p>Attachments too large to send by email (links work until ${escapeHtml(expires)}):</p><ul>${linked
        .map((l) => `<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.filename)}</a></li>`)
        .join("")}</ul>`
    : ""
  const text = `${draft.bodyText}${linkText}`
  const html = `${draft.bodyHtml ?? textToHtml(draft.bodyText)}${linkHtml}`
  const party = (p: { address: string; name: string | null }) =>
    p.name ? { email: p.address, name: p.name } : { email: p.address }
  const headers: Record<string, string> = {}
  if (draft.inReplyTo) headers["In-Reply-To"] = draft.inReplyTo
  if (draft.references.length > 0) headers.References = draft.references.join(" ")
  // Mail with only Cc or Bcc recipients still needs a To: the first of them moves up.
  const all = { to: draft.to.map(party), cc: draft.cc.map(party), bcc: draft.bcc.map(party) }
  const envelope =
    all.to.length > 0
      ? all
      : all.cc.length > 0
        ? { to: all.cc.slice(0, 1), cc: all.cc.slice(1), bcc: all.bcc }
        : { to: all.bcc.slice(0, 1), cc: [], bcc: all.bcc.slice(1) }
  const [first, ...rest] = envelope.to
  if (!first) return yield* new SendInvalid({ field: "to", message: "Add at least one recipient." })
  const message: Outgoing = {
    from,
    to: [first, ...rest],
    ...(envelope.cc.length > 0 ? { cc: envelope.cc } : {}),
    ...(envelope.bcc.length > 0 ? { bcc: envelope.bcc } : {}),
    subject: draft.subject,
    text,
    html,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(inline.length
      ? {
          attachments: inline.map((f) => ({
            filename: f.filename,
            type: f.mimeType,
            content: f.bytes,
            disposition: "attachment" as const,
          })),
        }
      : {}),
  }
  // Copy uploads to their content-addressed home before anything is sent, so links already resolve.
  for (const f of files) if (f.storedKey !== f.key) yield* store.put(f.storedKey, f.bytes, f.mimeType)
  const attached = files.map((f) => ({
    key: f.key,
    storedKey: f.storedKey,
    filename: f.filename,
    mimeType: f.mimeType,
    size: f.bytes.byteLength,
    sha256: f.sha256,
  }))
  return { message, linked, attached } satisfies Prepared
})

/**
 * The mailbox-send queue's consumer: sends a draft the alarm marked due, files the sent copy into its
 * thread (a real `.eml` in R2, Email Service's Message-ID when it gave one), marks the original
 * answered, and deletes the draft. A send that fails for good puts the draft back with the reason.
 */
export const dispatchDraft = Effect.fn("mail.dispatchDraft")(function* (job: MailboxSendJob) {
  const draft = yield* callMailbox(job.mailboxId, (stub) => stub.draft(job.draftId))
  // Undone, edited or already sent since it was queued: nothing to do.
  if (draft?.status !== "due") return "skipped" as const
  const database = yield* Database
  const mailbox = yield* database.query("mail.dispatchMailbox", (db) =>
    db.select().from(mailboxes).where(eq(mailboxes.id, job.mailboxId)).get(),
  )
  if (!mailbox) {
    yield* callMailbox(job.mailboxId, (stub) => stub.failDraft(job.draftId, "The mailbox no longer exists."))
    return "failed" as const
  }
  const fromAddress = draft.from ?? mailbox.address
  // Checked again as it goes: the quota or the domain may have changed while it waited.
  const blocked = yield* sendBlock({
    from: fromAddress,
    recipients: [...draft.to, ...draft.cc, ...draft.bcc].map((p) => p.address),
  })
  if (blocked) {
    yield* callMailbox(job.mailboxId, (stub) => stub.failDraft(job.draftId, blocked.message, blocked.reason))
    return "failed" as const
  }
  const from =
    mailbox.displayName && fromAddress === mailbox.address
      ? { email: fromAddress, name: mailbox.displayName }
      : { email: fromAddress }
  const prepared = yield* prepare(draft, from, job.origin).pipe(Effect.result)
  if (prepared._tag === "Failure") {
    const failure = prepared.failure
    const reason = failure._tag === "SendInvalid" ? failure.message : `${failure._tag}`
    yield* callMailbox(job.mailboxId, (stub) => stub.failDraft(job.draftId, reason))
    return "failed" as const
  }
  const ids = crypto.randomUUID().replace(/-/g, "")
  const sentCopyId = `snt_${Date.now().toString(36)}${ids.slice(0, 16)}`
  const sent = yield* sendFromMailbox({
    mailboxId: job.mailboxId,
    sentCopyId,
    apiKeyId: null,
    message: prepared.success.message,
    track: draft.track ? { ...draft.track, origin: job.origin } : undefined,
  }).pipe(Effect.result)
  if (sent._tag === "Failure" || sent.success.status === "failed" || sent.success.status === "rejected") {
    const reason =
      sent._tag === "Failure"
        ? `${sent.failure._tag}${"reason" in sent.failure ? `: ${String(sent.failure.reason)}` : ""}`
        : (sent.success.error ?? sent.success.status)
    yield* callMailbox(job.mailboxId, (stub) => stub.failDraft(job.draftId, reason))
    return "failed" as const
  }
  const outcome = sent.success
  const message = outcome.message
  // The sender's own copy: Bcc kept, so the sent folder shows who was blind-copied.
  const raw = buildMime(message, { messageId: outcome.cfMessageId, bccInHeaders: true })
  const sha = yield* Effect.promise(() => sha256Hex(raw))
  const store = yield* BlobStore
  yield* store.put(rawKeyOf(sha), raw, "message/rfc822")
  const text = message.text ?? htmlToText(message.html ?? "")
  yield* store.put(
    bodyKeyOf(sha),
    new TextEncoder().encode(JSON.stringify({ text, html: message.html ?? null, headers: [] })),
    "application/json",
  )
  const party = (a: { email: string; name?: string }) => ({
    name: a.name ?? null,
    address: a.email.toLowerCase(),
  })
  const copy: InboundDelivery = {
    id: sentCopyId,
    receivedAt: Date.now(),
    envelopeFrom: message.from.email,
    envelopeTo: message.to[0]?.email ?? "",
    via: "mailbox",
    tag: null,
    rawKey: rawKeyOf(sha),
    bodyKey: bodyKeyOf(sha),
    size: raw.byteLength,
    messageId: outcome.cfMessageId,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    subject: message.subject,
    date: Date.now(),
    from: party(message.from),
    sender: null,
    replyTo: [],
    to: message.to.map(party),
    cc: (message.cc ?? []).map(party),
    snippet: snippetOf(text),
    bodyText: text,
    hasHtml: message.html !== undefined,
    auth: NO_AUTH_RESULTS,
    automated: false,
    listId: null,
    listUnsubscribe: null,
    attachments: prepared.success.attached.map((a, i) => ({
      id: `${sentCopyId}_${i}`,
      filename: a.filename,
      mimeType: a.mimeType,
      disposition: "attachment",
      contentId: null,
      related: false,
      size: a.size,
      sha256: a.sha256,
      r2Key: a.storedKey,
    })),
  }
  // Sent: the uploads' content-addressed copies are now the only ones needed.
  for (const a of prepared.success.attached) if (a.storedKey !== a.key) yield* store.delete(a.key)
  yield* callMailbox(job.mailboxId, (stub) => stub.deliver(copy, "sent"))
  if (draft.sourceMessageId && draft.replyMode && draft.replyMode !== "forward") {
    yield* callMailbox(job.mailboxId, (stub) =>
      stub.updateMessages([draft.sourceMessageId as string], { answered: true }),
    ).pipe(Effect.catchTag("MailboxRefused", () => Effect.void))
  }
  yield* callMailbox(job.mailboxId, (stub) => stub.deleteDraft(job.draftId))
  return outcome.status
})

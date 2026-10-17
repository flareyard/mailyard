import { inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { mailboxes } from "../db/schema.ts"
import type { TransferInvalid, TransferNotFound } from "../imports/manage.ts"
import { BlobStore } from "../kit/index.ts"
import { type Access, type MailboxAccessDenied, type MailboxMissing, requireMailbox } from "../mail/access.ts"
import { bodyTextOf, type ComposeInvalid, checkDraftAttachments, draftFromMessage } from "../mail/compose.ts"
import { ATTACHMENT_LINK_TTL_SECONDS, fileUrl, signFileToken } from "../mail/files.ts"
import { callMailbox, type MailboxRefused } from "../mail/rpc.ts"
import { cancelSend, type SendInvalid, sendDraft } from "../mail/send.ts"
import type { MessagePatch, Party, StoredMessage } from "../mailbox/types.ts"
import { putSender, type RuleInvalid, type RuleNotFound } from "../rules/manage.ts"
import { Database } from "../services/Database.ts"
import { Conflict, InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { CurrentCaller, Forbidden } from "./Auth.ts"
import { appContext, provideTo } from "./handlers.ts"

const tagOf = (e: unknown) => (typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : "")

type MailHttp<E> = E extends MailboxMissing | RuleNotFound | TransferNotFound
  ? NotFound
  : E extends MailboxAccessDenied
    ? Forbidden
    : E extends MailboxRefused
      ? NotFound | InvalidRequest | Conflict
      : E extends ComposeInvalid | SendInvalid | RuleInvalid | TransferInvalid
        ? InvalidRequest
        : E extends {
              readonly _tag: "DatabaseError" | "MailboxUnavailable" | "BlobStoreError" | "FileLinkInvalid"
            }
          ? never
          : E

/**
 * Maps mail errors to HTTP: a missing mailbox is 404, no access is 403, the mailbox's own refusals by
 * code (not_found 404, label_exists and draft_locked 409, the rest 400), bad compose or send input 400.
 * Storage and Durable Object failures are faults and surface as 500s.
 */
export const mailErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchIf(
      (e): e is E =>
        ["DatabaseError", "MailboxUnavailable", "BlobStoreError", "FileLinkInvalid"].includes(tagOf(e)),
      Effect.die,
    ),
    Effect.mapError((e) => {
      const err = e as { _tag: string; id?: string; message?: string; code?: string; field?: string }
      switch (err._tag) {
        case "MailboxMissing":
          return new NotFound({ message: `Mailbox ${err.id} not found.` })
        case "RuleNotFound":
          return new NotFound({ message: `Rule ${err.id} not found.` })
        case "TransferNotFound":
          return new NotFound({ message: `${err.id} not found.` })
        case "MailboxAccessDenied":
          return new Forbidden({ message: err.message ?? "Forbidden" })
        case "MailboxRefused":
          if (err.code === "not_found") return new NotFound({ message: err.message ?? "Not found." })
          if (err.code === "label_exists" || err.code === "draft_locked")
            return new Conflict({ message: err.message ?? "Conflict." })
          return new InvalidRequest({ field: "request", message: err.message ?? "Invalid request." })
        case "RuleInvalid":
        case "TransferInvalid":
        case "ComposeInvalid":
        case "SendInvalid":
          return new InvalidRequest({
            field: err.field ?? "request",
            message: err.message ?? "Invalid request.",
          })
        default:
          return e
      }
    }),
  ) as unknown as Effect.Effect<A, MailHttp<E>, R>

const access = (mailboxId: string, need: Access) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller
    const granted = yield* requireMailbox(caller, mailboxId, need)
    return { caller, ...granted }
  })

const party = (p: { readonly name?: string | null | undefined; readonly address: string }): Party => ({
  name: p.name?.trim() || null,
  address: p.address.trim().toLowerCase(),
})

/** The mailbox's own addresses (itself and the aliases that reach it), so replies never go to yourself. */
const ownAddresses = (mailboxId: string, address: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const aliases = yield* database.query("mail.ownAliases", (db) =>
      db
        .select({ address: mailboxes.address, targets: mailboxes.targets })
        .from(mailboxes)
        .where(inArray(mailboxes.kind, ["alias", "group"]))
        .all(),
    )
    return [address, ...aliases.filter((a) => a.targets?.includes(mailboxId)).map((a) => a.address)]
  })

export const originOf = (request: { readonly originalUrl: string }) => {
  try {
    return new URL(request.originalUrl).origin
  } catch {
    return null
  }
}

const toMessage = (m: StoredMessage) => ({
  id: m.id,
  threadId: m.threadId,
  folder: m.folder,
  seen: m.seen,
  starred: m.starred,
  answered: m.answered,
  labelIds: m.labelIds,
  receivedAt: m.receivedAt,
  envelopeFrom: m.envelopeFrom,
  envelopeTo: m.envelopeTo,
  via: m.via,
  tag: m.tag,
  size: m.size,
  messageId: m.messageId,
  inReplyTo: m.inReplyTo,
  references: m.references,
  subject: m.subject,
  date: m.date,
  from: m.from,
  replyTo: m.replyTo,
  to: m.to,
  cc: m.cc,
  snippet: m.snippet,
  hasHtml: m.hasHtml,
  automated: m.automated,
  listId: m.listId,
  listUnsubscribe: m.listUnsubscribe,
  auth: { source: m.auth.source, spf: m.auth.spf, dmarc: m.auth.dmarc, dkim: m.auth.dkim },
  attachments: m.attachments.map(({ r2Key: _, ...a }) => a),
  spamScore: m.spamScore,
  spamReasons: m.spamReasons,
  rulesMatched: m.rulesMatched,
})

const BULK: Record<
  string,
  (body: { labelId?: string | undefined; folder?: string | undefined }) => MessagePatch | null
> = {
  archive: () => ({ folder: "archive" }),
  inbox: () => ({ folder: "inbox" }),
  trash: () => ({ folder: "trash" }),
  spam: () => ({ folder: "spam" }),
  notSpam: () => ({ folder: "inbox" }),
  read: () => ({ seen: true }),
  unread: () => ({ seen: false }),
  star: () => ({ starred: true }),
  unstar: () => ({ starred: false }),
  label: (b) => (b.labelId ? { addLabels: [b.labelId] } : null),
  unlabel: (b) => (b.labelId ? { removeLabels: [b.labelId] } : null),
  move: (b) => (b.folder ? { folder: b.folder as MessagePatch["folder"] } : null),
}

export const MailHandlers = HttpApiBuilder.group(
  MailApi,
  "mail",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      folders: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          const folders = yield* callMailbox(params.id, (s) => s.folderCounts())
          const labels = yield* callMailbox(params.id, (s) => s.labels())
          return { folders, labels }
        }).pipe(mailErrors),
      ),
      emptyFolder: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          const result = yield* callMailbox(params.id, (s) => s.emptyFolder(params.folder))
          const store = yield* BlobStore
          // Raw copies and attachments are content-addressed and may be shared with other mailboxes, so
          // only this mailbox's own uploads are deleted here; the rest is left to a sweep.
          for (const key of result.blobKeys.filter((k) => k.startsWith(`upl/${params.id}/`)))
            yield* store.delete(key)
          return { purged: result.purged }
        }).pipe(mailErrors),
      ),
      threads: p(({ params, query }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return yield* callMailbox(params.id, (s) =>
            s.threads({
              ...(query.folder ? { folder: query.folder } : {}),
              ...(query.labelId ? { labelId: query.labelId } : {}),
              ...(query.unread === "true" ? { unread: true } : {}),
              ...(query.starred === "true" ? { starred: true } : {}),
              ...(query.assignee ? { assignee: query.assignee } : {}),
              ...(query.cursor ? { cursor: query.cursor } : {}),
              limit: query.limit ?? 50,
            }),
          )
        }).pipe(mailErrors),
      ),
      thread: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          const result = yield* callMailbox(params.id, (s) => s.thread(params.threadId))
          if (!result) return yield* new NotFound({ message: `Thread ${params.threadId} not found.` })
          return { thread: result.thread, messages: result.messages.map(toMessage), drafts: result.drafts }
        }).pipe(mailErrors),
      ),
      bulk: p(({ params, payload }) =>
        Effect.gen(function* () {
          const { caller } = yield* access(params.id, "write")
          const ids = payload.threadIds
          if (payload.action === "delete") {
            // Delete forever: only what is already in trash or spam, as a mail client's "Delete forever".
            let purged = 0
            for (const threadId of ids) {
              const thread = yield* callMailbox(params.id, (s) => s.thread(threadId))
              const doomed = (thread?.messages ?? [])
                .filter((m) => m.folder === "trash" || m.folder === "spam")
                .map((m) => m.id)
              if (doomed.length > 0) purged += (yield* callMailbox(params.id, (s) => s.purge(doomed))).purged
            }
            return { updated: purged }
          }
          if (payload.action === "snooze") {
            if (payload.until === undefined)
              return yield* new InvalidRequest({ field: "until", message: "Snoozing needs `until`." })
            for (const threadId of ids)
              yield* callMailbox(params.id, (s) => s.snooze(threadId, payload.until as number))
            return { updated: ids.length }
          }
          if (payload.action === "unsnooze") {
            for (const threadId of ids) yield* callMailbox(params.id, (s) => s.unsnooze(threadId))
            return { updated: ids.length }
          }
          if (payload.action === "assign") {
            const assignee = payload.assignee ?? null
            if (
              assignee !== null &&
              assignee !== caller.keyId &&
              caller.keyId !== "root" &&
              !caller.scopes.includes("admin")
            ) {
              // Anyone with write access may take a conversation or let it go; assigning others is for admins.
              return yield* new Forbidden({
                message: "Only admin keys may assign a conversation to someone else.",
              })
            }
            return yield* callMailbox(params.id, (s) => s.assign(ids, assignee))
          }
          const patch = BULK[payload.action]?.(payload)
          if (!patch) {
            return yield* new InvalidRequest({
              field: "action",
              message: `${payload.action} needs ${payload.action === "move" ? "folder" : "labelId"}.`,
            })
          }
          if (payload.action === "notSpam" || payload.action === "spam") {
            // "Not spam" trusts the senders from now on; "spam" blocks them. Your own sent copies don't count.
            const list = payload.action === "notSpam" ? "allow" : "block"
            for (const threadId of ids) {
              const thread = yield* callMailbox(params.id, (s) => s.thread(threadId))
              const senders = new Set(
                (thread?.messages ?? []).flatMap((m) =>
                  m.folder !== "sent" && m.from ? [m.from.address] : [],
                ),
              )
              for (const sender of senders) {
                yield* putSender(params.id, sender, list, payload.action === "notSpam" ? "not_spam" : "spam")
              }
            }
          }
          return yield* callMailbox(params.id, (s) => s.updateThreads(ids, patch))
        }).pipe(mailErrors),
      ),
      search: p(({ params, query }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return yield* callMailbox(params.id, (s) => s.search(query.q, { limit: query.limit ?? 25 }))
        }).pipe(mailErrors),
      ),
      message: p(({ params, request }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          const message = yield* callMailbox(params.id, (s) => s.message(params.messageId))
          if (!message) return yield* new NotFound({ message: `Message ${params.messageId} not found.` })
          const store = yield* BlobStore
          const bodyBlob = yield* store.get(message.bodyKey)
          let html: string | null = null
          if (bodyBlob._tag === "Some") {
            try {
              html =
                (JSON.parse(new TextDecoder().decode(bodyBlob.value.body)) as { html?: string | null })
                  .html ?? null
            } catch {
              html = null
            }
          }
          const text = yield* bodyTextOf(message)
          const origin = originOf(request) ?? ""
          const sign = (key: string, filename: string, type: string, disposition: "attachment" | "inline") =>
            signFileToken({ k: key, n: filename, t: type, d: disposition }, ATTACHMENT_LINK_TTL_SECONDS).pipe(
              Effect.map((token) => fileUrl(origin, token)),
            )
          const rawUrl = yield* sign(message.rawKey, `${message.id}.eml`, "message/rfc822", "attachment")
          const attachmentUrls: Record<string, string> = {}
          for (const a of message.attachments) {
            attachmentUrls[a.id] = yield* sign(
              a.r2Key,
              a.filename ?? "attachment",
              a.mimeType,
              a.related ? "inline" : "attachment",
            )
          }
          return { ...toMessage(message), body: { text, html }, rawUrl, attachmentUrls }
        }).pipe(mailErrors),
      ),
      updateMessage: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          const result = yield* callMailbox(params.id, (s) => s.updateMessages([params.messageId], payload))
          if (result.updated === 0)
            return yield* new NotFound({ message: `Message ${params.messageId} not found.` })
          const message = yield* callMailbox(params.id, (s) => s.message(params.messageId))
          return toMessage(message as StoredMessage)
        }).pipe(mailErrors),
      ),
      labels: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return { labels: yield* callMailbox(params.id, (s) => s.labels()) }
        }).pipe(mailErrors),
      ),
      createLabel: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          return (yield* callMailbox(params.id, (s) => s.createLabel(payload))).label
        }).pipe(mailErrors),
      ),
      updateLabel: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          return (yield* callMailbox(params.id, (s) => s.updateLabel(params.labelId, payload))).label
        }).pipe(mailErrors),
      ),
      deleteLabel: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          return { deleted: (yield* callMailbox(params.id, (s) => s.deleteLabel(params.labelId))).deleted }
        }).pipe(mailErrors),
      ),
      drafts: p(({ params, query }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return {
            drafts: yield* callMailbox(params.id, (s) =>
              s.drafts({ ...(query.status ? { status: query.status } : {}), limit: query.limit ?? 50 }),
            ),
          }
        }).pipe(mailErrors),
      ),
      createDraft: p(({ params, payload }) =>
        Effect.gen(function* () {
          const { mailbox } = yield* access(params.id, "write")
          const { replyTo, ...fields } = payload
          const base = replyTo
            ? yield* draftFromMessage({
                mailboxId: params.id,
                sourceMessageId: replyTo.messageId,
                mode: replyTo.mode,
                ownAddresses: yield* ownAddresses(params.id, mailbox.address),
                from: fields.from ?? mailbox.address,
                bodyText: fields.bodyText,
              })
            : { from: mailbox.address }
          const attachments = yield* checkDraftAttachments(
            params.id,
            fields.attachments ?? ("attachments" in base ? base.attachments : undefined),
          )
          const input = {
            ...base,
            ...(fields.threadId !== undefined ? { threadId: fields.threadId } : {}),
            ...(fields.from !== undefined ? { from: fields.from } : {}),
            ...(fields.to ? { to: fields.to.map(party) } : {}),
            ...(fields.cc ? { cc: fields.cc.map(party) } : {}),
            ...(fields.bcc ? { bcc: fields.bcc.map(party) } : {}),
            ...(fields.subject !== undefined ? { subject: fields.subject } : {}),
            ...(fields.bodyText !== undefined && !replyTo ? { bodyText: fields.bodyText } : {}),
            ...(fields.bodyHtml !== undefined ? { bodyHtml: fields.bodyHtml } : {}),
            ...(attachments ? { attachments } : {}),
          }
          return (yield* callMailbox(params.id, (s) => s.saveDraft(input))).draft
        }).pipe(mailErrors),
      ),
      draft: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          const draft = yield* callMailbox(params.id, (s) => s.draft(params.draftId))
          if (!draft) return yield* new NotFound({ message: `Draft ${params.draftId} not found.` })
          return draft
        }).pipe(mailErrors),
      ),
      updateDraft: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          const attachments = yield* checkDraftAttachments(params.id, payload.attachments)
          const input = {
            id: params.draftId,
            ...(payload.from !== undefined ? { from: payload.from } : {}),
            ...(payload.to ? { to: payload.to.map(party) } : {}),
            ...(payload.cc ? { cc: payload.cc.map(party) } : {}),
            ...(payload.bcc ? { bcc: payload.bcc.map(party) } : {}),
            ...(payload.subject !== undefined ? { subject: payload.subject } : {}),
            ...(payload.bodyText !== undefined ? { bodyText: payload.bodyText } : {}),
            ...(payload.bodyHtml !== undefined ? { bodyHtml: payload.bodyHtml } : {}),
            ...(attachments ? { attachments } : {}),
          }
          return (yield* callMailbox(params.id, (s) => s.saveDraft(input))).draft
        }).pipe(mailErrors),
      ),
      deleteDraft: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          const result = yield* callMailbox(params.id, (s) => s.deleteDraft(params.draftId))
          const store = yield* BlobStore
          for (const key of result.blobKeys.filter((k) => k.startsWith(`upl/${params.id}/`)))
            yield* store.delete(key)
          return { deleted: params.draftId }
        }).pipe(mailErrors),
      ),
      send: p(({ params, payload, request }) =>
        Effect.gen(function* () {
          const { caller, mailbox } = yield* access(params.id, "send")
          return yield* sendDraft({
            caller,
            mailboxId: params.id,
            mailboxAddress: mailbox.address,
            draftId: params.draftId,
            sendAt: payload.sendAt,
            origin: originOf(request),
          })
        }).pipe(mailErrors),
      ),
      cancelSend: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "send")
          return yield* cancelSend(params.id, params.draftId)
        }).pipe(mailErrors),
      ),
    })
  }),
)

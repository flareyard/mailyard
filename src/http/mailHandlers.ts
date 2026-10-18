import { and, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import { apiKeys, mailboxes, messagesOut } from "../db/schema.ts"
import type { AgentLimited } from "../domain/agents.ts"
import type { Caller } from "../domain/apiKeys.ts"
import { recipientsOf } from "../domain/deliveryEvents.ts"
import { publishMailEvent } from "../domain/mailEvents.ts"
import { isManager } from "../domain/permissions.ts"
import type { TransferInvalid, TransferNotFound } from "../imports/manage.ts"
import { BlobStore } from "../kit/index.ts"
import { type Access, type MailboxAccessDenied, type MailboxMissing, requireMailbox } from "../mail/access.ts"
import { bodyTextOf, type ComposeInvalid, checkDraftAttachments, draftFromMessage } from "../mail/compose.ts"
import { ATTACHMENT_LINK_TTL_SECONDS, fileUrl, signFileToken } from "../mail/files.ts"
import { addImageSender, listImageSenders, removeImageSender, showsImagesFrom } from "../mail/imageSenders.ts"
import { buildReply, parseInvite, RESPONSE_WORDS } from "../mail/invite.ts"
import { callMailbox, type MailboxRefused } from "../mail/rpc.ts"
import { cancelSend, type SendInvalid, sendDraft } from "../mail/send.ts"
import type { MessagePatch, Party, StoredMessage } from "../mailbox/types.ts"
import { linkOrigin } from "../public/origin.ts"
import { notifyAssigned } from "../push/notifications.ts"
import { putSender, type RuleInvalid, type RuleNotFound } from "../rules/manage.ts"
import { Database } from "../services/Database.ts"
import {
  type BULK_ACTIONS,
  Conflict,
  type CreateDraftPayload,
  InvalidRequest,
  MailApi,
  NotFound,
} from "./Api.ts"
import { CurrentCaller, Forbidden } from "./Auth.ts"
import { agentConflict, appContext, idempotent, notWhileDeleting, provideTo } from "./handlers.ts"

const tagOf = (e: unknown) => (typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : "")

type MailHttp<E> = E extends MailboxMissing | RuleNotFound | TransferNotFound
  ? NotFound
  : E extends AgentLimited
    ? Conflict
    : E extends MailboxAccessDenied
      ? Forbidden
      : E extends MailboxRefused
        ? NotFound | InvalidRequest | Conflict | Forbidden
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
        case "MailboxAccessDenied": {
          const denied = e as unknown as MailboxAccessDenied
          return new Forbidden({
            message: denied.message,
            ...(denied.reason ? { reason: denied.reason } : {}),
            ...(denied.role ? { role: denied.role } : {}),
            ...(denied.owners ? { owners: [...denied.owners] } : {}),
          })
        }
        case "AgentLimited": {
          const limited = e as unknown as AgentLimited
          return agentConflict(limited)
        }
        case "MailboxRefused":
          if (err.code === "not_found") return new NotFound({ message: err.message ?? "Not found." })
          if (err.code === "label_exists" || err.code === "draft_locked")
            return new Conflict({ message: err.message ?? "Conflict." })
          if (err.code === "forbidden") return new Forbidden({ message: err.message ?? "Forbidden" })
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
/**
 * The invitation in a message's text/calendar part, with what this mailbox may do about it. A
 * malformed part reads as no invitation.
 */
const inviteOf = (message: StoredMessage, own: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const part = message.attachments.find(
      (a) => /^text\/calendar/i.test(a.mimeType) || /\.ics$/i.test(a.filename ?? ""),
    )
    if (!part || part.size > 512 * 1024) return null
    const blob = yield* (yield* BlobStore).get(part.r2Key).pipe(Effect.orElseSucceed(() => Option.none()))
    if (Option.isNone(blob)) return null
    const invite = parseInvite(new TextDecoder().decode(blob.value.body))
    if (!invite) return null
    const mine = invite.attendees.find((a) => own.includes(a.address))
    return {
      ...invite,
      myStatus: mine?.partstat ?? null,
      canRespond: invite.method === "REQUEST" && mine !== undefined && invite.organizer !== null,
      raw: invite,
    }
  })

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

/** The origin links in a response or a send are built on: the public origin when set (HAL-3483). */
export const originOf = (request: { readonly originalUrl: string }) => linkOrigin(request.originalUrl)

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
  auth: {
    source: m.auth.source,
    spf: m.auth.spf,
    dmarc: m.auth.dmarc,
    dkim: m.auth.dkim,
    // The ARC chain when it was recorded (HAL-3407); before that, the bare verdict.
    arc: m.auth.arcChain ?? (m.auth.arc ? { result: m.auth.arc, instance: null, sealer: null } : null),
  },
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

/** What a bulk thread action takes: the REST body of `POST …/threads/bulk`, and the MCP inbox tools. */
export type ThreadAction = {
  readonly threadIds: ReadonlyArray<string>
  readonly action: (typeof BULK_ACTIONS)[number]
  readonly labelId?: string | undefined
  readonly folder?: string | undefined
  readonly until?: number | undefined
  readonly assignee?: string | null | undefined
}

/**
 * Applies a bulk action to threads in a mailbox the caller may write: one path for the API and the
 * MCP inbox tools (HAL-3459), so rules, sender lists, audit and the live socket behave the same.
 */
export const applyThreadAction = (mailboxId: string, caller: Caller, payload: ThreadAction) =>
  Effect.gen(function* () {
    const params = { id: mailboxId }
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
      if (assignee !== null && assignee !== caller.keyId && caller.keyId !== "root" && !isManager(caller)) {
        // Anyone with write access may take a conversation or let it go; assigning others is for admins.
        return yield* new Forbidden({
          message: "Only admin keys may assign a conversation to someone else.",
        })
      }
      const result = yield* callMailbox(params.id, (s) => s.assign(ids, assignee))
      // The mail-events lane hears each handover (HAL-3306).
      for (const threadId of result.threadIds)
        yield* publishMailEvent({
          type: "thread.assigned",
          mailboxId: params.id,
          threadId,
          assignee,
          by: caller.member?.id ?? caller.keyId,
        })
      // The person it's handed to hears about it on their devices (HAL-3369).
      if (assignee !== null)
        for (const threadId of result.threadIds) {
          const thread = yield* callMailbox(params.id, (s) => s.thread(threadId)).pipe(
            Effect.orElseSucceed(() => null),
          )
          yield* notifyAssigned({
            mailboxId: params.id,
            threadId,
            assignee,
            by: caller.keyId,
            subject: thread?.thread.subject ?? "",
          })
        }
      return { updated: result.updated }
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
          (thread?.messages ?? []).flatMap((m) => (m.folder !== "sent" && m.from ? [m.from.address] : [])),
        )
        for (const sender of senders) {
          yield* putSender(params.id, sender, list, payload.action === "notSpam" ? "not_spam" : "spam")
        }
      }
    }
    return yield* callMailbox(params.id, (s) => s.updateThreads(ids, patch))
  })

/** Builds and saves a new draft: blank, or a reply or forward of a message in the mailbox. */
export const createDraftNow = (
  mailboxId: string,
  mailbox: { readonly address: string },
  payload: CreateDraftPayload,
) =>
  Effect.gen(function* () {
    const params = { id: mailboxId }
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
  })

/** Names the key that wrote each note: the key's name until people exist (HAL-3361). */
const withAuthors = (
  notes: ReadonlyArray<{
    readonly id: string
    readonly author: string
    readonly body: string
    readonly createdAt: number
  }>,
) =>
  Effect.gen(function* () {
    const ids = [...new Set(notes.map((n) => n.author).filter((a) => a !== "root"))]
    const names = new Map<string, string>([["root", "Admin key"]])
    if (ids.length > 0) {
      const database = yield* Database
      const rows = yield* database.query("mail.noteAuthors", (db) =>
        db
          .select({ id: apiKeys.id, name: apiKeys.name })
          .from(apiKeys)
          .where(inArray(apiKeys.id, ids.slice(0, 90)))
          .all(),
      )
      for (const r of rows) names.set(r.id, r.name)
    }
    return notes.map((n) => ({
      id: n.id,
      body: n.body,
      author: { id: n.author, name: names.get(n.author) ?? n.author },
      createdAt: n.createdAt,
    }))
  })

/** Adds who's handling each conversation, with a name: the key's, until people exist (HAL-3361). */
const withAssignees = <T extends { readonly assignee: string | null }>(threads: ReadonlyArray<T>) =>
  Effect.gen(function* () {
    const ids = [
      ...new Set(threads.map((t) => t.assignee).filter((a): a is string => a !== null && a !== "root")),
    ]
    const names = new Map<string, string>([["root", "Admin key"]])
    if (ids.length > 0) {
      const database = yield* Database
      const rows = yield* database.query("mail.assigneeNames", (db) =>
        db
          .select({ id: apiKeys.id, name: apiKeys.name })
          .from(apiKeys)
          .where(inArray(apiKeys.id, ids.slice(0, 90)))
          .all(),
      )
      for (const r of rows) names.set(r.id, r.name)
    }
    return threads.map((t) => ({
      ...t,
      assignedTo: t.assignee ? { id: t.assignee, name: names.get(t.assignee) ?? t.assignee } : null,
    }))
  })

export const MailHandlers = HttpApiBuilder.group(
  MailApi,
  "mail",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      folders: p(({ params }) =>
        Effect.gen(function* () {
          const { caller } = yield* access(params.id, "read")
          const folders = yield* callMailbox(params.id, (s) => s.folderCounts())
          const labels = yield* callMailbox(params.id, (s) => s.labels())
          const views = yield* callMailbox(params.id, (s) => s.views(caller.keyId))
          const smartFolders = yield* callMailbox(params.id, (s) => s.smartFolders())
          return { folders, labels, smartFolders, views }
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
          const list = yield* callMailbox(params.id, (s) =>
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
          return { ...list, threads: yield* withAssignees(list.threads) }
        }).pipe(mailErrors),
      ),
      thread: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          const result = yield* callMailbox(params.id, (s) => s.thread(params.threadId))
          if (!result) return yield* new NotFound({ message: `Thread ${params.threadId} not found.` })
          const [thread] = yield* withAssignees([result.thread])
          return {
            thread: thread ?? result.thread,
            messages: result.messages.map(toMessage),
            drafts: result.drafts,
            notes: yield* withAuthors(result.notes),
          }
        }).pipe(mailErrors),
      ),
      bulk: p(({ params, payload }) =>
        Effect.gen(function* () {
          const { caller } = yield* access(params.id, "write")
          return yield* applyThreadAction(params.id, caller, payload)
        }).pipe(mailErrors),
      ),
      search: p(({ params, query }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return yield* callMailbox(params.id, (s) =>
            s.search(query.q, { limit: query.limit ?? 25, sort: query.sort ?? "recent" }),
          )
        }).pipe(mailErrors),
      ),
      addNote: p(({ params, payload }) =>
        Effect.gen(function* () {
          const { caller } = yield* access(params.id, "write")
          const result = yield* callMailbox(params.id, (s) =>
            s.addNote(params.threadId, caller.keyId, payload.body),
          )
          const [note] = yield* withAuthors(result.note ? [result.note] : [])
          if (!note) return yield* new NotFound({ message: "The note vanished." })
          return note
        }).pipe(mailErrors),
      ),
      deleteNote: p(({ params }) =>
        Effect.gen(function* () {
          const { caller, role } = yield* access(params.id, "write")
          return yield* callMailbox(params.id, (s) =>
            s.deleteNote(params.noteId, caller.keyId, role === "admin" || role === "owner"),
          )
        }).pipe(mailErrors),
      ),
      smartFolders: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return { smartFolders: yield* callMailbox(params.id, (s) => s.smartFolders()) }
        }).pipe(mailErrors),
      ),
      createSmartFolder: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          const saved = yield* callMailbox(params.id, (s) => s.saveSmartFolder(payload))
          if (!saved) return yield* new NotFound({ message: "The smart folder vanished." })
          return saved
        }).pipe(mailErrors),
      ),
      updateSmartFolder: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          const saved = yield* callMailbox(params.id, (s) =>
            s.saveSmartFolder({ ...payload, id: params.folderId }),
          )
          if (!saved) return yield* new NotFound({ message: `Smart folder ${params.folderId} not found.` })
          return saved
        }).pipe(mailErrors),
      ),
      deleteSmartFolder: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          return yield* callMailbox(params.id, (s) => s.deleteSmartFolder(params.folderId))
        }).pipe(mailErrors),
      ),
      message: p(({ params, request, query }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          const message = yield* callMailbox(params.id, (s) => s.message(params.messageId))
          if (!message) return yield* new NotFound({ message: `Message ${params.messageId} not found.` })
          const store = yield* BlobStore
          const bodyBlob = yield* store.get(message.bodyKey)
          let html: string | null = null
          let headers: Array<{ name: string; value: string }> | null = null
          if (bodyBlob._tag === "Some") {
            try {
              const stored = JSON.parse(new TextDecoder().decode(bodyBlob.value.body)) as {
                html?: string | null
                headers?: ReadonlyArray<{ key: string; value: string }>
              }
              html = stored.html ?? null
              // In the order they arrived (newest hop first), as the parser kept them.
              if (query.include === "headers")
                headers = (stored.headers ?? []).map((h) => ({ name: h.key, value: h.value }))
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
          const database = yield* Database
          const sent = yield* database.query("mail.sentDelivery", (db) =>
            db
              .select()
              .from(messagesOut)
              .where(and(eq(messagesOut.mailboxId, params.id), eq(messagesOut.mailboxMessageId, message.id)))
              .get(),
          )
          const delivery = sent
            ? {
                messageId: sent.id,
                status: sent.status,
                tracked: sent.tracked,
                opens: sent.opens,
                clicks: sent.clicks,
                machineOpens: sent.machineOpens,
                machineClicks: sent.machineClicks,
                firstOpenedAt: sent.firstOpenedAt,
                firstClickedAt: sent.firstClickedAt,
                recipients: yield* recipientsOf(sent.id),
              }
            : null
          const own = yield* ownAddresses(params.id, (yield* access(params.id, "read")).mailbox.address)
          return {
            ...toMessage(message),
            body: { text, html },
            rawUrl,
            attachmentUrls,
            delivery,
            invite: yield* inviteOf(message, own).pipe(
              Effect.map((invite) => {
                if (!invite) return null
                const { raw: _raw, ...shown } = invite
                return shown
              }),
            ),
            remoteImages: (yield* showsImagesFrom(params.id, message.from?.address ?? null))
              ? ("show" as const)
              : ("ask" as const),
            ...(query.include === "headers" ? { headers: headers ?? [] } : {}),
          }
        }).pipe(mailErrors),
      ),
      rsvp: p(({ params, payload, request }) =>
        Effect.gen(function* () {
          const { caller, mailbox } = yield* access(params.id, "send")
          yield* notWhileDeleting
          const message = yield* callMailbox(params.id, (s) => s.message(params.messageId))
          if (!message) return yield* new NotFound({ message: `Message ${params.messageId} not found.` })
          const own = yield* ownAddresses(params.id, mailbox.address)
          const invite = yield* inviteOf(message, own)
          if (!invite?.canRespond || !invite.organizer)
            return yield* new InvalidRequest({
              field: "messageId",
              message: invite
                ? "This invitation doesn't list this mailbox as an attendee, or isn't a request to answer."
                : "This message has no calendar invitation.",
            })
          const me = invite.attendees.find((a) => own.includes(a.address)) ?? {
            address: mailbox.address,
            name: null,
          }
          const ics = buildReply({ invite: invite.raw, attendee: me, response: payload.response })
          const bytes = new TextEncoder().encode(ics)
          const key = `upl/${params.id}/rsvp-${crypto.randomUUID()}.ics`
          yield* (yield* BlobStore).put(key, bytes, "text/calendar; method=REPLY; charset=utf-8")
          const word = RESPONSE_WORDS[payload.response]
          const title = invite.summary ?? "the invitation"
          const draft = yield* createDraftNow(params.id, mailbox, {
            replyTo: { messageId: params.messageId, mode: "reply" },
            to: [
              {
                address: invite.organizer.address,
                ...(invite.organizer.name ? { name: invite.organizer.name } : {}),
              },
            ],
            subject: `${word}: ${title}`,
            bodyText: `${me.name ?? me.address} has ${payload.response === "tentative" ? "tentatively accepted" : payload.response} ${title}.${
              payload.comment ? `\n\n${payload.comment}` : ""
            }`,
            attachments: [
              {
                key,
                filename: "invite.ics",
                mimeType: "text/calendar; method=REPLY",
                size: bytes.byteLength,
              },
            ],
          })
          const sent = yield* sendDraft({
            caller,
            mailboxId: params.id,
            mailboxAddress: mailbox.address,
            draftId: draft.id,
            origin: originOf(request),
          })
          return { response: payload.response, ...sent }
        }).pipe(mailErrors),
      ),
      imageSenders: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return { senders: yield* listImageSenders(params.id) }
        }).pipe(mailErrors),
      ),
      addImageSender: p(({ params, payload }) =>
        Effect.gen(function* () {
          const { caller } = yield* access(params.id, "write")
          return yield* addImageSender(params.id, payload.value, caller.member?.id ?? caller.keyId).pipe(
            Effect.catchTag("ImageSenderInvalid", (e) =>
              Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            ),
          )
        }).pipe(mailErrors),
      ),
      removeImageSender: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          return yield* removeImageSender(params.id, decodeURIComponent(params.value))
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
      correspondents: p(({ params, query }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return {
            correspondents: yield* callMailbox(params.id, (s) =>
              s.correspondents(query.q ?? "", query.limit ?? 10),
            ),
          }
        }).pipe(mailErrors),
      ),
      createDraft: p(({ params, payload, headers }) =>
        Effect.gen(function* () {
          const { caller, mailbox } = yield* access(params.id, "write")
          // An offline composer retries with the same key: it gets the same draft, not a second one.
          return yield* idempotent(
            caller,
            `draft:${params.id}`,
            headers["idempotency-key"],
            payload,
            createDraftNow(params.id, mailbox, payload),
          )
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
      send: p(({ params, payload, request, headers }) =>
        Effect.gen(function* () {
          const { caller, mailbox } = yield* access(params.id, "send")
          yield* notWhileDeleting
          return yield* idempotent(
            caller,
            `send:${params.id}:${params.draftId}`,
            headers["idempotency-key"],
            payload,
            sendDraft({
              caller,
              mailboxId: params.id,
              mailboxAddress: mailbox.address,
              draftId: params.draftId,
              sendAt: payload.sendAt,
              undoSeconds: payload.undoSeconds,
              track: payload.track,
              origin: originOf(request),
            }),
          )
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

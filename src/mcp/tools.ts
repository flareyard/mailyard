import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { campaignReport } from "../campaigns/report.ts"
import { contacts } from "../db/schema.ts"
import { checkSend, holdSend } from "../domain/agents.ts"
import type { Caller, Scope } from "../domain/apiKeys.ts"
import { getContact, normalizeEmail } from "../domain/contacts.ts"
import { track } from "../domain/events.ts"
import { sendTransactional } from "../domain/outbox.ts"
import { readableMailboxes } from "../domain/overview.ts"
import { previewSegment } from "../domain/segments.ts"
import { searchMail } from "../domain/workspaceSearch.ts"
import { applyThreadAction, createDraftNow, type ThreadAction } from "../http/mailHandlers.ts"
import { BlobStore, Ids } from "../kit/index.ts"
import { requireMailbox } from "../mail/access.ts"
import { bodyTextOf } from "../mail/compose.ts"
import { fileUrl, signFileToken } from "../mail/files.ts"
import { callMailbox } from "../mail/rpc.ts"
import { sendDraft } from "../mail/send.ts"
import { Rule } from "../segments/rules.ts"
import { Database } from "../services/Database.ts"
import { CONVERTIBLE, DocumentText } from "../services/DocumentText.ts"

/**
 * The MCP server's tools (HAL-3303). Each is a thin call into the same domain functions the REST
 * API uses, with the same checks: the key's scopes, and for mail its mailbox memberships. Nothing
 * here decides anything the API doesn't. Sending tools say so in their annotations and refuse to
 * run without `confirm: true`; a mailbox send still waits the undo window.
 */

export interface ToolAnnotations {
  readonly title: string
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

/** What a tool knows of the request: the origin its links point at (the public origin when set). */
export interface ToolContext {
  readonly origin: string
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly scope: Scope
  readonly input: Schema.Decoder<unknown, never>
  readonly annotations: ToolAnnotations
  // biome-ignore lint/suspicious/noExplicitAny: each tool's input is decoded by its own schema first.
  readonly run: (input: any, caller: Caller, context: ToolContext) => Effect.Effect<unknown, unknown, any>
}

/** A refusal the model can read and act on: it becomes a tool result with isError, not a protocol error. */
export class ToolRefused extends Schema.TaggedError<ToolRefused>()("ToolRefused", {
  message: Schema.String,
}) {}

const reads = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})
const sends = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
})

const Confirm = Schema.Literal(true).annotate({
  description: "Must be true: this sends mail to real people. Check the details with the user first.",
})

const requireConfirm = (input: { readonly confirm?: unknown }) =>
  input.confirm === true
    ? Effect.void
    : Effect.fail(
        new ToolRefused({
          message: "Sending needs confirm: true. Show the user what will be sent and ask first.",
        }),
      )

/** How long an attachment link handed to an agent works. */
const AGENT_LINK_TTL_SECONDS = 15 * 60

const clip = (text: string, max = 20_000) => (text.length > max ? `${text.slice(0, max)}…` : text)

const CORE_TOOLS: ReadonlyArray<Tool> = [
  {
    name: "list_mailboxes",
    description: "The mailboxes this key can read: their ids and addresses. Start here to find a mailboxId.",
    scope: "read",
    input: Schema.Struct({}),
    annotations: reads("List mailboxes"),
    run: (_input, caller) =>
      readableMailboxes(caller).pipe(
        Effect.map((list) => ({
          mailboxes: list.map((m) => ({ id: m.id, address: m.address, kind: m.kind })),
        })),
      ),
  },
  {
    name: "search_mail",
    description:
      'Search mail: words, "phrases", and operators from:, to:, subject:, body:, in:<folder>, label:, is:unread, is:starred, has:attachment, before:YYYY-MM-DD, after:YYYY-MM-DD. One mailbox, or every readable one when mailboxId is left out.',
    scope: "read",
    input: Schema.Struct({
      q: Schema.String,
      mailboxId: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    }),
    annotations: reads("Search mail"),
    run: (input: { q: string; mailboxId?: string; limit?: number }, caller) =>
      Effect.gen(function* () {
        if (input.mailboxId) {
          yield* requireMailbox(caller, input.mailboxId, "read")
          const r = yield* callMailbox(input.mailboxId, (s) =>
            s.search(input.q, { limit: input.limit ?? 10 }),
          )
          return { hits: r.hits, parsed: r.parsed }
        }
        const all = yield* searchMail(caller, input.q, { limit: input.limit ?? 10 })
        return {
          groups: all.groups.map((g) => ({ mailboxId: g.mailboxId, address: g.address, hits: g.hits })),
          partial: all.partial,
        }
      }),
  },
  {
    name: "read_thread",
    description: "A conversation with every message's text, oldest first. Get threadId from search_mail.",
    scope: "read",
    input: Schema.Struct({ mailboxId: Schema.String, threadId: Schema.String }),
    annotations: reads("Read a thread"),
    run: (input: { mailboxId: string; threadId: string }, caller, context) =>
      Effect.gen(function* () {
        yield* requireMailbox(caller, input.mailboxId, "read")
        const result = yield* callMailbox(input.mailboxId, (s) => s.thread(input.threadId))
        if (!result)
          return yield* new ToolRefused({ message: `No thread ${input.threadId} in this mailbox.` })
        const messages = []
        for (const m of result.messages) {
          // Each attachment with a signed link good for 15 minutes; read_attachment gives its text.
          const attachments = []
          for (const a of m.attachments.filter((x) => !x.related)) {
            const token = yield* signFileToken(
              { k: a.r2Key, n: a.filename ?? "attachment", t: a.mimeType, d: "attachment" },
              AGENT_LINK_TTL_SECONDS,
            )
            attachments.push({
              id: a.id,
              filename: a.filename,
              mimeType: a.mimeType,
              bytes: a.size,
              url: fileUrl(context.origin, token),
            })
          }
          messages.push({
            id: m.id,
            from: m.from,
            to: m.to,
            cc: m.cc,
            subject: m.subject,
            date: m.date ?? m.receivedAt,
            folder: m.folder,
            text: clip(yield* bodyTextOf(m)),
            attachments,
          })
        }
        return {
          thread: { id: result.thread.id, subject: result.thread.subject, assignee: result.thread.assignee },
          messages,
          notes: result.notes,
        }
      }),
  },
  {
    name: "draft_reply",
    description:
      "Writes a reply, reply-all or forward of a message as a draft in the mailbox. Nothing is sent: use send_draft after the user agrees.",
    scope: "send",
    input: Schema.Struct({
      mailboxId: Schema.String,
      messageId: Schema.String,
      mode: Schema.Literals(["reply", "replyAll", "forward"]),
      bodyText: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
      to: Schema.optionalKey(
        Schema.Array(Schema.String).annotate({ description: "For a forward: who to send it to." }),
      ),
    }),
    annotations: {
      title: "Draft a reply",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    run: (
      input: {
        mailboxId: string
        messageId: string
        mode: "reply" | "replyAll" | "forward"
        bodyText: string
        to?: Array<string>
      },
      caller,
    ) =>
      Effect.gen(function* () {
        const { mailbox } = yield* requireMailbox(caller, input.mailboxId, "write")
        const draft = yield* createDraftNow(input.mailboxId, mailbox, {
          replyTo: { messageId: input.messageId, mode: input.mode },
          bodyText: input.bodyText,
          ...(input.to ? { to: input.to.map((address) => ({ address })) } : {}),
        })
        return {
          draft: {
            id: draft.id,
            to: draft.to,
            cc: draft.cc,
            subject: draft.subject,
            bodyText: draft.bodyText,
          },
        }
      }),
  },
  {
    name: "send_draft",
    description:
      "Sends a draft from the mailbox. It waits the account's undo window first (10 s by default), so it can still be cancelled in the app. Needs confirm: true. If this key's sends need approval, it is held instead (held: true) until a person approves it; a refusal says why (agent_limit, recipient_not_allowed).",
    scope: "send",
    input: Schema.Struct({ mailboxId: Schema.String, draftId: Schema.String, confirm: Confirm }),
    annotations: sends("Send a draft"),
    run: (input: { mailboxId: string; draftId: string; confirm: true }, caller) =>
      Effect.gen(function* () {
        yield* requireConfirm(input)
        const { mailbox } = yield* requireMailbox(caller, input.mailboxId, "send")
        const sent = yield* sendDraft({
          caller,
          mailboxId: input.mailboxId,
          mailboxAddress: mailbox.address,
          draftId: input.draftId,
          origin: null,
        })
        // A key whose sends wait for approval gets the approval to report back, not a send time.
        if (sent.approval)
          return {
            draftId: input.draftId,
            held: true,
            approvalId: sent.approval.id,
            note: "This key's sends wait for a person's approval; it goes out once someone approves it.",
          }
        return { draftId: input.draftId, sendAt: sent.sendAt, undoUntil: sent.undoUntil }
      }),
  },
  {
    name: "send_email",
    description:
      "Sends one transactional email (a receipt, a sign-in code, a notice) from an address on a sending domain. Not for newsletters: use a campaign. Needs confirm: true. If this key's sends need approval, it is held instead (held: true) until a person approves it; a refusal says why (agent_limit, recipient_not_allowed).",
    scope: "send",
    input: Schema.Struct({
      to: Schema.String,
      subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(998)),
      body: Schema.String.annotate({ description: "HTML, or plain text." }),
      from: Schema.optionalKey(
        Schema.String.annotate({ description: "Defaults to the workspace's DEFAULT_FROM." }),
      ),
      confirm: Confirm,
    }),
    annotations: sends("Send an email"),
    run: (input: { to: string; subject: string; body: string; from?: string; confirm: true }, caller) =>
      Effect.gen(function* () {
        yield* requireConfirm(input)
        const request = {
          recipients: [{ email: input.to }],
          subject: input.subject,
          body: input.body,
          ...(input.from ? { from: { email: input.from } } : {}),
          apiKeyId: caller.keyId,
        }
        // The key's guardrails (HAL-3460): refused with a reason, or held for a person's yes.
        const decision = yield* checkSend(caller, {
          recipients: [input.to],
          messages: 1,
          holdable: true,
          what: "this email",
        })
        if (decision === "hold") {
          const approval = yield* holdSend(caller, {
            kind: "transactional",
            request,
            recipients: [input.to],
            subject: input.subject,
            from: input.from ?? null,
          })
          return {
            held: true,
            approvalId: approval.id,
            note: "This key's sends wait for a person's approval; it goes out once someone approves it.",
          }
        }
        const sent = yield* sendTransactional(request)
        return { emails: sent.map((e) => ({ id: e.email, to: e.contact.email, status: e.status })) }
      }),
  },
  {
    name: "preview_segment",
    description:
      'Who a segment filter matches: the count and a sample. The filter is a segment rule tree: groups {"type":"all"|"any","rules":[…]} of rules on fields, status, topics, events, engagement, campaigns and when contacts joined.',
    scope: "read",
    input: Schema.Struct({ filter: Rule }),
    annotations: reads("Preview a segment"),
    run: (input: { filter: unknown }) => previewSegment(input.filter),
  },
  {
    name: "campaign_stats",
    description:
      "A campaign's report: sent, delivered, opened, clicked, bounced, complained and unsubscribed, with rates.",
    scope: "read",
    input: Schema.Struct({ campaignId: Schema.String }),
    annotations: reads("Campaign stats"),
    run: (input: { campaignId: string }) => campaignReport(input.campaignId),
  },
  {
    name: "contact_lookup",
    description: "A contact by email: status, fields, topics and recent activity.",
    scope: "read",
    input: Schema.Struct({ email: Schema.String }),
    annotations: reads("Look up a contact"),
    run: (input: { email: string }) =>
      Effect.gen(function* () {
        const database = yield* Database
        const row = yield* database.query("mcp.contactByEmail", (db) =>
          db
            .select({ id: contacts.id })
            .from(contacts)
            .where(eq(contacts.email, normalizeEmail(input.email)))
            .get(),
        )
        if (!row) return { contact: null }
        return { contact: yield* getContact(row.id) }
      }),
  },
  {
    name: "track_event",
    description:
      "Records an event a contact did (signed_up, upgraded, …), which segments and automations act on.",
    scope: "track",
    input: Schema.Struct({
      email: Schema.String,
      event: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
      data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
    annotations: {
      title: "Track an event",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    run: (input: { email: string; event: string; data?: Record<string, unknown> }) =>
      track({ email: input.email, event: input.event, ...(input.data ? { data: input.data } : {}) }),
  },
]

// ---------------------------------------------------------------------------------------------
// Agent tools (HAL-3459): writing new mail, working the inbox, and reading attachments.
// ---------------------------------------------------------------------------------------------

/** Attachments an agent hands compose_message: base64, at most 10, each within the upload limit. */
const ComposeAttachment = Schema.Struct({
  filename: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  contentType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
  content: Schema.String.annotate({ description: "The file, base64-encoded." }),
})

const MAX_COMPOSE_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** read_attachment returns at most this much text, with `truncated` when there was more. */
const MAX_ATTACHMENT_TEXT = 200_000
/** Files read_attachment will open at all: bigger ones are left to the link. */
const MAX_READ_BYTES = 10 * 1024 * 1024

const fromBase64 = (b64: string) => {
  const raw = atob(b64.replace(/\s+/g, ""))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

const ThreadIds = Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(100))

/** Changes threads in a mailbox the key may write, through the same path as the API's bulk action. */
const inboxAction = (
  input: { mailboxId: string; threadIds: ReadonlyArray<string> },
  caller: Caller,
  action: ThreadAction,
) =>
  Effect.gen(function* () {
    yield* requireMailbox(caller, input.mailboxId, "write")
    const result = yield* applyThreadAction(input.mailboxId, caller, action)
    return { updated: (result as { updated?: number }).updated ?? input.threadIds.length }
  })

const writes = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})

const AGENT_TOOLS: ReadonlyArray<Tool> = [
  {
    name: "compose_message",
    description:
      "Writes a new message as a draft in the mailbox: recipients, subject, text and optional attachments (base64). Nothing is sent: use send_draft after the user agrees.",
    scope: "send",
    input: Schema.Struct({
      mailboxId: Schema.String,
      to: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
      cc: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
      bcc: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
      subject: Schema.String.check(Schema.isMaxLength(998)),
      body: Schema.String.check(Schema.isMaxLength(1_000_000)).annotate({ description: "Plain text." }),
      attachments: Schema.optionalKey(
        Schema.Array(ComposeAttachment).check(Schema.isMaxLength(MAX_COMPOSE_ATTACHMENTS)),
      ),
    }),
    annotations: {
      title: "Compose a message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    run: (
      input: {
        mailboxId: string
        to: ReadonlyArray<string>
        cc?: ReadonlyArray<string>
        bcc?: ReadonlyArray<string>
        subject: string
        body: string
        attachments?: ReadonlyArray<{ filename: string; contentType?: string; content: string }>
      },
      caller,
    ) =>
      Effect.gen(function* () {
        const { mailbox } = yield* requireMailbox(caller, input.mailboxId, "write")
        // Each attachment is stored like an upload through POST …/uploads, so the draft treats it the same.
        const store = yield* BlobStore
        const ids = yield* Ids
        const attachments = []
        for (const a of input.attachments ?? []) {
          if (/[/\\\0]/.test(a.filename))
            return yield* new ToolRefused({ message: `${a.filename}: a file name can't contain slashes.` })
          let bytes: Uint8Array
          try {
            bytes = fromBase64(a.content)
          } catch {
            return yield* new ToolRefused({ message: `${a.filename} isn't valid base64.` })
          }
          if (bytes.byteLength === 0) return yield* new ToolRefused({ message: `${a.filename} is empty.` })
          if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
            return yield* new ToolRefused({ message: `${a.filename} is over 25 MiB.` })
          const key = `upl/${input.mailboxId}/${yield* ids.next}`
          const mimeType = a.contentType?.split(";")[0]?.trim() || "application/octet-stream"
          yield* store.put(key, bytes, mimeType)
          attachments.push({ key, filename: a.filename, mimeType, size: bytes.byteLength })
        }
        const draft = yield* createDraftNow(input.mailboxId, mailbox, {
          to: input.to.map((address) => ({ address })),
          ...(input.cc ? { cc: input.cc.map((address) => ({ address })) } : {}),
          ...(input.bcc ? { bcc: input.bcc.map((address) => ({ address })) } : {}),
          subject: input.subject,
          bodyText: input.body,
          ...(attachments.length ? { attachments } : {}),
        })
        return {
          draft: {
            id: draft.id,
            from: draft.from,
            to: draft.to,
            cc: draft.cc,
            bcc: draft.bcc,
            subject: draft.subject,
            attachments: draft.attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              bytes: a.size,
            })),
          },
          next: "Show the user the draft, then call send_draft with confirm: true to send it.",
        }
      }),
  },
  {
    name: "mark_read",
    description: "Marks conversations read (or unread with read: false) in a mailbox this key can change.",
    scope: "read",
    input: Schema.Struct({
      mailboxId: Schema.String,
      threadIds: ThreadIds,
      read: Schema.optionalKey(Schema.Boolean),
    }),
    annotations: writes("Mark read"),
    run: (input: { mailboxId: string; threadIds: ReadonlyArray<string>; read?: boolean }, caller) =>
      inboxAction(input, caller, {
        threadIds: input.threadIds,
        action: input.read === false ? "unread" : "read",
      }),
  },
  {
    name: "archive",
    description: "Moves conversations out of the inbox into the archive.",
    scope: "read",
    input: Schema.Struct({ mailboxId: Schema.String, threadIds: ThreadIds }),
    annotations: writes("Archive"),
    run: (input: { mailboxId: string; threadIds: ReadonlyArray<string> }, caller) =>
      inboxAction(input, caller, { threadIds: input.threadIds, action: "archive" }),
  },
  {
    name: "label",
    description:
      "Adds a label to conversations (or removes it with remove: true). Name the label; one that doesn't exist yet is created.",
    scope: "read",
    input: Schema.Struct({
      mailboxId: Schema.String,
      threadIds: ThreadIds,
      label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
      remove: Schema.optionalKey(Schema.Boolean),
    }),
    annotations: writes("Label"),
    run: (
      input: { mailboxId: string; threadIds: ReadonlyArray<string>; label: string; remove?: boolean },
      caller,
    ) =>
      Effect.gen(function* () {
        yield* requireMailbox(caller, input.mailboxId, "write")
        const labels = yield* callMailbox(input.mailboxId, (s) => s.labels())
        const wanted = input.label.trim()
        let found = labels.find((l) => l.id === wanted || l.name.toLowerCase() === wanted.toLowerCase())
        if (!found) {
          if (input.remove) return { updated: 0, label: null }
          found = (yield* callMailbox(input.mailboxId, (s) => s.createLabel({ name: wanted }))).label
        }
        const labelId = found?.id
        if (!labelId) return yield* new ToolRefused({ message: `Couldn't make the label ${wanted}.` })
        const done = yield* inboxAction(input, caller, {
          threadIds: input.threadIds,
          action: input.remove ? "unlabel" : "label",
          labelId,
        })
        return { ...done, label: { id: labelId, name: found?.name ?? wanted } }
      }),
  },
  {
    name: "snooze",
    description:
      "Hides conversations until a time, when they come back to the inbox. `until` is an ISO 8601 date-time or Unix milliseconds.",
    scope: "read",
    input: Schema.Struct({
      mailboxId: Schema.String,
      threadIds: ThreadIds,
      until: Schema.Union([Schema.String, Schema.Number]),
    }),
    annotations: writes("Snooze"),
    run: (input: { mailboxId: string; threadIds: ReadonlyArray<string>; until: string | number }, caller) =>
      Effect.gen(function* () {
        const until = typeof input.until === "number" ? input.until : Date.parse(input.until)
        if (!Number.isFinite(until) || until <= Date.now())
          return yield* new ToolRefused({ message: "`until` must be a time in the future." })
        return yield* inboxAction(input, caller, { threadIds: input.threadIds, action: "snooze", until })
      }),
  },
  {
    name: "move",
    description: "Moves conversations to a folder: inbox, archive, spam or trash.",
    scope: "read",
    input: Schema.Struct({
      mailboxId: Schema.String,
      threadIds: ThreadIds,
      folder: Schema.Literals(["inbox", "archive", "spam", "trash"]),
    }),
    annotations: writes("Move"),
    run: (input: { mailboxId: string; threadIds: ReadonlyArray<string>; folder: string }, caller) =>
      inboxAction(input, caller, { threadIds: input.threadIds, action: "move", folder: input.folder }),
  },
  {
    name: "read_attachment",
    description:
      "An attachment's text: text, CSV and JSON as they are; PDF and Office documents converted to Markdown. Images aren't read. Get attachmentId from read_thread.",
    scope: "read",
    input: Schema.Struct({
      mailboxId: Schema.String,
      messageId: Schema.String,
      attachmentId: Schema.String,
      maxChars: Schema.optionalKey(
        Schema.Number.check(Schema.isBetween({ minimum: 100, maximum: MAX_ATTACHMENT_TEXT })),
      ),
    }),
    annotations: reads("Read an attachment"),
    run: (
      input: { mailboxId: string; messageId: string; attachmentId: string; maxChars?: number },
      caller,
      context,
    ) =>
      Effect.gen(function* () {
        yield* requireMailbox(caller, input.mailboxId, "read")
        const message = yield* callMailbox(input.mailboxId, (s) => s.message(input.messageId))
        if (!message)
          return yield* new ToolRefused({ message: `No message ${input.messageId} in this mailbox.` })
        const a = message.attachments.find((x) => x.id === input.attachmentId)
        if (!a)
          return yield* new ToolRefused({ message: `No attachment ${input.attachmentId} on that message.` })
        const meta = { id: a.id, filename: a.filename, mimeType: a.mimeType, bytes: a.size }
        const link = fileUrl(
          context.origin,
          yield* signFileToken(
            { k: a.r2Key, n: a.filename ?? "attachment", t: a.mimeType, d: "attachment" },
            AGENT_LINK_TTL_SECONDS,
          ),
        )
        const unreadable = (why: string) => ({
          attachment: meta,
          text: null,
          truncated: false,
          note: why,
          url: link,
        })
        if (a.size > MAX_READ_BYTES) return unreadable("Over 10 MiB, so it isn't read here; use the link.")
        const mime = a.mimeType.toLowerCase().split(";")[0]?.trim() ?? ""
        const name = (a.filename ?? "").toLowerCase()
        const plain =
          mime.startsWith("text/") && mime !== "text/html"
            ? true
            : [
                "application/json",
                "application/csv",
                "application/x-ndjson",
                "application/xml+text",
              ].includes(mime) || /\.(txt|csv|tsv|json|md|log|ics|vcf|yaml|yml)$/.test(name)
        const blob = yield* (yield* BlobStore).get(a.r2Key)
        if (blob._tag === "None") return unreadable("The file is no longer stored.")
        const bytes = blob.value.body
        let text: string | null = null
        let via: "as-is" | "converted" = "as-is"
        if (plain) text = new TextDecoder().decode(bytes)
        else if (CONVERTIBLE.has(mime) || /\.(pdf|docx?|xlsx?|odt|ods|numbers|html?)$/.test(name)) {
          const converted = yield* (yield* DocumentText).toMarkdown({
            filename: a.filename ?? "attachment",
            mimeType: a.mimeType,
            bytes,
          })
          if (!converted) return unreadable("This document couldn't be converted here; use the link.")
          text = converted.text
          via = "converted"
        } else if (mime.startsWith("image/")) return unreadable("Images aren't read; use the link to see it.")
        else return unreadable(`${a.mimeType} isn't a format read here; use the link.`)
        const max = input.maxChars ?? 50_000
        return {
          attachment: meta,
          text: text.length > max ? text.slice(0, max) : text,
          truncated: text.length > max,
          chars: text.length,
          via,
          url: link,
        }
      }),
  },
]

/** Waiting for mail (HAL-3461): an agent blocks until something arrives instead of polling. */
const WAIT_TOOLS: ReadonlyArray<Tool> = [
  {
    name: "wait_for_mail",
    description:
      "Waits for new mail in a mailbox and returns it as soon as it arrives (or at once if some arrived after `since`). Pass the `cursor` from the last call as `since`; without it, waits for mail from now on. Returns timedOut: true when nothing came within timeoutSeconds (at most 50).",
    scope: "read",
    input: Schema.Struct({
      mailboxId: Schema.String,
      since: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
      timeoutSeconds: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
    }),
    annotations: reads("Wait for mail"),
    run: (input: { mailboxId: string; since?: number; timeoutSeconds?: number }, caller) =>
      Effect.gen(function* () {
        yield* requireMailbox(caller, input.mailboxId, "read")
        return yield* callMailbox(input.mailboxId, (s) =>
          s.waitForMail(input.since ?? null, (input.timeoutSeconds ?? 25) * 1000),
        )
      }),
  },
]

export const TOOLS: ReadonlyArray<Tool> = [...CORE_TOOLS, ...AGENT_TOOLS, ...WAIT_TOOLS]

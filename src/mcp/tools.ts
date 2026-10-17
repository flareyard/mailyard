import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { campaignReport } from "../campaigns/report.ts"
import { contacts } from "../db/schema.ts"
import type { Caller, Scope } from "../domain/apiKeys.ts"
import { getContact, normalizeEmail } from "../domain/contacts.ts"
import { track } from "../domain/events.ts"
import { sendTransactional } from "../domain/outbox.ts"
import { readableMailboxes } from "../domain/overview.ts"
import { previewSegment } from "../domain/segments.ts"
import { searchMail } from "../domain/workspaceSearch.ts"
import { createDraftNow } from "../http/mailHandlers.ts"
import { requireMailbox } from "../mail/access.ts"
import { bodyTextOf } from "../mail/compose.ts"
import { callMailbox } from "../mail/rpc.ts"
import { sendDraft } from "../mail/send.ts"
import { Rule } from "../segments/rules.ts"
import { Database } from "../services/Database.ts"

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

export interface Tool {
  readonly name: string
  readonly description: string
  readonly scope: Scope
  readonly input: Schema.Decoder<unknown, never>
  readonly annotations: ToolAnnotations
  // biome-ignore lint/suspicious/noExplicitAny: each tool's input is decoded by its own schema first.
  readonly run: (input: any, caller: Caller) => Effect.Effect<unknown, unknown, any>
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

const clip = (text: string, max = 20_000) => (text.length > max ? `${text.slice(0, max)}…` : text)

export const TOOLS: ReadonlyArray<Tool> = [
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
    run: (input: { mailboxId: string; threadId: string }, caller) =>
      Effect.gen(function* () {
        yield* requireMailbox(caller, input.mailboxId, "read")
        const result = yield* callMailbox(input.mailboxId, (s) => s.thread(input.threadId))
        if (!result)
          return yield* new ToolRefused({ message: `No thread ${input.threadId} in this mailbox.` })
        const messages = []
        for (const m of result.messages)
          messages.push({
            id: m.id,
            from: m.from,
            to: m.to,
            cc: m.cc,
            subject: m.subject,
            date: m.date ?? m.receivedAt,
            folder: m.folder,
            text: clip(yield* bodyTextOf(m)),
          })
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
      "Sends a draft from the mailbox. It waits the account's undo window first (10 s by default), so it can still be cancelled in the app. Needs confirm: true.",
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
        return { draftId: input.draftId, sendAt: sent.sendAt, undoUntil: sent.undoUntil }
      }),
  },
  {
    name: "send_email",
    description:
      "Sends one transactional email (a receipt, a sign-in code, a notice) from an address on a sending domain. Not for newsletters: use a campaign. Needs confirm: true.",
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
        const sent = yield* sendTransactional({
          recipients: [{ email: input.to }],
          subject: input.subject,
          body: input.body,
          ...(input.from ? { from: { email: input.from } } : {}),
          apiKeyId: caller.keyId,
        })
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

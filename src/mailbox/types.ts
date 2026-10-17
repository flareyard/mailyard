import type { AuthResults } from "../inbound/auth.ts"
import type { Party } from "../inbound/parse.ts"

export type { Party }

/** Where a message sits. A thread is in every folder one of its messages is in. */
export const FOLDERS = ["inbox", "archive", "sent", "spam", "trash", "snoozed"] as const
export type Folder = (typeof FOLDERS)[number]

/** One attachment as the mailbox stores it; the bytes are in R2 under `r2Key` (content-addressed). */
export interface DeliveredAttachment {
  readonly id: string
  readonly filename: string | null
  readonly mimeType: string
  readonly disposition: string | null
  readonly contentId: string | null
  readonly related: boolean
  readonly size: number
  readonly sha256: string
  readonly r2Key: string
}

/** Everything the inbound pipeline hands a mailbox. Serialisable, so it crosses the RPC boundary. */
export interface InboundDelivery {
  /** The inbound ledger id. Delivering the same id twice stores the message once. */
  readonly id: string
  readonly receivedAt: number
  readonly envelopeFrom: string
  /** The envelope recipient as it arrived, `+tag` included. */
  readonly envelopeTo: string
  readonly via: "mailbox" | "alias" | "group" | "catch_all"
  readonly tag: string | null
  readonly rawKey: string
  /** R2 key of `{ text, html, headers }` for rendering the message in full. */
  readonly bodyKey: string
  readonly size: number
  readonly messageId: string | null
  readonly inReplyTo: string | null
  readonly references: ReadonlyArray<string>
  readonly subject: string
  readonly date: number | null
  readonly from: Party | null
  readonly sender: Party | null
  readonly replyTo: ReadonlyArray<Party>
  readonly to: ReadonlyArray<Party>
  readonly cc: ReadonlyArray<Party>
  readonly snippet: string
  /** Plain text, capped at BODY_TEXT_LIMIT characters, for search. The full body is at `bodyKey`. */
  readonly bodyText: string
  readonly hasHtml: boolean
  readonly auth: AuthResults
  readonly automated: boolean
  readonly listId: string | null
  readonly listUnsubscribe: string | null
  readonly attachments: ReadonlyArray<DeliveredAttachment>
  /** The spam check's score and why, when one ran (src/rules/spam.ts). */
  readonly spam?:
    | {
        readonly score: number
        readonly reasons: ReadonlyArray<{ readonly rule: string; readonly points: number }>
      }
    | undefined
  /** Inbox rules that matched. */
  readonly rulesMatched?: ReadonlyArray<string> | undefined
}

/** Where and how a delivery is filed, as the rules and the spam check decided. */
export interface FilingOptions {
  readonly folder?: Folder | undefined
  readonly labelIds?: ReadonlyArray<string> | undefined
  readonly seen?: boolean | undefined
  readonly starred?: boolean | undefined
  readonly answered?: boolean | undefined
  /** Assign the conversation to this key, unless someone already has it (a rule's assign action). */
  readonly assignee?: string | null | undefined
}

export const BODY_TEXT_LIMIT = 256 * 1024

export interface StoredMessage extends Omit<InboundDelivery, "bodyText" | "spam" | "rulesMatched"> {
  readonly spamScore: number | null
  readonly spamReasons: ReadonlyArray<{ readonly rule: string; readonly points: number }>
  readonly rulesMatched: ReadonlyArray<string>
  readonly storedAt: number
  readonly threadId: string
  readonly folder: Folder
  readonly seen: boolean
  readonly starred: boolean
  readonly answered: boolean
  readonly labelIds: ReadonlyArray<string>
}

export interface MessageSummary {
  readonly id: string
  readonly threadId: string
  readonly subject: string
  readonly from: Party | null
  readonly snippet: string
  readonly receivedAt: number
  readonly folder: Folder
  readonly seen: boolean
}

export interface ThreadSummary {
  readonly id: string
  /** The first message's subject. */
  readonly subject: string
  /** The newest message's snippet. */
  readonly snippet: string
  readonly latestMessageId: string
  readonly messageCount: number
  /** Unread messages outside trash and spam. */
  readonly unreadCount: number
  readonly starred: boolean
  readonly hasAttachments: boolean
  /** Senders in the order they joined the conversation, at most eight. */
  readonly participants: ReadonlyArray<Party>
  readonly folders: ReadonlyArray<Folder>
  readonly labelIds: ReadonlyArray<string>
  readonly firstAt: number
  readonly lastAt: number
  /** What lists sort by: the last arrival, or the moment a snooze ended if later. */
  readonly sortAt: number
  readonly snoozedUntil: number | null
  /** The API key handling this conversation in a shared inbox, or null. */
  readonly assignee: string | null
}

export interface Label {
  readonly id: string
  readonly name: string
  readonly color: string | null
  readonly threads: number
  readonly unreadThreads: number
  readonly createdAt: number
}

export interface FolderCount {
  readonly folder: Folder | "drafts"
  readonly threads: number
  readonly unreadThreads: number
}

export interface DraftAttachment {
  /** R2 key of an upload; the bytes stay there until the draft is sent or deleted. */
  readonly key: string
  readonly filename: string
  readonly mimeType: string
  readonly size: number
}

export type ReplyMode = "reply" | "replyAll" | "forward"

export interface DraftInput {
  readonly id?: string | undefined
  readonly replyMode?: ReplyMode | null | undefined
  /** The message this draft answers or forwards. */
  readonly sourceMessageId?: string | null | undefined
  readonly threadId?: string | null | undefined
  readonly inReplyTo?: string | null | undefined
  readonly references?: ReadonlyArray<string> | undefined
  readonly from?: string | null | undefined
  readonly to?: ReadonlyArray<Party> | undefined
  readonly cc?: ReadonlyArray<Party> | undefined
  readonly bcc?: ReadonlyArray<Party> | undefined
  readonly subject?: string | undefined
  readonly bodyText?: string | undefined
  readonly bodyHtml?: string | null | undefined
  readonly attachments?: ReadonlyArray<DraftAttachment> | undefined
}

/** `scheduled` waits for its alarm; `due` has reached it and waits for the sender (HAL-3152). */
export type DraftStatus = "draft" | "scheduled" | "due"

export interface DraftTracking {
  readonly opens: boolean
  readonly clicks: boolean
}

export interface Draft {
  readonly id: string
  readonly threadId: string | null
  readonly inReplyTo: string | null
  readonly references: ReadonlyArray<string>
  readonly from: string | null
  readonly to: ReadonlyArray<Party>
  readonly cc: ReadonlyArray<Party>
  readonly bcc: ReadonlyArray<Party>
  readonly subject: string
  readonly bodyText: string
  readonly bodyHtml: string | null
  readonly attachments: ReadonlyArray<DraftAttachment>
  readonly status: DraftStatus
  readonly sendAt: number | null
  readonly replyMode: ReplyMode | null
  readonly sourceMessageId: string | null
  /** Why the last attempt to send it failed; cleared when the draft is edited. */
  readonly lastError: string | null
  /** When the last send was refused before going out: quota, domain, or every recipient suppressed. */
  readonly blockedReason: "quota_exhausted" | "domain_unhealthy" | "all_recipients_suppressed" | null
  /** Opens and clicks to track, chosen for this send; null (never tracked) unless the sender asked. */
  readonly track: DraftTracking | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface MessagePatch {
  readonly seen?: boolean | undefined
  readonly starred?: boolean | undefined
  readonly answered?: boolean | undefined
  readonly folder?: Folder | undefined
  readonly addLabels?: ReadonlyArray<string> | undefined
  readonly removeLabels?: ReadonlyArray<string> | undefined
}

export interface ThreadFilter {
  readonly folder?: Folder | undefined
  readonly labelId?: string | undefined
  readonly unread?: boolean | undefined
  readonly starred?: boolean | undefined
  /** An API key id, or "none" for unassigned conversations. */
  readonly assignee?: string | undefined
  readonly limit?: number | undefined
  readonly cursor?: string | null | undefined
}

export interface SearchHit {
  readonly messageId: string
  readonly threadId: string
  readonly folder: Folder
  readonly from: Party | null
  readonly receivedAt: number
  /** Subject and body excerpt with matches wrapped in HIGHLIGHT_START / HIGHLIGHT_END. */
  readonly subject: string
  readonly excerpt: string
  readonly rank: number
}

/** What open clients are told. Each change is a single frame. */
export type MailboxEvent =
  | {
      readonly type: "message.added"
      readonly message: MessageSummary
      readonly thread: ThreadSummary
      readonly removedThreadIds: ReadonlyArray<string>
      readonly counts: ReadonlyArray<FolderCount>
    }
  | {
      readonly type: "threads.changed"
      readonly threads: ReadonlyArray<ThreadSummary>
      readonly removedThreadIds: ReadonlyArray<string>
      readonly counts: ReadonlyArray<FolderCount>
    }
  | { readonly type: "labels.changed"; readonly labels: ReadonlyArray<Label> }
  | {
      readonly type: "drafts.changed"
      readonly drafts: ReadonlyArray<Draft>
      readonly removedDraftIds: ReadonlyArray<string>
    }
  | { readonly type: "draft.due"; readonly draft: Draft }

/**
 * A request the mailbox refuses. Thrown across RPC as an Error whose message starts with the code,
 * so callers can map it: `mailboxErrorCode(error)`.
 */
export const MAILBOX_ERRORS = [
  "not_found",
  "invalid",
  "label_exists",
  "unknown_label",
  "draft_locked",
] as const
export type MailboxErrorCode = (typeof MAILBOX_ERRORS)[number]

export const mailboxError = (code: MailboxErrorCode, message: string) => new Error(`${code}: ${message}`)

export const mailboxErrorCode = (error: unknown): MailboxErrorCode | null => {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.slice(0, message.indexOf(":"))
  return (MAILBOX_ERRORS as ReadonlyArray<string>).includes(code) ? (code as MailboxErrorCode) : null
}

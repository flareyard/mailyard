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
  /** The earliest scheduled send of a reply in this conversation (HAL-3405), or null. */
  readonly scheduledSendAt?: number | null
  /** The highest spam score of its messages in spam; only when listing spam. */
  readonly spamScore?: number | null
}

export interface Label {
  readonly id: string
  readonly name: string
  readonly color: LabelColor | null
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
  /** How it would go if sent now: in the message, or as an expiring link (too big to fit). */
  readonly delivery?: "inline" | "link"
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
  /** A folder, or "all": every folder but spam and trash (All mail). */
  readonly folder?: Folder | "all" | undefined
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
  readonly subject: string
  /** The subject and body excerpt with matches wrapped in HIGHLIGHT_START / HIGHLIGHT_END. */
  readonly subjectHighlighted: string
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
  /** A sent message's per-recipient delivery moved (HAL-3408): who got it, who's deferred, who bounced. */
  | {
      readonly type: "delivery.changed"
      readonly messageId: string
      readonly logId: string
      readonly recipients: ReadonlyArray<Readonly<Record<string, unknown>>>
    }
  /** A conversation's internal notes changed (HAL-3407). */
  | {
      readonly type: "notes.changed"
      readonly threadId: string
      readonly notes: ReadonlyArray<{
        readonly id: string
        readonly author: string
        readonly body: string
        readonly createdAt: number
      }>
    }
  /** A mailbox import moved (HAL-3399): its totals, rate, ETA and folders. Pushed by the import Workflow. */
  | {
      readonly type: "import.progress"
      readonly importId: string
      readonly status: string
      readonly totals: Readonly<Record<string, number>>
      readonly ratePerMinute: number | null
      readonly etaAt: number | null
      readonly folders: ReadonlyArray<Readonly<Record<string, unknown>>>
    }

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
  /** The caller may use the mailbox but not do this to someone else's thing (a note). */
  "forbidden",
] as const
export type MailboxErrorCode = (typeof MAILBOX_ERRORS)[number]

export const mailboxError = (code: MailboxErrorCode, message: string) => new Error(`${code}: ${message}`)

export const mailboxErrorCode = (error: unknown): MailboxErrorCode | null => {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.slice(0, message.indexOf(":"))
  return (MAILBOX_ERRORS as ReadonlyArray<string>).includes(code) ? (code as MailboxErrorCode) : null
}

/**
 * The label palette (HAL-3407): names, not hex, so every screen draws a label from the design
 * tokens in both themes. A colour stored as hex before became the nearest of these.
 */
export const LABEL_COLORS = ["blue", "navy", "sky", "teal", "pine", "slate"] as const
export type LabelColor = (typeof LABEL_COLORS)[number]
/** Where each palette colour sits, for mapping an old hex value to the nearest. */
export const LABEL_COLOR_RGB: Record<LabelColor, readonly [number, number, number]> = {
  blue: [37, 99, 235],
  navy: [30, 58, 138],
  sky: [14, 165, 233],
  teal: [13, 148, 136],
  pine: [22, 101, 52],
  slate: [71, 85, 105],
}
export const nearestLabelColor = (hex: string): LabelColor => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return "slate"
  const rgb = [m[1], m[2], m[3]].map((x) => Number.parseInt(x as string, 16)) as [number, number, number]
  let best: LabelColor = "slate"
  let bestDistance = Number.POSITIVE_INFINITY
  for (const color of LABEL_COLORS) {
    const [r, g, b] = LABEL_COLOR_RGB[color]
    const d = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2
    if (d < bestDistance) {
      bestDistance = d
      best = color
    }
  }
  return best
}

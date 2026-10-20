/**
 * Mail types, straight from the generated schema (`bun run api:types`), so a contract change breaks the
 * screens that read it at compile time. Numbers come over the wire as `number | "Infinity" | …` (Effect's
 * encoding), so every figure goes through `num()` before it is shown or compared.
 */
import type { paths } from "../api/schema"

type Json<
  P extends keyof paths,
  M extends "get" | "post" | "patch" | "put" | "delete",
  S extends number = 200,
> = paths[P][M] extends { responses: { [K in S]: { content: { "application/json": infer R } } } } ? R : never

type Body<P extends keyof paths, M extends "post" | "patch" | "put"> = paths[P][M] extends {
  requestBody?: { content: { "application/json": infer B } }
}
  ? B
  : never

export type MailboxList = Json<"/v1/mailboxes", "get">
export type Mailbox = MailboxList["mailboxes"][number]
export type MailboxDetail = Json<"/v1/mailboxes/{id}", "get">

export type FoldersBody = Json<"/v1/mailboxes/{id}/folders", "get">
export type FolderCount = FoldersBody["folders"][number]
export type Label = FoldersBody["labels"][number]
export type LabelColor = NonNullable<Label["color"]>
export type SmartFolder = FoldersBody["smartFolders"][number]

export type ThreadPage = Json<"/v1/mailboxes/{id}/threads", "get">
export type Thread = ThreadPage["threads"][number]
export type Folder = Thread["folders"][number]
export type ThreadDetail = Json<"/v1/mailboxes/{id}/threads/{threadId}", "get">
export type MessageSummary = ThreadDetail["messages"][number]
export type Note = ThreadDetail["notes"][number]
export type Party = MessageSummary["to"][number]

export type MessageDetail = Json<"/v1/mailboxes/{id}/messages/{messageId}", "get">
export type Delivery = NonNullable<MessageDetail["delivery"]>
export type DeliveryRecipient = Delivery["recipients"][number]
export type Attachment = MessageSummary["attachments"][number]

export type DraftList = Json<"/v1/mailboxes/{id}/drafts", "get">
export type Draft = DraftList["drafts"][number]
export type DraftStatus = Draft["status"]
export type BlockedReason = NonNullable<Draft["blockedReason"]>
export type DraftCreate = Body<"/v1/mailboxes/{id}/drafts", "post">
export type DraftPatch = Body<"/v1/mailboxes/{id}/drafts/{draftId}", "patch">
export type SendBody = Body<"/v1/mailboxes/{id}/drafts/{draftId}/send", "post">
export type SendResult = Json<"/v1/mailboxes/{id}/drafts/{draftId}/send", "post">

export type BulkBody = Body<"/v1/mailboxes/{id}/threads/bulk", "post">
export type BulkAction = BulkBody["action"]

export type SearchBody = Json<"/v1/mailboxes/{id}/search", "get">
export type SearchHit = SearchBody["hits"][number]
export type Parsed = SearchBody["parsed"]
export type SearchAllBody = Json<"/v1/search/mail", "get">
export type SearchSort = SearchBody["sort"]

export type IdentityList = Json<"/v1/identities", "get">
export type Identity = IdentityList["identities"][number]
export type CorrespondentList = Json<"/v1/mailboxes/{id}/correspondents", "get">
export type Correspondent = CorrespondentList["correspondents"][number]

export type AgentList = Json<"/v1/agents", "get">
export type Agent = AgentList["agents"][number]

export type Attention = Json<"/v1/mail/attention", "get">

export type Upload = Json<"/v1/mailboxes/{id}/uploads", "post", 201>

/** What a thread list shows: the URL's query. Every list is a URL (HANDOFF-mail §2). */
export type ListQuery = {
  folder?: Folder | "all"
  labelId?: string
  unread?: boolean
  starred?: boolean
  assignee?: string
  /** Has attachment: a client-side filter over the loaded page (the API has no attachment filter). */
  att?: boolean
  /** A search: the list shows `GET …/search?q=` instead of the folder. */
  q?: string
  sort?: SearchSort
}

/** The mailbox helpers (summaries, reply drafts): their settings, a summary, and a drafted reply. */
export type AssistantSettings = Json<"/v1/settings/assistant", "get">
export type ThreadSummary = Json<"/v1/mailboxes/{id}/threads/{threadId}/summary", "post">
export type DraftedReply = Json<"/v1/mailboxes/{id}/threads/{threadId}/draft", "post">

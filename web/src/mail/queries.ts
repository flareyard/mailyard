/**
 * Every Mail query: one key factory, so the live socket, the optimistic updates and the screens agree on
 * where each response lives in the cache. Keys sit under ["mailboxes", id, …] so a `reset` frame (which
 * invalidates ["mailboxes", id]) refreshes everything one mailbox shows.
 */
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"
import { api, unwrap } from "../api/client.ts"
import { foldersKey } from "../live/useMailboxLive.ts"
import type {
  AgentList,
  Attention,
  CorrespondentList,
  DraftList,
  DraftStatus,
  FoldersBody,
  IdentityList,
  ListQuery,
  MailboxDetail,
  MailboxList,
  MessageDetail,
  SearchAllBody,
  SearchBody,
  SearchSort,
  ThreadDetail,
  ThreadPage,
} from "./types.ts"

export const PAGE = 50

export const mailKeys = {
  mailboxes: ["mailboxes"] as const,
  mailbox: (id: string) => ["mailboxes", id] as const,
  detail: (id: string) => ["mailboxes", id, "detail"] as const,
  folders: (id: string) => foldersKey(id),
  threadLists: (id: string) => ["mailboxes", id, "threads"] as const,
  threads: (id: string, q: ListQuery) =>
    ["mailboxes", id, "threads", { ...q, att: undefined, q: undefined, sort: undefined }] as const,
  search: (id: string, q: string, sort: SearchSort | undefined) =>
    ["mailboxes", id, "search", q, sort ?? "recent"] as const,
  thread: (id: string, threadId: string) => ["mailboxes", id, "thread", threadId] as const,
  messages: (id: string) => ["mailboxes", id, "message"] as const,
  message: (id: string, messageId: string, headers = false) =>
    ["mailboxes", id, "message", messageId, headers ? "headers" : "body"] as const,
  draftLists: (id: string) => ["mailboxes", id, "drafts"] as const,
  drafts: (id: string, status: DraftStatus | "all") => ["mailboxes", id, "drafts", status] as const,
  correspondents: (id: string, q: string) => ["mailboxes", id, "correspondents", q] as const,
  identities: ["identities"] as const,
  agents: ["agents"] as const,
  attention: ["mail-attention"] as const,
  searchAll: (q: string, sort: SearchSort | undefined) => ["mail-search-all", q, sort ?? "recent"] as const,
}

const path = (id: string) => ({ params: { path: { id } } })

export const mailboxesQuery = queryOptions({
  queryKey: mailKeys.mailboxes,
  queryFn: () => unwrap(api.GET("/v1/mailboxes")) as Promise<MailboxList>,
  staleTime: 60_000,
})

export const mailboxDetailQuery = (id: string) =>
  queryOptions({
    queryKey: mailKeys.detail(id),
    queryFn: () => unwrap(api.GET("/v1/mailboxes/{id}", path(id))) as Promise<MailboxDetail>,
    staleTime: 60_000,
  })

export const foldersQuery = (id: string) =>
  queryOptions({
    queryKey: mailKeys.folders(id),
    queryFn: () => unwrap(api.GET("/v1/mailboxes/{id}/folders", path(id))) as Promise<FoldersBody>,
    staleTime: 5 * 60_000,
  })

/** The API's list query from the URL's: `att` is client-side and `q` is a search, so neither is sent. */
export function threadsParams(q: ListQuery) {
  return {
    ...(q.folder
      ? { folder: q.folder }
      : q.labelId || q.starred || q.assignee
        ? {}
        : { folder: "inbox" as const }),
    ...(q.labelId ? { labelId: q.labelId } : {}),
    ...(q.unread ? { unread: "true" as const } : {}),
    ...(q.starred ? { starred: "true" as const } : {}),
    ...(q.assignee ? { assignee: q.assignee } : {}),
  }
}

export const threadsQuery = (id: string, q: ListQuery) =>
  infiniteQueryOptions({
    queryKey: mailKeys.threads(id, q),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/threads", {
          params: {
            path: { id },
            // The API pages by 50 when no limit is sent (PAGE); leaving it out keeps the URL the server documents.
            query: { ...threadsParams(q), ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ) as Promise<ThreadPage>,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  })

export const searchQuery = (id: string, q: string, sort: SearchSort | undefined) =>
  queryOptions({
    queryKey: mailKeys.search(id, q, sort),
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/search", {
          params: { path: { id }, query: { q, ...(sort ? { sort } : {}), limit: "50" } },
        }),
      ) as Promise<SearchBody>,
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  })

export const searchAllQuery = (q: string, sort: SearchSort | undefined) =>
  queryOptions({
    queryKey: mailKeys.searchAll(q, sort),
    queryFn: () =>
      unwrap(
        api.GET("/v1/search/mail", { params: { query: { q, ...(sort ? { sort } : {}), limit: "20" } } }),
      ) as Promise<SearchAllBody>,
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  })

export const threadQuery = (id: string, threadId: string) =>
  queryOptions({
    queryKey: mailKeys.thread(id, threadId),
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/threads/{threadId}", { params: { path: { id, threadId } } }),
      ) as Promise<ThreadDetail>,
    staleTime: 30_000,
  })

export const messageQuery = (id: string, messageId: string, headers = false) =>
  queryOptions({
    queryKey: mailKeys.message(id, messageId, headers),
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/messages/{messageId}", {
          params: { path: { id, messageId }, query: headers ? { include: "headers" } : {} },
        }),
      ) as Promise<MessageDetail>,
    // Signed links (rawUrl, attachmentUrls) expire; refetch well inside their lifetime.
    staleTime: 5 * 60_000,
  })

export const draftsQuery = (id: string, status: DraftStatus | "all") =>
  queryOptions({
    queryKey: mailKeys.drafts(id, status),
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/drafts", {
          params: { path: { id }, query: { ...(status === "all" ? {} : { status }), limit: "100" } },
        }),
      ) as Promise<DraftList>,
    staleTime: 30_000,
  })

export const identitiesQuery = queryOptions({
  queryKey: mailKeys.identities,
  queryFn: () => unwrap(api.GET("/v1/identities")) as Promise<IdentityList>,
  staleTime: 5 * 60_000,
})

export const correspondentsQuery = (id: string, q: string) =>
  queryOptions({
    queryKey: mailKeys.correspondents(id, q),
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/correspondents", {
          params: { path: { id }, query: { q, limit: "8" } },
        }),
      ) as Promise<CorrespondentList>,
    staleTime: 60_000,
  })

/** Which mailboxes belong to agents (HAL-3460). A key without admin is refused; that just means no badges. */
export const agentsQuery = queryOptions({
  queryKey: mailKeys.agents,
  queryFn: () => unwrap(api.GET("/v1/agents")) as Promise<AgentList>,
  staleTime: 5 * 60_000,
  retry: false,
})

export const attentionQuery = queryOptions({
  queryKey: mailKeys.attention,
  queryFn: () => unwrap(api.GET("/v1/mail/attention")) as Promise<Attention>,
  staleTime: 60_000,
})

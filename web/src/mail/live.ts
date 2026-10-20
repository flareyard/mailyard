/**
 * The mailbox socket applied to the query cache (HANDOFF-mail §5, live-new-mail): `message.added` slides a
 * row into every list it belongs in, `threads.changed` moves rows in, out and in place, `drafts.changed`
 * updates the drafts lists and the open thread's drafts, `delivery.changed` updates a sent copy's
 * per-recipient table, `notes.changed` the open thread's notes and `labels.changed` the folder pane. Nothing
 * refetches a list. `useMailboxLive` (shared with the sidebar) already applies counts and resets.
 */
import { type QueryClient, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState, useSyncExternalStore } from "react"
import type { LiveFrame, LiveStatus } from "../live/socket.ts"
import { useMailboxLive } from "../live/useMailboxLive.ts"
import type { LiveNote } from "./context.tsx"
import {
  applyDraftsToDetail,
  applyDraftsToList,
  applyNotesToDetail,
  applyThreadsToPages,
  applyThreadToDetail,
} from "./logic.ts"
import { mailKeys } from "./queries.ts"
import type {
  Draft,
  DraftStatus,
  FoldersBody,
  ListQuery,
  MessageDetail,
  Thread,
  ThreadDetail,
} from "./types.ts"

/* Rows marked New for a moment after they arrive live (`.tr.is-new`). */
const fresh = new Map<string, number>()
const freshListeners = new Set<() => void>()
let freshVersion = 0
export function markFresh(threadId: string) {
  fresh.set(threadId, Date.now())
  freshVersion++
  for (const l of freshListeners) l()
  setTimeout(() => {
    fresh.delete(threadId)
    freshVersion++
    for (const l of freshListeners) l()
  }, 2600)
}
export const isFresh = (threadId: string) => fresh.has(threadId)
export const useFreshVersion = () =>
  useSyncExternalStore(
    (l) => {
      freshListeners.add(l)
      return () => freshListeners.delete(l)
    },
    () => freshVersion,
    () => freshVersion,
  )

type Pages = Parameters<typeof applyThreadsToPages>[0]

/** Applies one frame to the cache. Exported for the tests. */
export function applyFrame(qc: QueryClient, mailboxId: string, f: LiveFrame): void {
  const threadsInto = (changed: Thread[], removed: string[]) => {
    for (const [key, data] of qc.getQueriesData<Pages>({ queryKey: mailKeys.threadLists(mailboxId) })) {
      const q = (key[3] ?? {}) as ListQuery
      const next = applyThreadsToPages(data, q, changed, removed)
      if (next !== data) qc.setQueryData(key, next)
    }
    for (const t of changed)
      qc.setQueryData<ThreadDetail>(mailKeys.thread(mailboxId, t.id), (d) => applyThreadToDetail(d, t))
  }
  switch (f.type) {
    case "message.added": {
      const thread = f.thread as Thread | undefined
      if (!thread) return
      threadsInto([thread], (f.removedThreadIds as string[] | undefined) ?? [])
      markFresh(thread.id)
      // The open conversation needs the full message (auth, attachments), which the frame doesn't carry.
      qc.invalidateQueries({ queryKey: mailKeys.thread(mailboxId, thread.id), exact: true })
      return
    }
    case "threads.changed":
      threadsInto(
        (f.threads as Thread[] | undefined) ?? [],
        (f.removedThreadIds as string[] | undefined) ?? [],
      )
      return
    case "drafts.changed":
    case "draft.due": {
      const drafts = (f.type === "draft.due" ? [f.draft] : (f.drafts ?? [])) as Draft[]
      const removed = (f.removedDraftIds as string[] | undefined) ?? []
      for (const [key, data] of qc.getQueriesData<{ drafts: Draft[] }>({
        queryKey: mailKeys.draftLists(mailboxId),
      })) {
        const status = (key[3] ?? "all") as DraftStatus | "all"
        qc.setQueryData(key, applyDraftsToList(data, status, drafts, removed))
      }
      for (const [key, data] of qc.getQueriesData<ThreadDetail>({
        queryKey: ["mailboxes", mailboxId, "thread"],
      }))
        qc.setQueryData(key, applyDraftsToDetail(data, drafts, removed))
      return
    }
    case "delivery.changed": {
      const messageId = f.messageId as string
      const recipients = f.recipients as NonNullable<MessageDetail["delivery"]>["recipients"]
      for (const [key, data] of qc.getQueriesData<MessageDetail>({
        queryKey: mailKeys.messages(mailboxId),
      })) {
        if (!data || data.id !== messageId || !data.delivery) continue
        qc.setQueryData(key, { ...data, delivery: { ...data.delivery, recipients } })
      }
      return
    }
    case "notes.changed": {
      const threadId = f.threadId as string
      const notes = (f.notes ?? []) as { id: string; author: string; body: string; createdAt: number }[]
      const key = mailKeys.thread(mailboxId, threadId)
      const { detail, unknownAuthor } = applyNotesToDetail(
        qc.getQueryData<ThreadDetail>(key),
        threadId,
        notes,
      )
      if (detail) qc.setQueryData(key, detail)
      if (unknownAuthor) qc.invalidateQueries({ queryKey: key, exact: true })
      return
    }
    case "labels.changed": {
      const labels = f.labels as FoldersBody["labels"]
      qc.setQueryData<FoldersBody>(mailKeys.folders(mailboxId), (old) => (old ? { ...old, labels } : old))
      return
    }
    default:
      return
  }
}

/** The socket for the open mailbox, applied to the cache; returns its status and the last resume note. */
export function useMailLive(
  mailboxId: string,
  onExtra?: (f: LiveFrame) => void,
): { status: LiveStatus; note: LiveNote; clearNote: () => void } {
  const qc = useQueryClient()
  const [note, setNote] = useState<LiveNote>(null)
  const onFrame = useCallback(
    (f: LiveFrame) => {
      if (f.type === "resumed") {
        const replayed = Number(f.replayed ?? 0)
        if (replayed > 0) setNote({ kind: "resumed", replayed })
      } else if (f.type === "reset") setNote({ kind: "reset" })
      applyFrame(qc, mailboxId, f)
      onExtra?.(f)
    },
    [qc, mailboxId, onExtra],
  )
  const status = useMailboxLive(mailboxId, onFrame)
  const clearNote = useCallback(() => setNote(null), [])
  return { status, note, clearNote }
}

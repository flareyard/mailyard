/**
 * Bulk actions on threads (`POST …/threads/bulk`), optimistic: every list and the open thread move first,
 * the call follows, a refusal puts everything back and says why, and a success offers Undo (the inverse
 * call) in a toast. The live socket's `threads.changed` then confirms what the server did.
 */
import { type QueryClient, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { ApiError, api, unwrap } from "../api/client.ts"
import { applyThreadsToPages, type BulkExtra, bulkWords, inverseBulk, optimisticThread } from "./logic.ts"
import { mailKeys } from "./queries.ts"
import { toast } from "./toasts.tsx"
import type { BulkAction, ListQuery, Thread, ThreadDetail, ThreadPage } from "./types.ts"

type Pages = { pages: ThreadPage[]; pageParams: unknown[] }

/** Every thread summary the cache holds for these ids (lists first, then details). */
export function cachedThreads(qc: QueryClient, mailboxId: string, ids: readonly string[]): Thread[] {
  const want = new Set(ids)
  const found = new Map<string, Thread>()
  for (const [, data] of qc.getQueriesData<Pages>({ queryKey: mailKeys.threadLists(mailboxId) }))
    for (const p of data?.pages ?? [])
      for (const t of p.threads) if (want.has(t.id) && !found.has(t.id)) found.set(t.id, t)
  for (const id of ids) {
    if (found.has(id)) continue
    const d = qc.getQueryData<ThreadDetail>(mailKeys.thread(mailboxId, id))
    if (d) found.set(id, d.thread)
  }
  return ids.map((id) => found.get(id)).filter((t): t is Thread => Boolean(t))
}

/** Writes optimistic summaries into every list and detail; returns a function that restores the snapshot. */
function applyOptimistic(qc: QueryClient, mailboxId: string, next: Thread[], removed: string[]) {
  const snapshot = [
    ...qc.getQueriesData({ queryKey: mailKeys.threadLists(mailboxId) }),
    ...qc.getQueriesData({ queryKey: ["mailboxes", mailboxId, "thread"] }),
  ]
  for (const [key, data] of qc.getQueriesData<Pages>({ queryKey: mailKeys.threadLists(mailboxId) })) {
    const q = (key[3] ?? {}) as ListQuery
    qc.setQueryData(key, applyThreadsToPages(data, q, next, removed))
  }
  for (const t of next)
    qc.setQueryData<ThreadDetail>(mailKeys.thread(mailboxId, t.id), (d) => (d ? { ...d, thread: t } : d))
  return () => {
    for (const [key, data] of snapshot) qc.setQueryData(key, data)
  }
}

export type BulkOptions = {
  quiet?: boolean
  labelName?: string
  noUndo?: boolean
  /** Summaries to start from when the cache no longer holds them (an Undo restoring rows that left). */
  threads?: readonly Thread[]
}

export function useBulk(mailboxId: string) {
  const qc = useQueryClient()
  const run = useCallback(
    async (
      action: BulkAction,
      threadIds: readonly string[],
      extra: BulkExtra = {},
      opts: BulkOptions = {},
    ) => {
      if (!threadIds.length) return false
      const cached = cachedThreads(qc, mailboxId, threadIds)
      const known = new Map([...(opts.threads ?? []), ...cached].map((t) => [t.id, t]))
      const before = threadIds.map((id) => known.get(id)).filter((t): t is Thread => Boolean(t))
      const next: Thread[] = []
      const removed: string[] = []
      for (const t of before) {
        const o = optimisticThread(t, action, extra)
        if (o) next.push(o)
        else removed.push(t.id)
      }
      const restore = applyOptimistic(qc, mailboxId, next, removed)
      try {
        await unwrap(
          api.POST("/v1/mailboxes/{id}/threads/bulk", {
            params: { path: { id: mailboxId } },
            body: {
              threadIds: [...threadIds],
              action,
              ...(extra.labelId ? { labelId: extra.labelId } : {}),
              ...(extra.folder ? { folder: extra.folder } : {}),
              ...(extra.until ? { until: extra.until } : {}),
              ...(action === "assign" ? { assignee: extra.assignee ?? null } : {}),
            },
          }),
        )
      } catch (e) {
        restore()
        toast({
          title: "That didn’t go through",
          sub:
            e instanceof ApiError
              ? `${e.status}: ${e.message}${e.requestId ? ` · ${e.requestId}` : ""}`
              : "Mailyard couldn’t be reached.",
          tone: "error",
        })
        return false
      }
      qc.invalidateQueries({ queryKey: mailKeys.folders(mailboxId), exact: true })
      if (!opts.quiet) {
        const inverse = opts.noUndo ? null : inverseBulk(before, action, extra)
        toast({
          title: bulkWords(action, threadIds.length, extra, opts.labelName),
          ...(inverse?.length
            ? {
                action: {
                  label: "Undo",
                  onClick: () => {
                    for (const inv of inverse)
                      if (inv.threadIds.length)
                        void run(inv.action, inv.threadIds, inv.extra, { quiet: true, threads: before })
                  },
                },
              }
            : {}),
        })
      }
      return true
    },
    [qc, mailboxId],
  )
  return run
}

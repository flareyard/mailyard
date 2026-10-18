/**
 * The full-window composer, mounted once under /mail. It also owns what outlives one composer: Z undoes the
 * open undo window from anywhere in Mail, and sends queued while offline go out when the connection is back,
 * with the same idempotency keys so a retry is never a second email.
 */
import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { mailKeys } from "../queries.ts"
import { dismissToast, toast } from "../toasts.tsx"
import type { DraftCreate, DraftPatch } from "../types.ts"
import { createDraft, saveDraft, sendDraft } from "./api.ts"
import { Composer, runUndo } from "./Composer.tsx"
import { refusalFrom } from "./logic.ts"
import { dropQueued, getUndoWindow, readQueue, updateQueued } from "./sendState.ts"
import { useComposeState } from "./store.ts"

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))
}

/** Sends what was queued offline, oldest first. Exported for the tests. */
export async function flushQueue(
  onSent?: (to: string) => void,
  onFailed?: (to: string, why: string) => void,
) {
  for (const q of readQueue().sort((a, b) => a.queuedAt - b.queuedAt)) {
    try {
      let draftId = q.draftId
      if (!draftId && q.create) {
        const d = await createDraft(q.mailboxId, q.create.body as DraftCreate, q.create.key)
        draftId = d.id
        updateQueued(q.id, { draftId, create: null })
      } else if (draftId && q.patch) {
        await saveDraft(q.mailboxId, draftId, q.patch as DraftPatch)
        updateQueued(q.id, { patch: null })
      }
      if (!draftId) {
        dropQueued(q.id)
        continue
      }
      await sendDraft(q.mailboxId, draftId, q.send, q.sendKey)
      dropQueued(q.id)
      onSent?.(q.to)
    } catch (e) {
      if (e instanceof TypeError) return // still offline: try again on the next `online`
      dropQueued(q.id)
      const r = refusalFrom(e)
      onFailed?.(q.to, `${r.notice.lead} ${r.notice.body}`.trim())
    }
  }
}

export function ComposerHost() {
  const state = useComposeState()
  const qc = useQueryClient()

  // Z: undo the last send while its window is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "z" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || typing(e.target)) return
      const w = getUndoWindow()
      if (!w) return
      e.preventDefault()
      dismissToast(w.toastId)
      void runUndo()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // The offline queue: on load and whenever the browser comes back online.
  useEffect(() => {
    const run = () =>
      void flushQueue(
        (to) => {
          toast({ title: `Sent to ${to}`, sub: "It was queued while you were offline." })
          qc.invalidateQueries({ queryKey: mailKeys.mailboxes })
        },
        (to, why) => toast({ title: `The queued message to ${to} didn’t send`, sub: why, tone: "error" }),
      )
    if (navigator.onLine && readQueue().length) run()
    window.addEventListener("online", run)
    return () => window.removeEventListener("online", run)
  }, [qc])

  if (!state.window) return null
  return (
    <Composer key={`w-${state.seq}-${state.window.draftId ?? ""}`} request={state.window} variant="window" />
  )
}

/**
 * The list and the reader together, with what joins them: the keyboard (HANDOFF-mail §6, j/k, e, #, s, l,
 * v, a, r, f, /, x and the mailbox g-chords), the pickers, and what happens to the open thread when an
 * action moves it out of the list (the next one opens, like a queue).
 */
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { num } from "../lib/format.ts"
import { useBulk } from "./actions.ts"
import { openCompose, openReply } from "./compose/store.ts"
import { useMail } from "./context.tsx"
import {
  MAIL_CHORDS,
  mailKey,
  optimisticThread,
  threadMatches,
  validateListSearch,
  validateReaderSearch,
} from "./logic.ts"
import { Picker, type PickerKind, type PickerState } from "./Pickers.tsx"
import { mailKeys } from "./queries.ts"
import { Reader, ReaderEmpty } from "./Reader.tsx"
import { clearSelection, getSelection, setSelection, toggleSelected } from "./selection.ts"
import { type BulkCmd, ThreadList, useListRows } from "./ThreadList.tsx"
import type { BulkAction, ThreadDetail } from "./types.ts"

const typingIn = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))
}
const overlayOpen = () =>
  Boolean(document.querySelector('[aria-modal="true"], .lightbox, .compose.is-window'))

export function ListAndReader({ threadId }: { threadId?: string }) {
  const mail = useMail()
  const { mailboxId, access } = mail
  const raw = useSearch({ strict: false }) as Record<string, unknown>
  const q = validateListSearch(raw)
  const rs = validateReaderSearch(raw)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { rows, threads } = useListRows(mailboxId, q)
  const bulk = useBulk(mailboxId)
  const [cursorId, setCursorId] = useState<string | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const ids = rows.map((r) => r.id)
  const openIndex = threadId ? ids.indexOf(threadId) : -1
  const total = num(threads.data?.pages[0]?.total)

  const open = useCallback(
    (id: string) =>
      navigate({
        to: "/mail/$mailboxId/threads/$threadId",
        params: { mailboxId, threadId: id },
        search: q as never,
      }),
    [navigate, mailboxId, q],
  )
  const toList = useCallback(
    () => navigate({ to: "/mail/$mailboxId", params: { mailboxId }, search: q as never }),
    [navigate, mailboxId, q],
  )

  /** What an action applies to: the selection, else the open thread, else the cursor row. */
  const targets = useCallback((): string[] => {
    const sel = getSelection()
    if (sel.size) return [...sel]
    if (threadId) return [threadId]
    return cursorId ? [cursorId] : []
  }, [threadId, cursorId])

  const act = useCallback(
    async (action: BulkAction) => {
      const t = targets()
      if (!t.length || !access.write) return
      // If the open thread leaves this list, open the next one (or the previous, or the list).
      let next: string | undefined
      if (threadId && t.includes(threadId)) {
        const d = qc.getQueryData<ThreadDetail>(mailKeys.thread(mailboxId, threadId))
        const after = d ? optimisticThread(d.thread, action) : null
        const leaves = !after || (!q.q && !threadMatches(after, q))
        if (leaves) {
          const remaining = ids.filter((id) => !t.includes(id))
          const i = ids.indexOf(threadId)
          next =
            ids.slice(i + 1).find((id) => remaining.includes(id)) ??
            ids
              .slice(0, i)
              .reverse()
              .find((id) => remaining.includes(id))
          if (next) open(next)
          else toList()
        }
      }
      clearSelection()
      await bulk(action, t)
    },
    [targets, access.write, threadId, qc, mailboxId, q, ids, open, toList, bulk],
  )

  const pick = useCallback(
    (kind: PickerKind, left = 12, messageId?: string, where?: "reader" | "list") => {
      const t = targets()
      if (!t.length) return
      if (kind !== "more" && !access.write) return
      const last = threadId
        ? qc.getQueryData<ThreadDetail>(mailKeys.thread(mailboxId, threadId))?.messages.at(-1)?.id
        : undefined
      setPicker({
        kind,
        ids: t,
        where: where ?? (threadId && !getSelection().size ? "reader" : "list"),
        left,
        ...(messageId || last ? { messageId: messageId ?? last } : {}),
      })
    },
    [targets, access.write, threadId, qc, mailboxId],
  )

  const nav = useCallback(
    (dir: 1 | -1) => {
      if (!ids.length) return
      if (threadId) {
        const i = ids.indexOf(threadId)
        const n = ids[i < 0 ? 0 : i + dir]
        if (n) open(n)
        return
      }
      const i = cursorId ? ids.indexOf(cursorId) : -1
      const n = ids[Math.min(ids.length - 1, Math.max(0, i < 0 ? 0 : i + dir))]
      if (n) setCursorId(n)
    },
    [ids, threadId, cursorId, open],
  )

  const onBulk = useCallback(
    (cmd: BulkCmd) => {
      if (cmd.startsWith("act:")) void act(cmd.slice(4) as BulkAction)
      else pick(cmd as PickerKind, 12, undefined, "list")
    },
    [act, pick],
  )

  // The mailbox's keys. Capture phase, so G then I/S/T/D/A and C win over the shell's inside a mailbox.
  useEffect(() => {
    let chord = 0
    const onKey = (e: KeyboardEvent) => {
      if (typingIn(e.target) || overlayOpen() || picker) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (Date.now() - chord < 1200) {
        chord = 0
        const c = MAIL_CHORDS[e.key.toLowerCase()]
        if (c) {
          e.preventDefault()
          e.stopImmediatePropagation()
          if (c.to === "drafts") navigate({ to: "/mail/$mailboxId/drafts", params: { mailboxId } })
          else navigate({ to: "/mail/$mailboxId", params: { mailboxId }, search: c.search as never })
        }
        return
      }
      if (e.key === "g") {
        chord = Date.now()
        return
      }
      if (e.key === "c" && !e.shiftKey) {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (access.write) openCompose({ mailboxId, mode: "new" })
        return
      }
      const k = mailKey(e)
      if (!k) return
      const last = threadId
        ? qc.getQueryData<ThreadDetail>(mailKeys.thread(mailboxId, threadId))?.messages.at(-1)?.id
        : undefined
      const handled = (() => {
        switch (k) {
          case "next":
            nav(1)
            return true
          case "prev":
            nav(-1)
            return true
          case "open":
            if (!threadId && cursorId) open(cursorId)
            return Boolean(!threadId && cursorId)
          case "back":
            if (threadId) toList()
            return Boolean(threadId)
          case "escape":
            if (getSelection().size) {
              clearSelection()
              return true
            }
            return false
          case "select": {
            const id = cursorId ?? threadId
            if (id) toggleSelected(id)
            return Boolean(id)
          }
          case "selectAll":
            setSelection(getSelection().size === ids.length ? [] : ids, ids[0] ?? null)
            return true
          case "archive":
            void act(q.folder === "trash" ? "inbox" : "archive")
            return true
          case "delete":
            void act(q.folder === "trash" ? "delete" : "trash")
            return true
          case "spam":
            void act(q.folder === "spam" ? "notSpam" : "spam")
            return true
          case "star": {
            const d = threadId
              ? qc.getQueryData<ThreadDetail>(mailKeys.thread(mailboxId, threadId))
              : undefined
            void act(d?.thread.starred && !getSelection().size ? "unstar" : "star")
            return true
          }
          case "unread":
            void act("unread")
            return true
          case "read":
            void act("read")
            return true
          case "snooze":
          case "label":
          case "move":
          case "assign":
            pick(k, k === "snooze" ? 96 : k === "label" ? 150 : k === "move" ? 190 : 230)
            return true
          case "reply":
          case "replyAll":
          case "forward":
            if (!threadId || !last || !access.write) return false
            openReply({ mailboxId, threadId, messageId: last, mode: k })
            return true
          case "note":
            if (!threadId) return false
            noteRef.current?.focus()
            return true
          case "search":
            searchRef.current?.focus()
            return true
          case "help":
            navigate({
              to: ".",
              search: ((p: Record<string, unknown>) => ({ ...p, sheet: "keys" })) as never,
            })
            return true
          default:
            return false
        }
      })()
      if (handled) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [
    picker,
    navigate,
    mailboxId,
    access.write,
    threadId,
    qc,
    nav,
    cursorId,
    open,
    toList,
    ids,
    act,
    q.folder,
    pick,
  ])

  const pickerNode = picker ? <Picker state={picker} onClose={() => setPicker(null)} /> : null
  const position = {
    index: openIndex,
    total: total ?? (rows.length || null),
    prev: openIndex > 0 ? ids[openIndex - 1] : undefined,
    next: openIndex >= 0 ? ids[openIndex + 1] : undefined,
  }
  return (
    <>
      <ThreadList
        q={q}
        openId={threadId}
        cursorId={cursorId}
        setCursorId={setCursorId}
        onBulk={onBulk}
        searchRef={searchRef}
        pickerSlot={picker?.where === "list" ? pickerNode : null}
      />
      {threadId ? (
        <Reader
          key={threadId}
          threadId={threadId}
          q={q}
          rs={rs}
          position={position}
          actions={{ act: (a) => void act(a), pick: (k, l, m) => pick(k, l, m, "reader"), nav }}
          pickerSlot={picker?.where === "reader" ? pickerNode : null}
          noteRef={noteRef}
        />
      ) : (
        <ReaderEmpty state={threads.isError ? "error" : rows.length ? "idle" : "empty"} />
      )}
    </>
  )
}

/**
 * What happened after Send, kept outside any one composer: the open undo window (Z undoes it from anywhere
 * in Mail), drafts waiting for a person's approval (HAL-3460), and sends queued while offline. The queue is
 * kept in localStorage so a reload doesn't lose a reply written on a train.
 */
import type { SendBody } from "../types.ts"
import type { ComposeRequest } from "./store.ts"

export type UndoWindow = {
  mailboxId: string
  draftId: string
  until: number
  reopen: ComposeRequest
  toastId: string
}

let undo: UndoWindow | null = null
export const setUndoWindow = (w: UndoWindow | null) => {
  undo = w
}
export const getUndoWindow = (now = Date.now()) => (undo && undo.until > now ? undo : null)

const approvals = new Map<string, string>()
/** Marks a draft as held for approval (approval id), so reopening it says so. */
export const markAwaitingApproval = (draftId: string, approvalId: string) =>
  approvals.set(draftId, approvalId)
export const awaitingApproval = (draftId: string | undefined) =>
  draftId ? (approvals.get(draftId) ?? null) : null

/* ───────────── Offline queue ───────────── */

export type QueuedSend = {
  id: string
  mailboxId: string
  /** The draft, once it exists on the server. */
  draftId: string | null
  /** The create call's body and key, when the draft was never saved. */
  create: { body: Record<string, unknown>; key: string } | null
  /** The latest edits, applied before sending. */
  patch: Record<string, unknown> | null
  send: SendBody
  sendKey: string
  to: string
  subject: string
  queuedAt: number
  threadId: string | null
}

const KEY = "mailyard-send-queue"
const listeners = new Set<() => void>()

export function readQueue(): QueuedSend[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as QueuedSend[]) : []
  } catch {
    return []
  }
}

function writeQueue(q: QueuedSend[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(q))
  } catch {}
  for (const l of listeners) l()
}

export const enqueueSend = (s: QueuedSend) => writeQueue([...readQueue().filter((x) => x.id !== s.id), s])
export const dropQueued = (id: string) => writeQueue(readQueue().filter((x) => x.id !== id))
export const updateQueued = (id: string, patch: Partial<QueuedSend>) =>
  writeQueue(readQueue().map((x) => (x.id === id ? { ...x, ...patch } : x)))
export const onQueueChange = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/* ───────────── The undo window preference ───────────── */

const UNDO_KEY = "mailyard-undo-seconds"
export function undoSecondsPref(): 0 | 10 {
  try {
    return localStorage.getItem(UNDO_KEY) === "0" ? 0 : 10
  } catch {
    return 10
  }
}
export function setUndoSecondsPref(v: 0 | 10) {
  try {
    localStorage.setItem(UNDO_KEY, String(v))
  } catch {}
}

/**
 * Which composer is open: the full window (new message, or a reply popped out with ⇧C) and the inline reply
 * at the end of a thread. A tiny external store, so the reader, the keyboard, the shell's Compose button
 * (`/mail?compose=1`) and the composer itself agree without prop drilling.
 */
import { useSyncExternalStore } from "react"
import type { Party } from "../types.ts"

export type ComposeMode = "new" | "reply" | "replyAll" | "forward"

export type ComposeRequest = {
  /** The mailbox the draft lives in (and the default From). */
  mailboxId: string
  mode: ComposeMode
  /** For reply, reply all and forward: the message answered and its thread. */
  threadId?: string
  messageId?: string
  /** Resume an existing draft instead of creating one. */
  draftId?: string
  /** Prefilled recipients (e.g. Compose from a contact). */
  to?: Party[]
  subject?: string
}

type State = { window: ComposeRequest | null; inline: ComposeRequest | null; seq: number }

let state: State = { window: null, inline: null, seq: 0 }
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => {
  state = { ...state, ...next, seq: state.seq + 1 }
  for (const l of listeners) l()
}

/** Opens the full-window composer. */
export const openCompose = (req: ComposeRequest) => set({ window: req })
/** Opens the inline reply under a thread (reply, reply all, forward). */
export const openReply = (req: ComposeRequest & { threadId: string }) => set({ inline: req })
/** Moves the inline reply into the window (⇧C pops it out), keeping its draft. */
export const popOutReply = (draftId?: string) =>
  state.inline
    ? set({ window: { ...state.inline, ...(draftId ? { draftId } : {}) }, inline: null })
    : undefined
export const closeCompose = () => set({ window: null })
export const closeReply = () => set({ inline: null })

export const getComposeState = () => state

export const useComposeState = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
    () => state,
  )

/** Test hook. */
export const resetCompose = () => set({ window: null, inline: null })

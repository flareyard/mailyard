/**
 * The thread list's selection (`.tr.is-checked`, the bulk bar): one store, so the list, the bulk bar, the
 * keyboard and the phone's `.mail.is-selecting` agree. Cleared whenever the list changes.
 */
import { useSyncExternalStore } from "react"

let selected: ReadonlySet<string> = new Set()
let anchor: string | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export const getSelection = () => selected
export const getAnchor = () => anchor

export function setSelection(ids: Iterable<string>, nextAnchor: string | null = anchor) {
  selected = new Set(ids)
  anchor = nextAnchor
  emit()
}

export function toggleSelected(id: string) {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  setSelection(next, id)
}

export const clearSelection = () => {
  if (selected.size || anchor) setSelection([], null)
}

export const useSelection = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => selected,
    () => selected,
  )

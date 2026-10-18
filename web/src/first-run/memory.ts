/**
 * What this browser remembers about setup, per workspace: steps skipped, whether the checklist was started
 * and handed over, the last test send's id, when mail was turned on, the routing result of the mailbox it
 * created. A per-viewer convenience only: every step's status comes from live data, and the page renders
 * correctly when storage is empty, blocked or throws.
 */
import { useCallback, useSyncExternalStore } from "react"
import { parseSetupMemory, type SetupMemory } from "./logic.ts"

const key = (workspaceId: string) => `mailyard-setup:${workspaceId}`
const listeners = new Set<() => void>()
/** Kept in memory too, so the page behaves the same when localStorage refuses the write. */
const cache = new Map<string, { raw: string | null; value: SetupMemory }>()

function read(workspaceId: string): SetupMemory {
  let raw: string | null = cache.get(workspaceId)?.raw ?? null
  try {
    raw = localStorage.getItem(key(workspaceId)) ?? raw
  } catch {}
  const hit = cache.get(workspaceId)
  if (hit && hit.raw === raw) return hit.value
  const value = parseSetupMemory(raw)
  cache.set(workspaceId, { raw, value })
  return value
}

function write(workspaceId: string, next: SetupMemory) {
  const raw = JSON.stringify(next)
  cache.set(workspaceId, { raw, value: next })
  try {
    localStorage.setItem(key(workspaceId), raw)
  } catch {}
  for (const l of listeners) l()
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith("mailyard-setup:")) fn()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener("storage", onStorage)
  }
}

const EMPTY: SetupMemory = {}

export function useSetupMemory(workspaceId: string | undefined) {
  const memory = useSyncExternalStore(
    subscribe,
    () => (workspaceId ? read(workspaceId) : EMPTY),
    () => EMPTY,
  )
  const update = useCallback(
    (fn: (m: SetupMemory) => SetupMemory) => {
      if (workspaceId) write(workspaceId, fn(read(workspaceId)))
    },
    [workspaceId],
  )
  return [memory, update] as const
}

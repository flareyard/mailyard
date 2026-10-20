/**
 * Toasts (design: `.toasts > .toast`): short confirmations after an action, with an optional undo. A module
 * store, so any handler can call `toast(…)` without threading a context; each section layout mounts one
 * `<Toaster />`.
 */
import { type ReactNode, useSyncExternalStore } from "react"
import { Icon } from "../ui/icons.tsx"

export type Toast = {
  id: number
  title: ReactNode
  sub?: ReactNode
  tone?: "ok" | "warn" | "bad"
  action?: { label: string; run: () => void }
}

let items: Toast[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export function toast(t: Omit<Toast, "id">, ms = 5000): number {
  const id = ++seq
  items = [...items.slice(-2), { ...t, id }]
  emit()
  if (ms > 0) setTimeout(() => dismiss(id), ms)
  return id
}

export function dismiss(id: number) {
  items = items.filter((t) => t.id !== id)
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function Toaster() {
  const list = useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  )
  if (!list.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div className="toast" key={t.id}>
          <Icon
            name={t.tone === "bad" ? "x-circle" : t.tone === "warn" ? "warn" : "check-circle"}
            className={t.tone ?? "ok"}
          />
          <span className="grow">
            {t.title}
            {t.sub ? <span className="toast-sub">{t.sub}</span> : null}
          </span>
          {t.action ? (
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                t.action?.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button className="icon-btn" type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  )
}

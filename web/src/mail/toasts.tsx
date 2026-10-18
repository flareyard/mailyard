/**
 * Mail's toasts (`.toasts > .toast`, HANDOFF-mail §4): what a bulk action did with an Undo, the 10 s undo
 * send with its countdown, a copied link. One store, so the list, the reader and the composer share it.
 */
import { useEffect, useState, useSyncExternalStore } from "react"
import { Icon } from "../ui/icons.tsx"

export type Toast = {
  id: string
  title: string
  sub?: string
  /** An Undo (or other) action on the toast. */
  action?: { label: string; onClick: () => void; shortcut?: string }
  /** When the toast ends, epoch ms: a countdown and the `.toast-timer` bar show until then. */
  until?: number
  /** Countdown text: "Sending in {n} s". `{n}` is replaced by the seconds left. */
  countdown?: string
  /** Called once when `until` passes without the action being taken. */
  onExpire?: () => void
  tone?: "error"
  /** Set by `toast()`: when it appeared, for the timer bar. */
  start?: number
}

let toasts: Toast[] = []
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export function toast(t: Omit<Toast, "id"> & { id?: string }): string {
  const id = t.id ?? `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  toasts = [...toasts.filter((x) => x.id !== id), { ...t, id, start: Date.now() }].slice(-4)
  emit()
  if (!t.until) setTimeout(() => dismissToast(id), 6000)
  return id
}

export function dismissToast(id: string) {
  const before = toasts.length
  toasts = toasts.filter((t) => t.id !== id)
  if (toasts.length !== before) emit()
}

export const useToasts = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => toasts,
    () => toasts,
  )

/** Test hooks: the current toasts, and a clean start. */
export const getToasts = () => toasts

export const resetToasts = () => {
  toasts = []
  emit()
}

function ToastItem({ t }: { t: Toast }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!t.until) return
    const timer = setInterval(() => {
      const n = Date.now()
      setNow(n)
      if (t.until && n >= t.until) {
        clearInterval(timer)
        dismissToast(t.id)
        t.onExpire?.()
      }
    }, 250)
    return () => clearInterval(timer)
  }, [t])
  const left = t.until ? Math.max(0, Math.ceil((t.until - now) / 1000)) : 0
  const span = t.until ? Math.max(1, t.until - (t.start ?? now)) : 1
  const share = t.until ? Math.max(0, Math.min(1, (t.until - now) / span)) : 0
  return (
    <div className="toast" role={t.tone === "error" ? "alert" : "status"}>
      <span className="grow" style={{ minWidth: 0 }}>
        {t.title}
        {t.countdown && t.until ? (
          <span className="toast-sub" data-undo-count>
            {t.countdown.replace("{n}", String(left))}
          </span>
        ) : t.sub ? (
          <span className="toast-sub">{t.sub}</span>
        ) : null}
        {t.until ? (
          <span className="toast-timer" aria-hidden="true">
            <span
              style={{
                display: "block",
                height: "100%",
                width: `${share * 100}%`,
                background: "var(--background-100)",
                transition: "width .25s linear",
              }}
            />
          </span>
        ) : null}
      </span>
      {t.action ? (
        <button
          className="btn btn-sm btn-secondary"
          type="button"
          onClick={() => {
            dismissToast(t.id)
            t.action?.onClick()
          }}
          {...(t.action.shortcut
            ? { title: `${t.action.label} · ${t.action.shortcut}`, "aria-keyshortcuts": t.action.shortcut }
            : {})}
        >
          {t.action.label}
        </button>
      ) : null}
      <button className="icon-btn" type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
        <Icon name="x" />
      </button>
    </div>
  )
}

export function MailToasts() {
  const list = useToasts()
  if (!list.length) return null
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  )
}

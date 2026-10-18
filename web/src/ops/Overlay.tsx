/**
 * Sheets and drawers for the ops screens (design: `.sheet-wrap > .scrim + .sheet`, `.drawer(.drawer-wide)`).
 * Both trap focus, close on Escape and on the scrim, lock the page's scroll, and hand focus back to whatever
 * opened them. A sheet confirms or collects; a drawer shows detail beside the list it came from.
 *
 *   <Sheet title="Rotate “Billing worker”" sub="…" wide onClose={close} foot={<>…buttons…</>}>…</Sheet>
 */
import "./ops-kit.css"
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react"
import { Icon } from "../ui/icons.tsx"

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"

function useOverlay(onClose: () => void) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const returnTo = document.activeElement
    const first = box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? null
    const fallback = box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null
    ;(first ?? fallback ?? box.current)?.focus({ preventScroll: true })
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true })
    }
  }, [])
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      close.current()
      return
    }
    if (e.key !== "Tab" || !box.current) return
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    )
    const head = items[0]
    const tail = items[items.length - 1]
    if (!head || !tail) return
    if (e.shiftKey && document.activeElement === head) {
      e.preventDefault()
      tail.focus()
    } else if (!e.shiftKey && document.activeElement === tail) {
      e.preventDefault()
      head.focus()
    }
  }
  return { box, onKeyDown }
}

type Props = {
  title: ReactNode
  sub?: ReactNode
  /** Above the title: pills such as "Planned · HAL-…" or a state. */
  kicker?: ReactNode
  onClose: () => void
  foot?: ReactNode
  children: ReactNode
  wide?: boolean
  /** The endpoint behind the sheet, kept as data-endpoint like the designs. */
  endpoint?: string
  odId?: string
}

export function Sheet({ title, sub, kicker, onClose, foot, children, wide, endpoint, odId }: Props) {
  const id = useId()
  const { box, onKeyDown } = useOverlay(onClose)
  return (
    <div
      className="sheet-wrap"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-t`}
      data-endpoint={endpoint}
      data-od-id={odId}
      onKeyDown={onKeyDown}
    >
      <div className="scrim" style={{ zIndex: 0 }} onClick={onClose} aria-hidden="true" />
      <div
        className={`sheet${wide ? " sheet-wide" : ""}`}
        style={{ position: "relative", zIndex: 1 }}
        ref={box}
        tabIndex={-1}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <div className="stack stack-4" style={{ minWidth: 0 }}>
            {kicker ? <span className="cluster">{kicker}</span> : null}
            <h2 className="t-h2" id={`${id}-t`}>
              {title}
            </h2>
            {sub ? <p className="hint">{sub}</p> : null}
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {foot ? <div className="sheet-foot">{foot}</div> : null}
      </div>
    </div>
  )
}

export function Drawer({ title, sub, kicker, onClose, foot, children, wide, endpoint, odId }: Props) {
  const id = useId()
  const { box, onKeyDown } = useOverlay(onClose)
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} data-od-id={odId} onKeyDown={onKeyDown}>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className={`drawer${wide ? " drawer-wide" : ""}`}
        ref={box}
        tabIndex={-1}
        data-endpoint={endpoint}
      >
        <div className="drawer-head">
          <div className="stack stack-4" style={{ minWidth: 0 }}>
            {kicker ? <span className="cluster">{kicker}</span> : null}
            <h2 className="t-h2" id={`${id}-t`}>
              {title}
            </h2>
            {sub ? <span className="t-small muted">{sub}</span> : null}
          </div>
          <button
            className="icon-btn"
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-tip="Close · esc"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {foot ? <div className="drawer-foot">{foot}</div> : null}
      </aside>
    </div>
  )
}

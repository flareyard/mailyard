/**
 * Pieces every Audience, Campaigns and Automations screen shares, in the designs' classes (HANDOFF-audience §4):
 * the page head, the sample-data marker, the Planned marker, the URL line, sheets and drawers with focus
 * handling, and the object header's back link. Everything the first run already built (error callouts, copy
 * buttons, field errors, clocks, two-step confirms) is re-exported from there, so there's one of each.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useLocation } from "@tanstack/react-router"
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { meQuery } from "../../auth/session.ts"
import { fixturesEnabled } from "../../fixtures/mode.ts"
import { Icon } from "../../ui/icons.tsx"
import { can, type Permission, whoCanDo } from "./perm.ts"

export {
  ApiErrorCallout,
  ConfirmButton,
  CopyButton,
  describe,
  FieldError,
  useEvery,
  useNow,
} from "../../first-run/ui.tsx"

/** The signed-in caller and a permission check, for gating controls with `Gated`. */
export function useCan(p: Permission, action: string) {
  const me = useQuery(meQuery).data
  return { allowed: can(me, p), who: whoCanDo(me, p, action), me }
}

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="page-head" data-od-id="page-head">
      <div>
        <h1 data-od-id="page-title">{title}</h1>
        {sub ? <p className="sub">{sub}</p> : null}
      </div>
      <div className="cluster cluster-12">
        <SampleMarker />
        {actions}
      </div>
    </div>
  )
}

/** Shown only in fixture mode, where every name and figure is the designs' sample data. */
export function SampleMarker() {
  if (!fixturesEnabled()) return null
  return (
    <span className="pill pill-sample sample-marker" data-od-id="sample-data-marker">
      <Icon name="info" />
      Sample data
      <span className="sr-only">: Every name and figure on this screen is fixture data.</span>
    </span>
  )
}

/** The dashed “Planned · HAL-…” marker on a control or panel whose endpoint isn't built yet. */
export function Planned({ issue, what }: { issue: string; what?: string }) {
  return (
    <span className="pill pill-ahead" data-od-id="ahead-marker">
      Planned · {issue}
      <span className="sr-only">: {what ?? "this needs an API route that isn’t built yet."}</span>
    </span>
  )
}

/** “This view is a link”: the list's current URL, copyable, so every list is visibly a URL. */
export function UrlLine({ label = "This view is a link:" }: { label?: string }) {
  const loc = useLocation()
  const href = `${loc.pathname}${loc.searchStr ?? ""}`.replace(/[?&]fx=[^&]*/, "").replace(/\?$/, "")
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="urlline" data-od-id="url-line">
      <Icon name="link" />
      <span>{label}</span>
      <code className="mono" data-url-line>
        {href}
      </code>
      <button
        className="copy-btn"
        type="button"
        aria-label={copied ? "Copied" : "Copy link to this view"}
        onClick={async () => {
          try {
            await navigator.clipboard?.writeText(`${window.location.origin}${href}`)
            setCopied(true)
          } catch {}
        }}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  )
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="backlink" to={to} data-od-id="backlink">
      <Icon name="chevron-left" />
      {children}
    </Link>
  )
}

/** Keeps Tab inside a dialog and closes it on Escape; focus returns to where it was when it closes. */
function useDialogFocus(onClose: () => void) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const returnTo = document.activeElement
    // The first field to fill, else the first action, else the close button: never the close button first.
    const q = (sel: string) => box.current?.querySelector<HTMLElement>(sel) ?? null
    const first =
      q("[autofocus]") ??
      q(
        ".sheet-body input:not([type=hidden]):not([disabled]):not([readonly]), .sheet-body select:not([disabled]), .sheet-body textarea:not([disabled]), .drawer-body input:not([type=hidden]):not([disabled]), .drawer-body select:not([disabled]), .drawer-body textarea:not([disabled])",
      ) ??
      q(".sheet-foot button:not([disabled]), .drawer-foot button:not([disabled])") ??
      q("button:not([disabled]), a[href]")
    first?.focus({ preventScroll: true })
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true })
    }
  }, [])
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      close.current()
      return
    }
    if (e.key !== "Tab" || !box.current) return
    const items = [
      ...box.current.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']",
      ),
    ].filter((el) => el.offsetParent !== null)
    const firstEl = items[0]
    const lastEl = items[items.length - 1]
    if (!firstEl || !lastEl) return
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault()
      lastEl.focus()
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault()
      firstEl.focus()
    }
  }
  return { box, onKeyDown }
}

/**
 * A sheet: a modal on desktop, a bottom sheet on a phone (`.sheet-wrap > .scrim + .sheet`). Esc and the scrim
 * close it, Tab stays inside, and focus goes back to the control that opened it.
 */
export function Sheet({
  title,
  sub,
  onClose,
  children,
  footer,
  wide,
  endpoint,
  odId,
  head,
}: {
  title: ReactNode
  sub?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  endpoint?: string
  odId?: string
  /** Extra content in the head, beside the title (a pill). */
  head?: ReactNode
}) {
  const id = useId()
  const { box, onKeyDown } = useDialogFocus(onClose)
  return (
    <div
      className="sheet-wrap"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-t`}
      data-od-id={odId}
      data-endpoint={endpoint}
      onKeyDown={onKeyDown}
    >
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div
        className={`sheet${wide ? " sheet-wide" : ""}`}
        ref={box}
        style={{ position: "relative", zIndex: 61 }}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <h2 className="t-h2" id={`${id}-t`}>
              {title}
            </h2>
            {sub ? (
              <p className="muted" style={{ marginTop: 4 }}>
                {sub}
              </p>
            ) : null}
            {head}
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

/** A drawer from the right (`.drawer`), with the same focus handling as a sheet. */
export function Drawer({
  title,
  sub,
  onClose,
  children,
  footer,
  endpoint,
  odId,
}: {
  title: ReactNode
  sub?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  endpoint?: string
  odId?: string
}) {
  const id = useId()
  const { box, onKeyDown } = useDialogFocus(onClose)
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} onKeyDown={onKeyDown}>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" ref={box} data-od-id={odId} data-endpoint={endpoint}>
        <div className="drawer-head">
          <div className="stack stack-4" style={{ minWidth: 0 }}>
            <h2 className="t-h2" id={`${id}-t`}>
              {title}
            </h2>
            {sub ? <span className="t-small muted">{sub}</span> : null}
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </aside>
    </div>
  )
}

/** A skeleton table body in the final layout, for list loading states. */
export function SkeletonRows({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="stack stack-12" aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={r} className="cluster cluster-16" style={{ flexWrap: "nowrap" }}>
          {Array.from({ length: cols }, (_, c) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
              key={c}
              className="sk sk-text"
              style={{ flex: c === 0 ? "2 1 0" : "1 1 0", width: "auto" }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The designed empty state: an icon, a heading, one sentence and the one action. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  odId,
}: {
  icon: Parameters<typeof Icon>[0]["name"]
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  odId?: string
}) {
  return (
    <div className="empty" data-od-id={odId ?? "empty-state"}>
      <span className="empty-icon">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  )
}

/** The status words every list uses and the pill each one wears (`spill(status)` in the designs). */
const PILL: Record<string, string> = {
  subscribed: "pill-pass",
  unconfirmed: "pill-info",
  unsubscribed: "pill-neutral",
  bounced: "pill-fail",
  complained: "pill-fail",
  suppressed: "pill-warn",
  draft: "pill-neutral",
  scheduled: "pill-info",
  sending: "pill-info",
  paused: "pill-warn",
  sent: "pill-pass",
  cancelled: "pill-neutral",
  live: "pill-pass",
  active: "pill-pass",
  running: "pill-info",
  waiting: "pill-info",
  queued: "pill-neutral",
  completed: "pill-pass",
  done: "pill-pass",
  exited: "pill-neutral",
  failed: "pill-fail",
  finishing: "pill-warn",
  retired: "pill-neutral",
  archived: "pill-neutral",
}

export const pillClass = (status: string) => PILL[status] ?? "pill-neutral"

export function StatusPill({ status, label }: { status: string; label?: ReactNode }) {
  return (
    <span className={`pill ${pillClass(status)}`}>
      <span className="dot" />
      {label ?? status.replace(/^./, (c) => c.toUpperCase()).replace(/_/g, " ")}
    </span>
  )
}

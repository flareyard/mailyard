/**
 * The frame every mailbox page shares (HANDOFF-mail §4 "Mailbox page"): the wide pane with its bar (back to
 * the folders on a phone, the folder drawer on a tablet, the breadcrumb, the sample marker in fixture mode),
 * then `.mpage > .mpage-inner` with the page head. Also the sheet frame the page sheets use.
 */
import { Link } from "@tanstack/react-router"
import { type ReactNode, useEffect, useId, useRef } from "react"
import { fixturesEnabled } from "../../fixtures/mode.ts"
import { Icon } from "../../ui/icons.tsx"
import { useMail } from "../context.tsx"
import "./pages.css"

export const pageKeys = {
  rules: (id: string) => ["mailboxes", id, "rules"] as const,
  senders: (id: string) => ["mailboxes", id, "senders"] as const,
  imageSenders: (id: string) => ["mailboxes", id, "image-senders"] as const,
  imports: (id: string) => ["mailboxes", id, "imports"] as const,
  import: (id: string, importId: string) => ["mailboxes", id, "imports", importId] as const,
  exports: (id: string) => ["mailboxes", id, "exports"] as const,
  smartFolders: (id: string) => ["mailboxes", id, "smart-folders"] as const,
}

export function SampleMarker({
  what = "Every name and figure on this screen is fixture data.",
}: {
  what?: string
}) {
  if (!fixturesEnabled()) return null
  return (
    <span className="pill pill-sample sample-marker">
      Sample data<span className="sr-only">: {what}</span>
    </span>
  )
}

export function MailPage({
  label,
  crumb,
  title,
  sub,
  actions,
  children,
}: {
  label: string
  /** The breadcrumb after the mailbox: a string, or links. */
  crumb: ReactNode
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const { mailboxId, local, openFolders } = useMail()
  return (
    <section className="mail-reader" aria-label={label}>
      <div className="rd-bar" role="toolbar" aria-label={label}>
        <Link
          className="icon-btn only-phone"
          to="/mail/$mailboxId/folders"
          params={{ mailboxId }}
          aria-label="Back to folders"
        >
          <Icon name="chevron-left" />
        </Link>
        <button
          className="icon-btn only-tablet"
          type="button"
          onClick={openFolders}
          aria-label="Show folders"
          title="Folders"
        >
          <Icon name="sidebar" />
        </button>
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/mail/$mailboxId" params={{ mailboxId }} className="mono">
            {local}
          </Link>
          <span aria-hidden="true">/</span>
          {crumb}
        </nav>
        <span style={{ marginLeft: "auto" }}>
          <SampleMarker />
        </span>
      </div>
      <div className="pane-scroll mpage">
        <div className="mpage-inner">
          <div className="mpage-head">
            <div>
              <h1>{title}</h1>
              {sub ? <p className="sub">{sub}</p> : null}
            </div>
            {actions ? <div className="cluster">{actions}</div> : null}
          </div>
          {children}
        </div>
      </div>
    </section>
  )
}

/** A modal sheet (`.sheet-wrap > .sheet`): Escape and the scrim close it, focus moves in and comes back. */
export function Sheet({
  title,
  hint,
  wide = true,
  onClose,
  foot,
  children,
  endpoint,
}: {
  title: ReactNode
  hint?: ReactNode
  wide?: boolean
  onClose: () => void
  foot?: ReactNode
  children: ReactNode
  endpoint?: string
}) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>(
      "input:not([readonly]),select,textarea,button:not(.sheet-close)",
    )
    ;(first ?? ref.current)?.focus()
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", esc)
    return () => {
      window.removeEventListener("keydown", esc)
      back?.focus?.()
    }
  }, [onClose])
  return (
    <div
      className="sheet-wrap"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-t`}
      data-endpoint={endpoint}
    >
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        className={`sheet${wide ? " sheet-wide" : ""}`}
        style={{ position: "relative", zIndex: 1 }}
        tabIndex={-1}
      >
        <div className="sheet-grip" />
        <div className="sheet-head">
          <div>
            <h2 className="t-h2" id={`${id}-t`}>
              {title}
            </h2>
            {hint ? (
              <p className="hint" style={{ marginTop: 4 }}>
                {hint}
              </p>
            ) : null}
          </div>
          <button className="icon-btn sheet-close" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {foot ? <div className="sheet-foot">{foot}</div> : null}
      </div>
    </div>
  )
}

/** The label tag used across the pages (`.ltag` with its colour dot). */
export function LabelTag({ name, color }: { name: string; color: string | null | undefined }) {
  return (
    <span className="ltag">
      <i className={`label-dot${color ? ` lc-${color}` : ""}`} aria-hidden="true" />
      {name}
    </span>
  )
}

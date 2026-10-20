/**
 * Small Mail pieces shared by the panes: avatars, label tags, highlighted text, delivery pills, the
 * sample-data marker, the agent badge and a popover menu hook. Class names are the design's.
 */
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react"
import { Icon } from "../ui/icons.tsx"
import { type MailIconName, MIcon } from "./icons.tsx"
import { cap, DELIVERY_TONE, highlightRuns, initials } from "./logic.ts"
import type { Label } from "./types.ts"

export function SampleMarker({
  what = "Every name and figure on this screen is fixture data.",
}: {
  what?: string
}) {
  return (
    <span className="pill pill-sample sample-marker">
      Sample data<span className="sr-only">: {what}</span>
    </span>
  )
}

/** The Agent badge (ops/settings/agent-in-mail): on an agent's mailbox in the sidebar, switcher and reader. */
export function AgentBadge({ name, short }: { name?: string; short?: boolean }) {
  return (
    <span className="agent-badge" title={name ? `Agent mailbox · ${name}` : "Agent mailbox"}>
      <Icon name="bot" className="icon-12" />
      {short || !name ? "Agent" : `Agent · ${name}`}
    </span>
  )
}

export function Who({
  name,
  address,
  us,
  lg,
  label,
  className,
}: {
  name?: string | null | undefined
  address?: string | undefined
  us?: boolean
  lg?: boolean
  label?: string
  className?: string
}) {
  return (
    <span
      className={`who${lg ? " who-lg" : ""}${us ? " is-us" : ""}${className ? ` ${className}` : ""}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {initials(name, address)}
    </span>
  )
}

export function LabelDot({ color }: { color: Label["color"] }) {
  return <i className={`label-dot${color ? ` lc-${color}` : ""}`} aria-hidden="true" />
}

export function LabelTag({ label, onRemove }: { label: Label; onRemove?: () => void }) {
  return (
    <span className={`ltag${onRemove ? " ltag-lg" : ""}`}>
      <LabelDot color={label.color} />
      {label.name}
      {onRemove ? (
        <button type="button" aria-label={`Remove label ${label.name}`} onClick={onRemove}>
          <Icon name="x" />
        </button>
      ) : null}
    </span>
  )
}

/** Text with the API's `\u0002…\u0003` matches as <mark>. */
export function Hl({ text }: { text: string }) {
  return (
    <>
      {highlightRuns(text).map((r, i) =>
        r.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and static per render
          <mark key={i}>{r.text}</mark>
        ) : (
          // Plain runs stay text nodes, so a clamped snippet never holds a wrapped inline box.
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and static per render
          <Fragment key={i}>{r.text}</Fragment>
        ),
      )}
    </>
  )
}

const PILL: Record<string, string> = {
  pass: "pill-pass",
  warn: "pill-warn",
  fail: "pill-fail",
  neutral: "pill-neutral",
}

export function DeliveryPill({ status, n, small }: { status: string; n?: number; small?: boolean }) {
  const tone = DELIVERY_TONE[status] ?? "neutral"
  return (
    <span className={`pill ${PILL[tone]}`} style={small ? { height: 20 } : undefined}>
      <span className="dot" />
      {n && n > 1 ? `${n} ${status}` : cap(status)}
    </span>
  )
}

/** A popover menu's open state, closed by Escape or a click outside. */
export function useMenu<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false)
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onEsc, true)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onEsc, true)
    }
  }, [open])
  return { open, setOpen, ref }
}

/** An icon button whose tooltip names its shortcut: `title="Archive · E"` and `aria-keyshortcuts`. */
export function ToolBtn({
  icon,
  label,
  keys,
  onClick,
  className,
  pressed,
  disabled,
  children,
  ...rest
}: {
  icon: MailIconName
  label: string
  keys?: string
  onClick?: () => void
  className?: string
  pressed?: boolean
  disabled?: boolean
  children?: ReactNode
  "aria-haspopup"?: "menu"
  "aria-expanded"?: boolean
}) {
  return (
    <button
      className={`icon-btn${className ? ` ${className}` : ""}`}
      type="button"
      aria-label={label}
      title={keys ? `${label} · ${keys}` : label}
      {...(keys ? { "aria-keyshortcuts": keys.replace("⇧ ", "Shift+").replace(" then ", " ") } : {})}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      disabled={disabled}
      onClick={onClick}
      {...rest}
    >
      <MIcon name={icon} />
      {children}
    </button>
  )
}

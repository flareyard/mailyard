/**
 * Small pieces every ops screen uses: section tabs, the Built / Planned / Sample markers, `<Time>`, the locked
 * section, typed confirmation, capability-gated controls and the page head.
 */
import "./ops-kit.css"
import { Link } from "@tanstack/react-router"
import { type ComponentProps, type ReactNode, useId, useState } from "react"
import { useCapabilities } from "../auth/capabilities.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { fmtAgo, toDate } from "../lib/format.ts"
import { Icon, type IconName } from "../ui/icons.tsx"
import { isRecent, utcFull, utcTime } from "./format.ts"

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
      <div style={{ minWidth: 0 }}>
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

export type Tab = {
  to: string
  label: string
  count?: number | null
  /** Exact match only (for an index tab whose path prefixes the others). */
  exact?: boolean
  /** A tab whose feature is unbuilt: shown, not a link, with the reason as its tooltip. */
  disabled?: string
}

/** Section tabs (`nav.page-tabs > a.ptab[aria-current=page]`), under the page head. */
export function PageTabs({ label, tabs }: { label: string; tabs: Tab[] }) {
  return (
    <nav className="page-tabs" aria-label={label} data-od-id="section-tabs">
      {tabs.map((t) =>
        t.disabled ? (
          // biome-ignore lint/a11y/useSemanticElements: the design's disabled tab (span.ptab[aria-disabled]) stays focusable for its reason
          <span
            key={t.to}
            className="ptab"
            role="link"
            aria-disabled="true"
            data-tip={t.disabled}
            tabIndex={0}
          >
            {t.label}
          </span>
        ) : (
          <Link
            key={t.to}
            className="ptab"
            to={t.to}
            activeOptions={{ exact: Boolean(t.exact), includeSearch: false }}
            activeProps={{ "aria-current": "page" }}
          >
            {t.label}
            {t.count ? <span className="nav-count">{t.count}</span> : null}
          </Link>
        ),
      )}
    </nav>
  )
}

export function BuiltPill({ issue }: { issue: string }) {
  return (
    <span className="pill pill-built" data-od-id="built-marker">
      <Icon name="check" className="icon-12" />
      Built · {issue}
    </span>
  )
}

export function PlannedPill({ issue, label = "Planned" }: { issue: string; label?: string }) {
  return (
    <span className="pill pill-proposal" data-od-id="proposed-marker">
      {label} · {issue}
      <span className="sr-only">. Filed as {issue}, not built yet.</span>
    </span>
  )
}

/** A time in UTC: relative under 7 days with the full time on hover, otherwise the date and time. */
export function Time({
  value,
  mode = "auto",
}: {
  value: number | string | null | undefined
  mode?: "auto" | "time" | "full"
}) {
  const d = toDate(value)
  if (!d) return <span className="muted">—</span>
  const text =
    mode === "time"
      ? utcTime(d.getTime())
      : mode === "full" || !isRecent(d.getTime())
        ? utcFull(d.getTime())
        : fmtAgo(d.getTime())
  return (
    <time dateTime={d.toISOString()} title={utcFull(d.getTime())}>
      {text}
    </time>
  )
}

/** A whole section the role can't open (`.locked`): what it holds, who can, and the way back. */
export function Locked({
  title,
  what,
  who,
  back = { to: "/", label: "Back to Overview", icon: "overview" },
}: {
  title: ReactNode
  what: ReactNode
  who: ReactNode
  back?: { to: string; label: string; icon: IconName }
}) {
  return (
    <div className="locked" data-od-id="no-permission-page">
      <span className="empty-icon">
        <Icon name="lock" />
      </span>
      <h2>{title}</h2>
      <p>{what}</p>
      <p>{who}</p>
      <Link className="btn btn-secondary" to={back.to}>
        <Icon name={back.icon} />
        {back.label}
      </Link>
    </div>
  )
}

/**
 * A typed confirmation (`.typed > input`): the destructive control stays aria-disabled until `match` is typed
 * exactly. Render-prop so the caller owns the button.
 */
export function TypedConfirm({
  match,
  label,
  children,
}: {
  match: string
  label?: ReactNode
  children: (ok: boolean) => ReactNode
}) {
  const id = useId()
  const [v, setV] = useState("")
  const ok = v.trim() === match
  return (
    <>
      <div className="typed">
        <label className="label" htmlFor={id}>
          {label ?? (
            <>
              Type <code>{match}</code> to confirm
            </>
          )}
        </label>
        <input
          className="input"
          id={id}
          value={v}
          onChange={(e) => setV(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-autofocus=""
        />
      </div>
      {children(ok)}
    </>
  )
}

/**
 * A control that waits on a route the backend hasn't shipped: live the moment `/openapi.json` lists it, until
 * then disabled with the reason and its issue. Never faked.
 */
export function NeedsRoute({
  method,
  path,
  issue,
  what,
  children,
  side,
}: {
  method: string
  path: string
  issue: string
  what: string
  children: ComponentProps<typeof Gated>["children"]
  side?: "right" | "up"
}) {
  const caps = useCapabilities()
  const live = caps.has(method, path)
  return (
    <Gated
      allowed={live}
      reason={`${what} isn’t built yet`}
      who={`Planned · ${issue}. It turns on when ${method} ${path} ships.`}
      {...(side ? { side } : {})}
    >
      {children}
    </Gated>
  )
}

export function useRoute(method: string, path: string) {
  return useCapabilities().has(method, path)
}

/** Empty state block (`.empty`): what it's for and the one action that fills it. */
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div className="cluster">{action}</div> : null}
    </div>
  )
}

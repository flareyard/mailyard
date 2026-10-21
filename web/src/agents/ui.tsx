/**
 * The Agents section's head (founder, 2026-10-21: agents opened inside Settings, with its menu beside them).
 * Agents are a section of their own like Mail or Domains: a page head, then tabs for the agent mailboxes and
 * the approval queue. The plumbing agents use (MCP, OAuth apps, keys, linked apps) stays in Settings →
 * Integrations.
 */
import { Link, useLocation } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { SampleMarker } from "../audience/kit/ui.tsx"
import { Icon } from "../ui/icons.tsx"

const TABS = [
  { id: "mailboxes", label: "Agent mailboxes", to: "/agents" },
  { id: "approvals", label: "Approvals", to: "/agents/approvals" },
] as const

const tabFor = (path: string) => (path.startsWith("/agents/approvals") ? "approvals" : "mailboxes")

export function AgentsHead({
  title = "Agents",
  sub = "Agents with their own address on your domain: what each may do, what it did, and what waits for a person.",
  crumb = false,
  actions,
  count,
}: {
  title?: ReactNode
  sub?: ReactNode
  /** On an agent's own page: a breadcrumb back to the list. */
  crumb?: boolean
  actions?: ReactNode
  /** Sends waiting for approval, shown on the Approvals tab. */
  count?: number
}) {
  const { pathname } = useLocation()
  const on = tabFor(pathname)
  return (
    <>
      <div className="page-head" data-od-id="page-head">
        <div style={{ minWidth: 0 }}>
          {crumb ? (
            <nav className="crumbs" aria-label="Breadcrumb">
              <Link to="/agents">Agents</Link>
              <Icon name="chevron-right" />
            </nav>
          ) : null}
          <h1 data-od-id="page-title">{title}</h1>
          {sub ? <p className="sub">{sub}</p> : null}
        </div>
        <div className="cluster cluster-12">
          <SampleMarker />
          {actions}
        </div>
      </div>
      {crumb ? null : (
        <nav className="page-tabs" aria-label="Agent sections" data-od-id="section-tabs">
          {TABS.map((t) => (
            <Link
              key={t.id}
              className="ptab"
              to={t.to}
              activeOptions={{ exact: true, includeSearch: false }}
              activeProps={{}}
              aria-current={t.id === on ? "page" : undefined}
              data-od-id={`tab-${t.id}`}
            >
              {t.label}
              {t.id === "approvals" && count ? <span className="nav-count">{count}</span> : null}
            </Link>
          ))}
        </nav>
      )}
    </>
  )
}

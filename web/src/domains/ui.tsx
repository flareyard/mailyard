/** Small pieces the Domains screens share: state pills and words, the zone-token note, the section head. */

import { Link, useLocation } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { SampleMarker } from "../ops/kit.tsx"
import { Icon, type IconName } from "../ui/icons.tsx"
import { type State, TOKEN_ISSUE, TOKEN_PERMISSIONS, TOKEN_SECRET, type Tone } from "./logic.ts"

const PILL: Record<Tone, string> = {
  pass: "pill-pass",
  warn: "pill-warn",
  fail: "pill-fail",
  neutral: "pill-neutral",
  info: "pill-info",
}
const WORD_ICON: Record<Tone, IconName> = {
  pass: "check-circle",
  warn: "warn",
  fail: "x-circle",
  neutral: "circle",
  info: "info",
}
const WORD_CLASS: Record<Tone, string> = {
  pass: "status-pass",
  warn: "status-warn",
  fail: "status-fail",
  neutral: "status-idle",
  info: "status-info",
}

export function StatePill({ state, big }: { state: State; big?: boolean }) {
  return (
    <span className={`pill ${PILL[state.tone]}`} style={big ? { height: 28, fontSize: 13 } : undefined}>
      {state.spinner ? <span className="spinner" aria-hidden="true" /> : <span className="dot" />}
      {state.label}
    </span>
  )
}

export function StatusWord({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="status-word">
      <Icon name={WORD_ICON[tone]} className={WORD_CLASS[tone]} />
      {children}
    </span>
  )
}

/** The calm note shown wherever the zone token would add something (HANDOFF-ops §24). */
export function TokenNote({
  lead,
  detail = true,
  odId = "zone-token-note",
}: {
  lead: ReactNode
  detail?: boolean
  odId?: string
}) {
  return (
    <div className="token-note" data-od-id={odId} role="note">
      <Icon name="key" />
      <div>
        <b>{lead}</b>
        {detail ? (
          <p className="t-small muted" style={{ margin: "6px 0 0" }}>
            It’s an optional Worker secret, <span className="mono">{TOKEN_SECRET}</span>, with{" "}
            {TOKEN_PERMISSIONS}. Until it’s set, Mailyard checks every record against public DNS, as it does
            now. <span className="tag">Owner step · {TOKEN_ISSUE}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
}

type Section = "domains" | "dmarc" | "reputation" | "import"

const TABS: { id: Section; to: string; label: string }[] = [
  { id: "domains", to: "/domains", label: "Domains" },
  { id: "dmarc", to: "/domains/dmarc", label: "DMARC reports" },
  { id: "reputation", to: "/domains/reputation", label: "Reputation" },
  { id: "import", to: "/domains/import", label: "Import a domain" },
]

/** The section a path belongs to: a domain's own page counts as Domains. */
export function sectionFor(pathname: string): Section {
  const seg = pathname.replace(/\/+$/, "").split("/")[2]
  return seg === "dmarc" || seg === "reputation" || seg === "import" ? seg : "domains"
}

/**
 * The page head and section tabs every Domains page opens with (design: `.page-head`, `nav.page-tabs`). A
 * domain's page adds the breadcrumb and a monospace title.
 */
export function DomainsHead({
  title = "Domains",
  mono,
  sub,
  actions,
}: {
  title?: ReactNode
  /** A domain name as the title: breadcrumb back to the list, Departure Mono. */
  mono?: boolean
  sub?: ReactNode
  actions?: ReactNode
}) {
  const { pathname } = useLocation()
  const on = sectionFor(pathname)
  return (
    <>
      <div className="page-head" data-od-id="page-head">
        <div style={{ minWidth: 0 }}>
          {mono ? (
            <nav className="crumbs" aria-label="Breadcrumb">
              <Link to="/domains">Domains</Link>
              <Icon name="chevron-right" />
            </nav>
          ) : null}
          <h1 data-od-id="page-title" className={mono ? "mono-title" : undefined}>
            {title}
          </h1>
          {sub ? <p className="sub">{sub}</p> : null}
        </div>
        <div className="cluster cluster-12">
          <SampleMarker />
          {actions}
        </div>
      </div>
      <nav className="page-tabs" aria-label="Domain sections" data-od-id="section-tabs">
        {TABS.map((t) => (
          <Link
            key={t.id}
            className="ptab"
            to={t.to}
            // The router's own active state would mark Domains on every /domains/* page; the section decides.
            activeOptions={{ exact: true, includeSearch: false }}
            activeProps={{}}
            aria-current={t.id === on ? "page" : undefined}
            data-od-id={`tab-${t.id}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  )
}

/**
 * The app frame (HANDOFF §3): sidebar, top bar, global banners, content, phone bottom bar, the ⌘K palette and
 * the alerts drawer. Layout is the design's CSS: expanded at ≥1200 px, a 64 px rail at 768–1199, and under
 * 768 the sidebar hides and the bottom bar shows. `[` collapses or expands; the choice is remembered.
 */
import { useQueries, useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { type Me, useMe, useSessionActions } from "../auth/session.ts"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { num } from "../lib/format.ts"
import { foldersKey, useMailboxLive } from "../live/useMailboxLive.ts"
import { agentFor } from "../mail/logic.ts"
import { agentsQuery } from "../mail/queries.ts"
import { AgentBadge } from "../mail/ui.tsx"
import { Icon } from "../ui/icons.tsx"
import { Wordmark } from "../ui/Wordmark.tsx"
import { AlertsBell, AlertsDrawer } from "./AlertsDrawer.tsx"
import { Banners } from "./Banners.tsx"
import { CommandPalette } from "./CommandPalette.tsx"
import { SECTIONS } from "./nav.ts"
import { QuotaMeter } from "./QuotaMeter.tsx"
import { type Theme, useTheme } from "./theme.ts"

const SIDEBAR_KEY = "mailyard-sidebar"

export const mailboxesQuery = {
  queryKey: ["mailboxes"],
  queryFn: () => unwrap(api.GET("/v1/mailboxes")),
  staleTime: 60_000,
}

function readSidebar(): "collapsed" | "expanded" | undefined {
  try {
    const v = localStorage.getItem(SIDEBAR_KEY)
    return v === "collapsed" || v === "expanded" ? v : undefined
  } catch {
    return undefined
  }
}

export function AppFrame({
  title,
  crumbs,
  children,
}: {
  title?: string
  crumbs?: string[]
  children: ReactNode
}) {
  const me = useMe()
  const [sidebar, setSidebar] = useState(readSidebar)
  const [palette, setPalette] = useState(false)
  const [alerts, setAlerts] = useState(false)
  const navigate = useNavigate()

  const toggleSidebar = useCallback(() => {
    setSidebar((s) => {
      const wide = window.matchMedia("(min-width: 1200px)").matches
      const next = wide
        ? s === "collapsed"
          ? undefined
          : "collapsed"
        : s === "expanded"
          ? undefined
          : "expanded"
      try {
        if (next) localStorage.setItem(SIDEBAR_KEY, next)
        else localStorage.removeItem(SIDEBAR_KEY)
      } catch {}
      return next
    })
  }, [])

  // Keyboard: ⌘K / Ctrl K palette, [ sidebar, Shift A alerts, C compose, G then a letter to jump.
  useEffect(() => {
    let chord = 0
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette((p) => !p)
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (Date.now() - chord < 1200) {
        const s = SECTIONS.find((x) => x.chord === e.key.toLowerCase())
        chord = 0
        if (s) {
          e.preventDefault()
          navigate({ to: s.to })
        }
        return
      }
      if (e.key === "g") chord = Date.now()
      else if (e.key === "[") toggleSidebar()
      else if (e.key === "A" && e.shiftKey) setAlerts(true)
      else if (e.key === "c") navigate({ to: "/mail", search: { compose: 1 } as never })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate, toggleSidebar])

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div
        className="app"
        data-role={me.data?.role ?? "owner"}
        {...(sidebar ? { "data-sidebar": sidebar } : {})}
      >
        <Sidebar me={me.data} onToggle={toggleSidebar} />
        <div className="main">
          <header className="topbar">
            <div className="topbar-mobile-brand">
              <Wordmark small />
            </div>
            <div className="topbar-title">
              {me.data ? <span className="crumb">{me.data.workspace.name}</span> : null}
              {me.data ? (
                <span className="crumb" aria-hidden="true">
                  /
                </span>
              ) : null}
              {(crumbs ?? []).map((c) => (
                <span key={c} className="crumb">
                  {c}
                  <span aria-hidden="true"> / </span>
                </span>
              ))}
              <span>{title}</span>
            </div>
            <button
              className="search-trigger"
              type="button"
              onClick={() => setPalette(true)}
              aria-label="Search everything (⌘K)"
            >
              <Icon name="search" />
              <span className="grow">Search mail, contacts, campaigns…</span>
              <span className="kbd-group kbd-hint">
                <span className="kbd">⌘</span>
                <span className="kbd">K</span>
              </span>
            </button>
            <AlertsBell onOpen={() => setAlerts(true)} />
            <Link
              className="btn btn-primary compose-btn"
              to="/mail"
              search={{ compose: 1 } as never}
              title="Compose · C"
            >
              <Icon name="compose" />
              Compose
            </Link>
          </header>
          <Banners />
          <main className="content" id="main" tabIndex={-1}>
            {children}
          </main>
        </div>
        <BottomBar />
      </div>
      {palette ? <CommandPalette onClose={() => setPalette(false)} /> : null}
      {alerts ? <AlertsDrawer onClose={() => setAlerts(false)} /> : null}
    </>
  )
}

function Sidebar({ me, onToggle }: { me: Me | undefined; onToggle: () => void }) {
  const mailboxes = useQuery(mailboxesQuery)
  const path = useRouterState({ select: (s) => s.location.pathname })
  const boxes = (mailboxes.data?.mailboxes ?? []).filter((m) => m.holdsMail)
  // An agent's mailbox carries the Agent badge (HAL-3460; design ops/settings/agent-in-mail).
  const agents = useQuery(agentsQuery)
  const folders = useQueries({
    queries: boxes.map((b) => ({
      queryKey: foldersKey(b.id),
      queryFn: () =>
        unwrap(api.GET("/v1/mailboxes/{id}/folders", { params: { path: { id: b.id } } })) as Promise<{
          folders: { folder: string; unreadThreads: number | string }[]
        }>,
      staleTime: 5 * 60_000,
    })),
  })
  const unread = (i: number) =>
    num(folders[i]?.data?.folders.find((f) => f.folder === "inbox")?.unreadThreads) ?? 0
  const totalUnread = boxes.reduce((n, _, i) => n + unread(i), 0)
  const matches = (to: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`))
  // The most specific section wins, so Agents (/settings/integrations) doesn't also light up Settings.
  const current = SECTIONS.filter((s) => matches(s.to)).sort((a, b) => b.to.length - a.to.length)[0]?.to
  const isCurrent = (to: string) => to === current

  return (
    <aside
      className="sidebar"
      aria-label="Main"
      data-endpoint="GET /v1/me · GET /v1/mailboxes · ws /v1/mailboxes/{id}/live"
    >
      <div className="sb-head">
        <div className="sb-brand">
          <span className="hide-rail">
            <Wordmark />
          </span>
          <button
            className="icon-btn hide-rail"
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            title="Collapse sidebar · ["
          >
            <Icon name="sidebar" />
          </button>
          <button
            className="icon-btn rail-only"
            type="button"
            onClick={onToggle}
            aria-label="Expand sidebar"
            title="Expand sidebar · ["
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <WorkspaceSwitcher me={me} />
      </div>
      <nav className="sb-scroll" aria-label="Sections">
        <ul className="nav">
          {SECTIONS.map((s) => (
            <li key={s.to}>
              <Link
                className="nav-item"
                to={s.to}
                // The router only marks exact matches; which section a deeper page belongs to is isCurrent's call.
                activeOptions={{ exact: true, includeSearch: false }}
                {...(isCurrent(s.to) ? { "aria-current": "page" as const } : {})}
                title={`${s.label} · G then ${s.chord.toUpperCase()}`}
              >
                <Icon name={s.icon} />
                <span className="nav-label hide-rail">{s.label}</span>
                {s.to === "/mail" && totalUnread ? (
                  <span className="nav-count">
                    {totalUnread}
                    <span className="sr-only"> unread</span>
                  </span>
                ) : null}
              </Link>
              {s.to === "/mail" && boxes.length ? (
                <ul className="nav-sub" aria-label="Mailboxes">
                  {boxes.map((b, i) => (
                    <MailboxNavItem
                      key={b.id}
                      id={b.id}
                      address={b.address}
                      unread={unread(i)}
                      current={isCurrent(`/mail/${b.id}`)}
                      agent={agentFor(b.id, agents.data?.agents)?.name}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </nav>
      <div className="sb-foot">
        <QuotaMeter />
        <MeMenu me={me} />
      </div>
    </aside>
  )
}

function MailboxNavItem({
  id,
  address,
  unread,
  current,
  agent,
}: {
  id: string
  address: string
  unread: number
  current: boolean
  agent?: string | undefined
}) {
  useMailboxLive(id)
  const local = address.split("@")[0]
  return (
    <li>
      <Link
        className="nav-item"
        to="/mail/$mailboxId"
        params={{ mailboxId: id }}
        title={agent ? `${address} · agent mailbox (${agent})` : address}
        {...(current ? { "aria-current": "page" as const } : {})}
      >
        <span className="nav-label">{local}@</span>
        {agent ? <AgentBadge name={agent} short /> : null}
        {unread ? (
          <span className="nav-count">
            {unread}
            <span className="sr-only"> unread</span>
          </span>
        ) : null}
      </Link>
    </li>
  )
}

function useMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onEsc)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onEsc)
    }
  }, [open])
  return { open, setOpen, ref }
}

function WorkspaceSwitcher({ me }: { me: Me | undefined }) {
  const { open, setOpen, ref } = useMenu()
  const ws = me?.workspace
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="ws-switch"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={ws ? `${ws.name} · switch workspace` : "Workspace"}
      >
        <span className="ws-avatar" aria-hidden="true">
          {(ws?.name ?? "M").slice(0, 1).toUpperCase()}
        </span>
        <span className="ws-meta hide-rail">
          <span className="ws-name">{ws?.name ?? "Mailyard"}</span>
          {ws?.host ? <span className="ws-host">{ws.host}</span> : null}
        </span>
        <Icon name="updown" />
      </button>
      {open ? (
        <div
          className="menu"
          role="menu"
          aria-label="Workspaces"
          style={{ left: 0, top: "calc(100% + 6px)", width: 272 }}
        >
          <div className="menu-label">Workspaces you can open</div>
          {(me?.workspaces ?? (ws ? [ws] : [])).map((w) => (
            <a
              key={w.id}
              className="menu-item"
              role="menuitem"
              href={w.id === ws?.id ? "/" : `https://${w.host}`}
              {...(w.id === ws?.id ? { "aria-current": "true" as const } : {})}
            >
              <span className="ws-avatar" style={{ width: 22, height: 22, fontSize: 11 }}>
                {w.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="grow">
                {w.name}
                {w.host ? (
                  <span className="ws-host" style={{ display: "block" }}>
                    {w.host}
                  </span>
                ) : null}
              </span>
              {w.id === ws?.id ? <Icon name="check" /> : null}
            </a>
          ))}
          <div className="menu-sep" />
          <a
            className="menu-item"
            role="menuitem"
            href="https://app.flareyard.dev/apps"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="plus" />
            <span className="grow">Deploy another in Flareyard</span>
            <Icon name="external" />
          </a>
        </div>
      ) : null}
    </div>
  )
}

function MeMenu({ me }: { me: Me | undefined }) {
  const { open, setOpen, ref } = useMenu()
  const { theme, setTheme } = useTheme()
  const { signOut } = useSessionActions()
  const navigate = useNavigate()
  const name = me?.user?.name ?? me?.key?.name ?? (me?.via === "admin-key" ? "Admin key" : "Signed in")
  const sub = me?.user ? (me.role ?? "member") : `Key · ${(me?.scopes ?? []).join(", ") || "no scopes"}`
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="me"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={`${name} · ${sub}`}
      >
        <span className={`avatar${me?.user ? "" : " avatar-key"}`} aria-hidden="true">
          {me?.user ? me.user.name.slice(0, 1).toUpperCase() : <Icon name="key" />}
        </span>
        <span className="me-meta hide-rail">
          <span className="me-name">{name}</span>
          <span className="role">{sub}</span>
        </span>
        <Icon name="updown" />
      </button>
      {open ? (
        <div
          className="menu"
          role="menu"
          aria-label="Account"
          style={{ left: 0, bottom: "calc(100% + 6px)", width: 272 }}
        >
          <div className="menu-label">
            {me?.user ? me.user.email : me?.key ? `Signed in with ${me.key.prefix}…` : "Signed in"}
          </div>
          {!me?.user ? (
            <p className="t-small muted" style={{ padding: "0 12px 8px" }}>
              Access comes from your key’s scopes.
            </p>
          ) : null}
          <div className="menu-sep" />
          <div className="menu-label">Theme</div>
          {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg control is a styled div group, not a fieldset */}
          <div className="seg" role="group" aria-label="Theme" style={{ margin: "0 12px 8px" }}>
            {(["system", "light", "dark"] as Theme[]).map((t) => (
              <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
                {t === "system" ? "System" : t === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
          <div className="menu-sep" />
          <Link className="menu-item" role="menuitem" to="/settings">
            <Icon name="settings" />
            <span className="grow">Settings</span>
          </Link>
          <a className="menu-item" role="menuitem" href="/docs">
            <Icon name="file" />
            <span className="grow">Docs</span>
          </a>
          <button
            className="menu-item"
            role="menuitem"
            type="button"
            onClick={async () => {
              await signOut()
              navigate({ to: "/signed-out" })
            }}
          >
            <Icon name="logout" />
            <span className="grow">Sign out</span>
          </button>
          <div className="menu-foot">
            <a href="https://flareyard.dev" target="_blank" rel="noreferrer">
              A Flareyard app
            </a>
            {fixturesEnabled() ? <span className="pill pill-sample">Fixture mode</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function BottomBar() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const cur = (to: string) => (to === "/" ? path === "/" : path.startsWith(to))
  return (
    <nav className="bottombar" aria-label="Sections">
      <Link className="bb-item" to="/" {...(cur("/") ? { "aria-current": "page" as const } : {})}>
        <Icon name="overview" />
        <span>Overview</span>
      </Link>
      <Link className="bb-item" to="/mail" {...(cur("/mail") ? { "aria-current": "page" as const } : {})}>
        <Icon name="mail" />
        <span>Mail</span>
      </Link>
      <Link className="bb-compose" to="/mail" search={{ compose: 1 } as never} aria-label="Compose">
        <Icon name="compose" />
      </Link>
      <Link
        className="bb-item"
        to="/audience"
        {...(cur("/audience") ? { "aria-current": "page" as const } : {})}
      >
        <Icon name="audience" />
        <span>Audience</span>
      </Link>
      <Link
        className="bb-item"
        to="/settings"
        {...(cur("/settings") ? { "aria-current": "page" as const } : {})}
      >
        <Icon name="more" />
        <span>More</span>
      </Link>
    </nav>
  )
}

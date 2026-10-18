/**
 * The Transactional section frame (HANDOFF-ops §1): owners, admins and senders open it; agents and viewers get
 * the locked page (`transactional-viewer`). On a tab's root page (Messages, Templates, API keys, Webhooks,
 * Suppressions, Quick start) it draws the page head with that tab's line and action, then the section tabs.
 * Detail pages (a message, a template, a webhook, a suppression) draw their own head with breadcrumbs.
 *
 * A tab page can put its own buttons in the head with `<HeadActions>…</HeadActions>`.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, Outlet, useLocation } from "@tanstack/react-router"
import { createContext, Fragment, type ReactNode, useContext, useState } from "react"
import { createPortal } from "react-dom"
import { useMe } from "../auth/session.ts"
import { num } from "../lib/format.ts"
import { Locked, PageTabs, SampleMarker } from "../ops/kit.tsx"
import { canOpenTransactional } from "../ops/roles.ts"
import { Toaster } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelSkeleton } from "../ui/Panel.tsx"
import { webhooksQuery } from "./queries.ts"
import "./transactional.css"

type TabRoot = { path: string; sub: string; action?: ReactNode }

const TAB_ROOTS: TabRoot[] = [
  {
    path: "/transactional/messages",
    sub: "Every send from the API, campaigns, automations, mailboxes and test sends, with its delivery trail.",
    action: (
      <Link className="btn btn-secondary" to="/transactional/quickstart">
        <Icon name="code" />
        Quick start
      </Link>
    ),
  },
  {
    path: "/transactional/templates",
    sub: "Templates your app sends by name, versioned so a bad edit never reaches a customer.",
  },
  {
    path: "/transactional/keys",
    sub: "Keys your code uses. A secret key is shown once, when it’s created; we keep only its hash.",
  },
  {
    path: "/transactional/webhooks",
    sub: "Endpoints we POST signed events to, retried with backoff, then kept as dead letters you can replay.",
  },
  {
    path: "/transactional/suppressions",
    sub: "Addresses we won’t send to. Bounces and complaints land here on their own and are checked before every send, so blocked sends are never billed.",
  },
  {
    path: "/transactional/quickstart",
    sub: "Send from your code in five minutes. The API is Plunk-compatible, so existing Plunk code works with the base URL swapped.",
  },
]

const HeadSlot = createContext<HTMLElement | null>(null)

/** Buttons for the section head, from a tab page. Renders nothing on detail pages (they own their head). */
export function HeadActions({ children }: { children: ReactNode }) {
  const el = useContext(HeadSlot)
  return el ? createPortal(children, el) : null
}

export function TransactionalLayout() {
  const me = useMe()
  const { pathname } = useLocation()
  const path = pathname.replace(/\/+$/, "")
  const root = TAB_ROOTS.find((t) => t.path === path)
  const [slot, setSlot] = useState<HTMLElement | null>(null)

  if (me.isPending)
    return (
      <div className="ops">
        <PanelSkeleton rows={4} />
      </div>
    )
  if (!canOpenTransactional(me.data)) {
    const role = me.data?.role
    return (
      <div className="ops">
        <div className="page-head" data-od-id="page-head">
          <div style={{ minWidth: 0 }}>
            <h1 data-od-id="page-title">Transactional</h1>
          </div>
        </div>
        <Locked
          title={`Transactional isn’t part of the ${role ?? "key’s"} ${role ? "role" : "scopes"}`}
          what="It holds the message log, templates, API keys and webhooks. Delivery numbers are in Analytics, which you can open."
          who={
            role ? (
              <>
                <b>Owners, admins and senders</b> can open it. Ask an owner or admin to change your role in
                Settings → Members.
              </>
            ) : (
              <>
                It needs a key with the <b>read</b> scope, or the admin key.
              </>
            )
          }
        />
      </div>
    )
  }

  return (
    <HeadSlot.Provider value={slot}>
      <div className="ops">
        {root ? (
          <>
            <div className="page-head" data-od-id="page-head">
              <div style={{ minWidth: 0 }}>
                <h1 data-od-id="page-title">Transactional</h1>
                <p className="sub">{root.sub}</p>
              </div>
              <div className="cluster cluster-12" ref={setSlot}>
                <SampleMarker />
                {root.action}
              </div>
            </div>
            <TransactionalTabs />
          </>
        ) : null}
        <Outlet />
        <Toaster />
      </div>
    </HeadSlot.Provider>
  )
}

/** The section tabs. Webhooks counts the endpoints holding dead letters. */
export function TransactionalTabs() {
  const hooks = useQuery(webhooksQuery)
  const dead = (hooks.data?.webhooks ?? []).filter((w) => (num(w.deadLetters) ?? 0) > 0).length
  return (
    <PageTabs
      label="Transactional sections"
      tabs={[
        { to: "/transactional/messages", label: "Messages" },
        { to: "/transactional/templates", label: "Templates" },
        { to: "/transactional/keys", label: "API keys" },
        { to: "/transactional/webhooks", label: "Webhooks", count: dead || null },
        { to: "/transactional/suppressions", label: "Suppressions" },
        { to: "/transactional/quickstart", label: "Quick start" },
      ]}
    />
  )
}

/** The breadcrumb trail on a detail page's head. */
export function Crumbs({
  items,
}: {
  items: { to: string; label: string; search?: Record<string, string> }[]
}) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c) => (
        <Fragment key={`${c.to}:${c.label}`}>
          <Link to={c.to} {...(c.search ? { search: c.search } : {})}>
            {c.label}
          </Link>
          <Icon name="chevron-right" />
        </Fragment>
      ))}
    </nav>
  )
}

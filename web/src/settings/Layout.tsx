/**
 * The Settings frame (design: settings/*.html): the page head, the grouped sub-navigation and the page beside it.
 * Settings change how mail is received and sent for everyone, so only owners and admins open it
 * (settings-sender.html renders `.locked`); Your sessions is personal and stays open to every role.
 */
import { Link, Outlet, useLocation } from "@tanstack/react-router"
import { useMe } from "../auth/session.ts"
import { Locked, PageHead } from "../ops/kit.tsx"
import { canOpenAdmin } from "../ops/roles.ts"
import { Toaster } from "../ops/toast.tsx"
import { Icon, type IconName } from "../ui/icons.tsx"
import { PanelSkeleton } from "../ui/Panel.tsx"
import "./settings.css"

type Item = { to: string; label: string; icon: IconName; od: string; danger?: boolean; exact?: boolean }
const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "Mail",
    items: [
      { to: "/settings/mailboxes", label: "Mailboxes and addresses", icon: "mailbox", od: "mailboxes" },
      { to: "/settings/rules", label: "Rules", icon: "filter", od: "rules" },
      { to: "/settings/gmail-mode", label: "Gmail mode", icon: "gmail", od: "gmail" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { to: "/settings/sessions", label: "Your sessions", icon: "monitor", od: "sessions" },
      { to: "/settings/members", label: "Members and roles", icon: "users", od: "members" },
      { to: "/settings/brand", label: "Brand", icon: "brush", od: "brand" },
      { to: "/settings/tracking", label: "Tracking and compliance", icon: "shield", od: "tracking" },
    ],
  },
  {
    label: "Sending and apps",
    items: [
      { to: "/settings/sending", label: "Sending and governor", icon: "gauge", od: "sending" },
      { to: "/settings/ai", label: "AI", icon: "cpu", od: "ai" },
      {
        to: "/settings/integrations",
        label: "Agents and integrations",
        icon: "plug",
        od: "integrations",
        exact: true,
      },
      { to: "/settings/alerts", label: "Alerts", icon: "bell", od: "alerts" },
      { to: "/settings/integrations/approvals", label: "Approvals", icon: "check-circle", od: "approvals" },
    ],
  },
  {
    label: "Data",
    items: [
      { to: "/settings/data", label: "Import and export", icon: "database", od: "data" },
      { to: "/settings/audit", label: "Audit log", icon: "list", od: "audit" },
      { to: "/settings/danger", label: "Danger zone", icon: "octagon", od: "danger", danger: true },
    ],
  },
]

/** Pages every signed-in role may open (personal ones). */
const OPEN_TO_ALL = ["/settings/sessions"]

export function SettingsLayout() {
  const me = useMe()
  const { pathname } = useLocation()
  const open = OPEN_TO_ALL.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  const head = <PageHead title="Settings" sub="How this workspace receives, sends, and who can do what." />
  if (me.isPending)
    return (
      <div className="ops">
        {head}
        <PanelSkeleton rows={6} />
      </div>
    )
  if (!open && !canOpenAdmin(me.data)) {
    const role = me.data?.role
    return (
      <div className="ops">
        {head}
        <Locked
          title={role ? `Settings isn’t part of the ${role} role` : "Settings needs the admin scope"}
          what="Settings change how mail is received and sent for everyone: mailboxes, members, rules, domains’ mail and the danger zone. Your own sessions stay open to you."
          who={
            role ? (
              <>
                <b>Owners and admins</b> can open it. Ask an owner or admin to change your role in Settings →
                Members.
              </>
            ) : (
              <>
                Sign in with a key that has the <span className="mono">admin</span> scope, or the admin key.
              </>
            )
          }
        />
        <p className="t-small muted" style={{ marginTop: 12, textAlign: "center" }}>
          <Link className="link" to="/settings/sessions">
            Your sessions
          </Link>{" "}
          are always yours to manage.
        </p>
      </div>
    )
  }
  return (
    <div className="ops">
      {head}
      <div className="side-layout">
        <nav className="subnav" aria-label="Settings" data-od-id="settings-nav">
          {GROUPS.map((g) => (
            <SubnavGroup key={g.label} label={g.label} items={g.items} />
          ))}
        </nav>
        <div className="stack" style={{ minWidth: 0 }}>
          <Outlet />
        </div>
      </div>
      <Toaster />
    </div>
  )
}

function SubnavGroup({ label, items }: { label: string; items: Item[] }) {
  return (
    <>
      <span className="subnav-group">{label}</span>
      {items.map((i) => (
        <Link
          key={i.to}
          to={i.to}
          className={i.danger ? "is-danger" : undefined}
          data-od-id={`subnav-${i.od}`}
          activeOptions={{ exact: Boolean(i.exact), includeSearch: false }}
          activeProps={{ "aria-current": "page" }}
        >
          <Icon name={i.icon} />
          {i.label}
        </Link>
      ))}
    </>
  )
}

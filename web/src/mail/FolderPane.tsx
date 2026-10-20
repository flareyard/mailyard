/**
 * The folder pane (folders.html): the mailbox switcher, system and virtual folders with live counts, labels
 * with their colours, smart folders, a running import's card, and the mailbox pages. A drawer under 1280 px;
 * the root screen on a phone.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { useMe } from "../auth/session.ts"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { useMail } from "./context.tsx"
import { agentFor, validateListSearch } from "./logic.ts"
import { agentsQuery, attentionQuery, mailboxesQuery } from "./queries.ts"
import { AgentBadge, SampleMarker } from "./ui.tsx"

const KIND_WORD: Record<string, string> = {
  shared: "Shared mailbox",
  user: "Personal mailbox",
  group: "Group",
  alias: "Alias",
  catch_all: "Catch-all",
}

/** The caller's assignee id: threads are assigned to the calling key (a person's member id when signed in). */
export function useMyAssignee(): string | null {
  const me = useMe()
  if (!me.data) return null
  if (me.data.via === "admin-key") return "root"
  return me.data.key?.id ?? me.data.user?.id ?? null
}

function Count({ n, quiet, label }: { n: number | null | undefined; quiet?: boolean; label: string }) {
  if (!n) return null
  return (
    <span className={`nav-count${quiet ? " is-quiet" : ""}`}>
      {n}
      <span className="sr-only"> {label}</span>
    </span>
  )
}

export function FolderPane() {
  const mail = useMail()
  const { mailboxId, folders, labels, access } = mail
  const loc = useRouterState({ select: (s) => ({ path: s.location.pathname, search: s.location.search }) })
  const q = validateListSearch(loc.search as Record<string, unknown>)
  const base = `/mail/${mailboxId}`
  const sub = loc.path.startsWith(base) ? loc.path.slice(base.length) : ""
  const onList = sub === "" || sub === "/" || sub.startsWith("/threads/")
  const isCur = (match: boolean) => (match ? { "aria-current": "page" as const } : {})
  const count = (f: string) => folders?.folders.find((x) => x.folder === f)
  const views = folders?.views
  const myAssignee = useMyAssignee()

  const folderLink = (
    key: string,
    label: string,
    search: Record<string, unknown>,
    current: boolean,
    n?: { n: number | null | undefined; quiet?: boolean; label: string },
  ) => (
    <li key={key}>
      <Link
        className="nav-item fp-item"
        to="/mail/$mailboxId"
        params={{ mailboxId }}
        search={search as never}
        {...isCur(current)}
        onClick={mail.closeFolders}
      >
        <span className="nav-label">{label}</span>
        {n ? <Count {...n} /> : null}
      </Link>
    </li>
  )

  const plain = onList && !q.q && !q.labelId && !q.starred && !q.assignee
  return (
    <nav
      className="mail-folders"
      aria-label={`Folders in ${mail.address}`}
      data-endpoint="GET /v1/mailboxes · GET /v1/mailboxes/{id}/folders · GET /v1/mail/attention · ws /v1/mailboxes/{id}/live (labels.changed, counts)"
    >
      <div className="pane-scroll fp-scroll">
        {fixturesEnabled() ? (
          <div className="only-phone" style={{ justifyContent: "start", padding: "0 2px 8px" }}>
            <SampleMarker />
          </div>
        ) : null}
        <MailboxSwitcher />
        <ul className="nav fp-section" aria-label="Folders">
          {folderLink("inbox", "Inbox", {}, plain && !q.folder, {
            n: num(count("inbox")?.unreadThreads),
            label: "unread",
          })}
          <li>
            {myAssignee ? (
              <Link
                className="nav-item fp-item"
                to="/mail/$mailboxId"
                params={{ mailboxId }}
                search={{ assignee: myAssignee } as never}
                {...isCur(onList && q.assignee === myAssignee)}
                onClick={mail.closeFolders}
              >
                <span className="nav-label">Assigned to me</span>
                <Count n={num(views?.assignedToMe)} quiet label="threads" />
              </Link>
            ) : (
              <Gated
                allowed={false}
                side="right"
                reason="Assigned to me needs a signed-in person or key"
                who="This session has no identity to assign threads to."
              >
                {/* biome-ignore lint/a11y/useSemanticElements: the design's locked folder item is a focusable span, not a link that goes nowhere */}
                <span className="nav-item fp-item" role="link" tabIndex={0}>
                  <span className="nav-label">Assigned to me</span>
                </span>
              </Gated>
            )}
          </li>
          {folderLink("starred", "Starred", { starred: true }, onList && Boolean(q.starred), {
            n: num(views?.starred),
            quiet: true,
            label: "threads",
          })}
          {folderLink("snoozed", "Snoozed", { folder: "snoozed" }, plain && q.folder === "snoozed", {
            n: num(count("snoozed")?.threads),
            quiet: true,
            label: "threads",
          })}
          <li>
            <Link
              className="nav-item fp-item"
              to="/mail/$mailboxId/scheduled"
              params={{ mailboxId }}
              {...isCur(sub === "/scheduled")}
              onClick={mail.closeFolders}
            >
              <span className="nav-label">Scheduled</span>
              <Count n={num(views?.scheduled)} quiet label="scheduled" />
            </Link>
          </li>
          <li>
            <Link
              className="nav-item fp-item"
              to="/mail/$mailboxId/drafts"
              params={{ mailboxId }}
              {...isCur(sub === "/drafts")}
              onClick={mail.closeFolders}
            >
              <span className="nav-label">Drafts</span>
              <Count n={num(count("drafts")?.threads)} quiet label="drafts" />
            </Link>
          </li>
          {folderLink("sent", "Sent", { folder: "sent" }, plain && q.folder === "sent")}
          {folderLink("spam", "Spam", { folder: "spam" }, plain && q.folder === "spam", {
            n: num(count("spam")?.threads),
            quiet: true,
            label: "threads",
          })}
          {folderLink("trash", "Trash", { folder: "trash" }, plain && q.folder === "trash")}
          {folderLink("archive", "Archive", { folder: "archive" }, plain && q.folder === "archive")}
          {folderLink("all", "All mail", { folder: "all" }, plain && q.folder === "all", {
            n: num(views?.all.unreadThreads),
            quiet: true,
            label: "unread",
          })}
        </ul>

        <div className="fp-section">
          <div className="fp-section-head">
            <span>Labels</span>
            <Link
              className="icon-btn"
              to="."
              search={((p: Record<string, unknown>) => ({ ...p, sheet: "labels" })) as never}
              aria-label="New label"
              title="New label"
            >
              <Icon name="plus" />
            </Link>
          </div>
          {labels.length ? (
            <ul className="nav" aria-label="Labels">
              {labels.map((l) => {
                const unread = num(l.unreadThreads) ?? 0
                const total = num(l.threads) ?? 0
                return (
                  <li key={l.id}>
                    <Link
                      className="nav-item fp-item"
                      to="/mail/$mailboxId"
                      params={{ mailboxId }}
                      search={{ labelId: l.id } as never}
                      {...isCur(onList && q.labelId === l.id)}
                      onClick={mail.closeFolders}
                    >
                      <i className={`label-dot${l.color ? ` lc-${l.color}` : ""}`} aria-hidden="true" />
                      <span className="nav-label">{l.name}</span>
                      {unread ? (
                        <Count n={unread} label="unread" />
                      ) : (
                        <Count n={total} quiet label="threads" />
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          ) : folders ? (
            <p className="t-small muted" style={{ padding: "2px 10px 4px" }}>
              No labels yet.
            </p>
          ) : (
            <div className="stack stack-8" style={{ padding: "4px 10px" }} aria-hidden="true">
              <span className="sk sk-text" style={{ width: "70%" }} />
              <span className="sk sk-text" style={{ width: "55%" }} />
            </div>
          )}
          <Link
            className="link-quiet"
            to="."
            search={((p: Record<string, unknown>) => ({ ...p, sheet: "labels" })) as never}
            style={{ padding: "6px 10px" }}
          >
            Edit labels
          </Link>
        </div>

        <div className="fp-section" data-endpoint="GET /v1/mailboxes/{id}/folders → smartFolders">
          <div className="fp-section-head">
            <span>Smart folders</span>
            <Link
              className="icon-btn"
              to="."
              search={((p: Record<string, unknown>) => ({ ...p, sheet: "smart-folders" })) as never}
              aria-label="New smart folder"
              title="New smart folder"
            >
              <Icon name="plus" />
            </Link>
          </div>
          {folders?.smartFolders.length ? (
            <ul className="nav" aria-label="Smart folders">
              {folders.smartFolders.map((f) => (
                <li key={f.id}>
                  <Link
                    className="nav-item fp-item"
                    to="/mail/$mailboxId/search"
                    params={{ mailboxId }}
                    search={{ q: f.q } as never}
                    title={f.q}
                    {...isCur(sub === "/search" && q.q === f.q)}
                    onClick={mail.closeFolders}
                  >
                    <span className="nav-label">{f.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : folders ? (
            <p className="t-small muted" style={{ padding: "2px 10px 4px" }}>
              Save a search to keep it here.
            </p>
          ) : null}
          <Link
            className="link-quiet"
            to="."
            search={((p: Record<string, unknown>) => ({ ...p, sheet: "smart-folders" })) as never}
            style={{ padding: "6px 10px" }}
          >
            Edit smart folders
          </Link>
        </div>

        <ImportCard />

        <div className="fp-section">
          <ul className="nav" aria-label="Mailbox settings">
            {(
              [
                ["/mail/$mailboxId/rules", "Rules and senders", sub === "/rules" || sub === "/senders"],
                [
                  "/mail/$mailboxId/imports",
                  "Import and export",
                  sub.startsWith("/imports") || sub === "/export",
                ],
              ] as const
            ).map(([to, label, cur]) => (
              <li key={to}>
                {access.manage ? (
                  <Link
                    className="nav-item fp-item"
                    to={to}
                    params={{ mailboxId }}
                    {...isCur(cur)}
                    onClick={mail.closeFolders}
                  >
                    <span className="nav-label">{label}</span>
                  </Link>
                ) : (
                  <Gated allowed={false} side="right" reason={access.manageReason} who={access.manageWho}>
                    {/* biome-ignore lint/a11y/useSemanticElements: the design's locked folder item is a focusable span, not a link that goes nowhere */}
                    <span className="nav-item fp-item" role="link" tabIndex={0}>
                      <span className="nav-label">{label}</span>
                    </span>
                  </Gated>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </nav>
  )
}

/** The switcher (`.mb-switch` + `#mb-menu`): every mailbox you can read, with unread counts and agent badges. */
function MailboxSwitcher() {
  const mail = useMail()
  const boxes = useQuery(mailboxesQuery)
  const attention = useQuery(attentionQuery)
  const agents = useQuery(agentsQuery)
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
  const unreadOf = (id: string) =>
    num(attention.data?.mailboxes.find((m) => m.mailboxId === id)?.unread) ??
    num(attention.data?.unread.find((m) => m.mailboxId === id)?.count) ??
    null
  const list = (boxes.data?.mailboxes ?? []).filter((m) => m.holdsMail)
  const mine = mail.mailbox
  const unread =
    unreadOf(mail.mailboxId) ?? num(mail.folders?.folders.find((f) => f.folder === "inbox")?.unreadThreads)
  const kind = mine ? (mail.agent ? "Agent mailbox" : (KIND_WORD[mine.kind] ?? "Mailbox")) : "Mailbox"
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="ws-switch mb-switch"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={`${mail.address} · switch mailbox`}
      >
        <span className="ws-avatar" aria-hidden="true">
          <Icon name={mail.agent ? "bot" : "mailbox"} />
        </span>
        <span className="ws-meta">
          <span className="ws-name">{mail.address}</span>
          <span className="ws-host">
            {kind}
            {unread ? ` · ${unread} unread` : ""}
          </span>
        </span>
        <Icon name="updown" />
      </button>
      {mail.agent ? (
        <div style={{ padding: "6px 2px 0" }}>
          <AgentBadge name={mail.agent.name} />
        </div>
      ) : null}
      {open ? (
        <div
          className="menu mail-menu"
          role="menu"
          aria-label="Mailboxes you can read"
          style={{ left: 0, top: "calc(100% + 6px)", width: 300 }}
          data-endpoint="GET /v1/mailboxes · GET /v1/mail/attention → mailboxes[].unread"
        >
          <div className="menu-label">Mailboxes you can read</div>
          {list.map((m) => {
            const n = unreadOf(m.id)
            const agent = agentFor(m.id, agents.data?.agents)
            return (
              <Link
                key={m.id}
                className="menu-item"
                role="menuitem"
                to="/mail/$mailboxId"
                params={{ mailboxId: m.id }}
                {...(m.id === mail.mailboxId ? { "aria-current": "true" as const } : {})}
                onClick={() => setOpen(false)}
              >
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="mono">{m.address}</span>
                  <span className="ws-host" style={{ display: "block", fontFamily: "var(--font-sans)" }}>
                    {agent
                      ? `Agent · ${agent.name}`
                      : `${m.kind === "user" ? "Personal" : "Shared"}${m.displayName ? ` · ${m.displayName}` : ""}`}
                  </span>
                </span>
                {n ? <span className="nav-count">{n}</span> : null}
              </Link>
            )
          })}
          <div className="menu-sep" />
          <Link className="menu-item" role="menuitem" to="/mail/search" onClick={() => setOpen(false)}>
            <Icon name="search" />
            <span className="grow">Search all mailboxes</span>
          </Link>
          <Link className="menu-item" role="menuitem" to="/settings" onClick={() => setOpen(false)}>
            <Icon name="plus" />
            <span className="grow">New mailbox</span>
          </Link>
        </div>
      ) : null}
    </div>
  )
}

/** A running or paused import's card (`a.fp-card`), from the imports list. */
function ImportCard() {
  const { mailboxId, access } = useMail()
  const q = useQuery({
    queryKey: ["mailboxes", mailboxId, "imports"],
    queryFn: () => unwrap(api.GET("/v1/mailboxes/{id}/imports", { params: { path: { id: mailboxId } } })),
    enabled: access.manage,
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.imports.some((i) => i.status === "running" || i.status === "pending")
        ? 15_000
        : false,
  })
  const imp = q.data?.imports.find(
    (i) => i.status === "running" || i.status === "pending" || i.status === "paused",
  )
  if (!imp) return null
  const total = num(imp.totals.source) ?? 0
  const done =
    (num(imp.totals.imported) ?? 0) + (num(imp.totals.duplicates) ?? 0) + (num(imp.totals.skipped) ?? 0)
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0
  const rate = num(imp.ratePerMinute)
  const eta = num(imp.etaAt)
  const from = imp.host?.includes("gmail") ? "Gmail" : (imp.host ?? "IMAP")
  return (
    <Link
      className="fp-card"
      to="/mail/$mailboxId/imports/$importId"
      params={{ mailboxId, importId: imp.id }}
      data-endpoint="GET /v1/mailboxes/{id}/imports · ws live → import.progress"
    >
      <span className="fc-title">
        {imp.status === "paused" ? <Icon name="pause" /> : <span className="spinner" aria-hidden="true" />}
        {imp.status === "paused" ? `Import from ${from} paused` : `Importing from ${from}`}
      </span>
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Import progress"
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="fc-sub">
        <b>{done.toLocaleString("en")}</b> of {total.toLocaleString("en")}
        {rate ? ` · ${Math.round(rate)}/min` : ""}
        {eta && imp.status !== "paused"
          ? ` · done about ${new Date(eta).toISOString().slice(11, 16)} UTC`
          : ""}
      </span>
    </Link>
  )
}

/**
 * Settings → Audit log (design: settings/audit*.html, HANDOFF-ops §30; HAL-3376, live). `GET /v1/audit`
 * newest first, with the actor, action (exact or a family), target and dates in the URL, paging by cursor,
 * an entry drawer, and the same view as CSV (`format=csv`, up to 10,000 rows, `x-truncated` beyond).
 * IP and location aren't recorded, so they read "Not recorded". Admin only: other keys see why.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { useMe } from "../../auth/session.ts"
import { fmtInt } from "../../lib/format.ts"
import { download, qs } from "../../ops/download.ts"
import { utcFull } from "../../ops/format.ts"
import { BuiltPill, Empty, Time } from "../../ops/kit.tsx"
import { Drawer } from "../../ops/Overlay.tsx"
import { isAdmin } from "../../ops/roles.ts"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { SectionHead } from "../integrations/common.tsx"
import type { AuditEntry } from "../integrations/queries.ts"
import {
  type AuditSearch,
  actionName,
  actorLabel,
  apiQuery,
  diffLines,
  FAMILIES,
  pretty,
  targetRoute,
  viewString,
} from "./logic.ts"
import "../integrations/integrations.css"

const route = getRouteApi("/_app/settings/audit")

export function AuditPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const me = useMe().data
  const admin = isAdmin(me)
  const keep = search.fx ? { fx: search.fx } : {}
  const q = useQuery({
    queryKey: ["audit", apiQuery(search)],
    queryFn: () => unwrap(api.GET("/v1/audit", { params: { query: apiQuery(search) } })),
    placeholderData: keepPreviousData,
    enabled: admin,
  })
  const refusedByScope = q.error instanceof ApiError && q.error.status === 403
  const [exporting, setExporting] = useState(false)

  if (!admin || refusedByScope) {
    return (
      <>
        <SectionHead title="Audit log" sub="Every change and every send action, kept for a year." />
        <div className="locked">
          <span className="empty-icon">
            <Icon name="lock" />
          </span>
          <h2>The audit log needs the admin scope</h2>
          <p>
            {me?.key ? (
              <>
                The key you’re signed in with, <b>{me.key.name}</b>, has{" "}
                {me.scopes.join(" and ") || "no scopes"}.{" "}
              </>
            ) : null}
            Only admin keys, owners and admins can read who changed what. Ask an owner for an admin key, or
            sign in with one.
          </p>
          <Link className="btn btn-secondary" to="/settings">
            Back to settings
          </Link>
        </div>
      </>
    )
  }

  const exportCsv = async () => {
    setExporting(true)
    try {
      const h = await download(
        `/v1/audit${qs(apiQuery(search, "csv"))}`,
        `mailyard-audit-${new Date().toISOString().slice(0, 10)}.csv`,
      )
      const rows = h.get("x-rows")
      if (h.get("x-truncated") === "true")
        toast(
          {
            title: `Exported ${fmtInt(rows ?? 10000)} rows (truncated)`,
            sub: "x-truncated: the log has more than one file holds. Narrow the dates or the action and export again for the rest.",
            tone: "warn",
          },
          10_000,
        )
      else toast({ title: rows ? `Exported ${fmtInt(rows)} rows` : "Exported the audit log" })
    } catch (e) {
      toast({
        title: "The CSV didn’t download",
        sub: e instanceof Error ? e.message : undefined,
        tone: "bad",
      })
    } finally {
      setExporting(false)
    }
  }

  const entries = q.data?.entries ?? []
  const open = search.open ? entries.find((e) => e.id === search.open) : undefined

  return (
    <>
      <SectionHead
        title="Audit log"
        sub="Every change and every send action, kept for a year."
        actions={
          <button
            className="btn btn-secondary"
            type="button"
            onClick={exportCsv}
            aria-disabled={exporting}
            data-endpoint={`GET /v1/audit${qs(apiQuery(search, "csv"))}`}
          >
            <Icon name="download" />
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        }
      />
      <Filters search={search} onApply={(next) => navigate({ search: { ...next, ...keep } })} />
      <Panel
        id="audit"
        title="Audit log"
        endpoint="GET /v1/audit?actor=&action=&target=&from=&to=&cursor=&limit= · format=csv (built, HAL-3376)"
        query={q}
        meta={
          <span className="cluster">
            <span>{rangeLabel(search)} · newest first</span>
            <BuiltPill issue="HAL-3376" />
          </span>
        }
        isEmpty={(d) => d.entries.length === 0}
        empty={
          <Empty icon="history" title={search.cursor ? "No older entries" : "Nothing matches these filters"}>
            {search.cursor
              ? "That’s the start of the log for this view."
              : "Widen the dates, or clear the actor, action or target."}
          </Empty>
        }
      >
        {(d) => (
          <>
            <p className="hint" style={{ margin: "0 0 10px" }}>
              IP and location aren’t recorded for audit entries, so they read “Not recorded”. Via says whether
              a key acted through the API or over MCP.
            </p>
            <div className="table-wrap rtable-wrap">
              <table className="rtable">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action, target, before → after</th>
                    <th>Actor</th>
                    <th>IP and location</th>
                  </tr>
                </thead>
                <tbody>
                  {d.entries.map((e) => (
                    <Row key={e.id} e={e} search={search} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
      {q.data ? (
        <div className="panel-foot" style={{ border: 0, padding: "0 4px", flexWrap: "wrap", gap: 8 }}>
          <span className="url-state">
            This view is a link: <code className="mono">{viewString(search)}</code>
          </span>
          <span className="cluster">
            {search.cursor ? (
              <Link className="btn btn-secondary btn-sm" to="/settings/audit" search={omit(search, "cursor")}>
                Newest
              </Link>
            ) : null}
            {q.data.nextCursor ? (
              <Link
                className="btn btn-secondary btn-sm"
                to="/settings/audit"
                search={{ ...omit(search, "open"), cursor: q.data.nextCursor }}
              >
                Older
              </Link>
            ) : null}
          </span>
        </div>
      ) : null}
      {open ? (
        <EntryDrawer e={open} onClose={() => navigate({ search: omit(search, "open"), replace: true })} />
      ) : null}
    </>
  )
}

/** The search without some keys (exactOptionalPropertyTypes won't take `key: undefined`). */
function omit<T extends object, K extends keyof T>(s: T, ...keys: K[]): Omit<T, K> {
  const out = { ...s }
  for (const k of keys) delete out[k]
  return out
}

function rangeLabel(s: AuditSearch) {
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })
  if (s.from && s.to) return `${fmt(s.from)} – ${fmt(s.to)}`
  if (s.from) return `Since ${fmt(s.from)}`
  if (s.to) return `Until ${fmt(s.to)}`
  return "All time"
}

function Filters({ search, onApply }: { search: AuditSearch; onApply: (s: AuditSearch) => void }) {
  const keys = useQuery({
    queryKey: ["api-keys", "all"],
    queryFn: () => unwrap(api.GET("/v1/api-keys")),
    staleTime: 60_000,
  })
  const [actor, setActor] = useState(search.actor ?? "")
  const [action, setAction] = useState(search.action ?? "")
  const [target, setTarget] = useState(search.target ?? "")
  const [from, setFrom] = useState(search.from ?? "")
  const [to, setTo] = useState(search.to ?? "")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: AuditSearch = {}
    if (actor) next.actor = actor
    if (action.trim()) next.action = action.trim()
    if (target.trim()) next.target = target.trim()
    if (from) next.from = from
    if (to) next.to = to
    onApply(next)
  }
  const families =
    FAMILIES.some((f) => f.value === action) || !action
      ? FAMILIES
      : [{ value: action, label: action }, ...FAMILIES]
  const known = (keys.data?.keys ?? []).some((k) => k.id === actor) || ["", "root", "system"].includes(actor)
  return (
    <search>
      <form className="filterbar" onSubmit={submit} aria-label="Filter the audit log">
        <div className="field">
          <label className="label" htmlFor="a-who">
            Actor
          </label>
          <select className="select" id="a-who" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Anyone</option>
            {(keys.data?.keys ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} ({k.purpose === "mcp" ? "agent key" : "key"})
              </option>
            ))}
            {known ? null : <option value={actor}>{actor}</option>}
            <option value="root">Admin key</option>
            <option value="system">System</option>
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="a-what">
            Action
          </label>
          <select className="select" id="a-what" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Any action</option>
            {families.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="a-target">
            Target
          </label>
          <input
            className="input mono"
            id="a-target"
            value={target}
            placeholder="cmp_…, mbx_…, brand"
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
        <fieldset className="field f-range">
          <legend className="label">Between</legend>
          <div className="f-range-inputs">
            <input
              className="input"
              type="date"
              value={from}
              max={to || undefined}
              aria-label="From (UTC)"
              onChange={(e) => setFrom(e.target.value)}
            />
            <span aria-hidden="true">–</span>
            <input
              className="input"
              type="date"
              value={to}
              min={from || undefined}
              aria-label="To (UTC)"
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </fieldset>
        <button className="btn btn-secondary" type="submit">
          <Icon name="filter" />
          Apply
        </button>
      </form>
    </search>
  )
}

function TargetLink({ target }: { target: AuditEntry["target"] }) {
  if (!target) return <span className="muted">No target</span>
  const to = targetRoute(target)
  const label = target.label ?? target.id
  if (!to) return <span className={target.label ? "" : "mono"}>{label}</span>
  return (
    // The route is computed from the target's type, so it isn't one the router can check statically.
    <Link className="link target-link" to={to as never}>
      {label}
    </Link>
  )
}

function Actor({ e }: { e: AuditEntry }) {
  const a = actorLabel(e.actor)
  return (
    <>
      <span style={{ color: "var(--my-fg)" }}>{a.name}</span>{" "}
      {e.via ? <span className="tag">{e.via === "mcp" ? "MCP" : "API"}</span> : null}
      <span className="cell-sub" style={{ display: "block" }}>
        {a.sub}
      </span>
    </>
  )
}

function Row({ e, search }: { e: AuditEntry; search: AuditSearch }) {
  const lines = diffLines(e.before, e.after)
  return (
    <tr>
      <td className="nowrap" data-label="When">
        <Time value={e.at} />
      </td>
      <td className="is-head">
        <div className="cell-main">
          <Link to="/settings/audit" search={{ ...search, open: e.id }}>
            {actionName(e.action)}
          </Link>
          <span className="cell-sub">
            <span className="mono">{e.action}</span> · <TargetLink target={e.target} />
          </span>
          {lines.length ? (
            <span className="cell-sub audit-diff">
              {lines.slice(0, 3).map((l, i) => (
                <span key={l.key}>
                  {i ? <br /> : null}
                  <span className="mono">{l.key}</span>:{" "}
                  {l.from === "new" ? <span className="muted">new</span> : l.from} →{" "}
                  {l.to === "removed" ? <span className="muted">removed</span> : l.to}
                </span>
              ))}
              {lines.length > 3 ? (
                <>
                  <br />
                  <span className="muted">and {lines.length - 3} more</span>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      </td>
      <td data-label="Actor">
        <Actor e={e} />
      </td>
      <td data-label="IP and location">
        <span className="muted">Not recorded</span>
      </td>
    </tr>
  )
}

function EntryDrawer({ e, onClose }: { e: AuditEntry; onClose: () => void }) {
  return (
    <Drawer
      title={actionName(e.action)}
      sub={
        <>
          {e.id} · <Time value={e.at} />
        </>
      }
      wide
      onClose={onClose}
      odId="audit-drawer"
      foot={<span className="t-small muted">Entries can’t be edited or deleted.</span>}
    >
      <div className="stack stack-16">
        <dl className="kv">
          <dt>When</dt>
          <dd>{utcFull(e.at)}</dd>
          <dt>Actor</dt>
          <dd>
            <Actor e={e} />
          </dd>
          <dt>IP</dt>
          <dd>
            <span className="muted">Not recorded</span>
          </dd>
          <dt>Location</dt>
          <dd>
            <span className="muted">Not recorded</span>
          </dd>
          <dt>Action</dt>
          <dd>
            <span className="mono">{e.action}</span>
          </dd>
          <dt>Target</dt>
          <dd>
            <TargetLink target={e.target} />
            {e.target ? (
              <span className="cell-sub mono" style={{ display: "block" }}>
                {e.target.id}
              </span>
            ) : null}
          </dd>
          <dt>Entry</dt>
          <dd>
            <span className="mono">{e.id}</span>
            <button
              className="copy-btn"
              type="button"
              aria-label="Copy entry id"
              onClick={() => navigator.clipboard?.writeText(e.id)}
            >
              <Icon name="copy" />
            </button>
          </dd>
        </dl>
        <div>
          <h3 className="t-h4" style={{ marginBottom: 8 }}>
            Before and after
          </h3>
          <div className="diff">
            <div className="diff-side is-old">
              <span className="t-small">Before</span>
              <code>{pretty(e.before)}</code>
            </div>
            <div className="diff-side is-new">
              <span className="t-small">After</span>
              <code>{pretty(e.after)}</code>
            </div>
          </div>
        </div>
      </div>
    </Drawer>
  )
}

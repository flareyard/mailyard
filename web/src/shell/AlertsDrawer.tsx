/**
 * The alerts bell and drawer: GET /v1/alerts (polled) and POST /v1/alerts/{id}/resolve (HAL-3364).
 * Severity filter and kind filter live in the drawer; every alert links to its subject.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { fmtAgo, num } from "../lib/format.ts"
import { Icon, type IconName } from "../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../ui/Panel.tsx"

export const alertsQuery = {
  queryKey: ["alerts", "open"],
  queryFn: () => unwrap(api.GET("/v1/alerts", { params: { query: { status: "open" } as never } })),
  refetchInterval: 60_000,
}

type Severity = "all" | "critical" | "warning" | "info"
const SEV_ICON: Record<string, IconName> = { critical: "octagon", warning: "warn", info: "info" }

/** Where an alert's subject lives in the app (the routes GET /v1/search also uses). */
export function subjectRoute(subject: { type: string; id: string } | null | undefined): string | null {
  if (!subject) return null
  switch (subject.type) {
    case "domain":
      return `/domains/${subject.id}`
    case "campaign":
      return `/campaigns/${subject.id}`
    case "webhook":
      return `/transactional/webhooks/${subject.id}`
    case "mailbox":
      return `/mail/${subject.id}`
    case "automation":
      return `/automations/${subject.id}`
    case "import":
      return `/audience/imports/${subject.id}`
    case "export":
      return `/audience/exports/${subject.id}`
    default:
      return null
  }
}

export function AlertsBell({ onOpen }: { onOpen: () => void }) {
  const q = useQuery(alertsQuery)
  const open = q.data?.open
  const total = num(open?.total) ?? 0
  const sev = num(open?.critical) ? "is-critical" : num(open?.warning) ? "is-warning" : "is-info"
  return (
    <button
      className="icon-btn"
      type="button"
      onClick={onOpen}
      aria-label={total ? `Alerts, ${total} open` : "Alerts"}
      title="Alerts · Shift A"
      data-endpoint="GET /v1/alerts"
    >
      <Icon name="bell" />
      {total ? (
        <span className={`badge-dot ${sev}`} aria-hidden="true">
          {total}
        </span>
      ) : null}
    </button>
  )
}

export function AlertsDrawer({ onClose }: { onClose: () => void }) {
  const [severity, setSeverity] = useState<Severity>("all")
  const [kind, setKind] = useState("all")
  const q = useQuery(alertsQuery)
  const qc = useQueryClient()
  const resolve = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/v1/alerts/{id}/resolve", { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  })
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", esc)
    return () => window.removeEventListener("keydown", esc)
  }, [onClose])

  const all = q.data?.alerts ?? []
  const kinds = [...new Set(all.map((a) => a.kind))].sort()
  const shown = all.filter(
    (a) => (severity === "all" || a.severity === severity) && (kind === "all" || a.kind === kind),
  )
  const o = q.data?.open
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="alerts-title">
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer">
        <div className="drawer-head">
          <div className="stack stack-4">
            <h2 className="t-h2" id="alerts-title">
              Alerts
            </h2>
            {o ? (
              <span className="t-small muted">
                {num(o.total)} open · {num(o.critical)} critical, {num(o.warning)} warning, {num(o.info)} info
              </span>
            ) : null}
          </div>
          <button
            ref={closeRef}
            className="icon-btn"
            type="button"
            onClick={onClose}
            aria-label="Close alerts"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">
          <div className="cluster" style={{ padding: "12px 0 4px", gap: 8 }}>
            {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg control is a styled div group, not a fieldset */}
            <div className="seg" role="group" aria-label="Severity">
              {(["all", "critical", "warning", "info"] as const).map((s) => (
                <button key={s} type="button" aria-pressed={severity === s} onClick={() => setSeverity(s)}>
                  {s === "all" ? "All" : s[0]?.toUpperCase() + s.slice(1)}
                  {s !== "all" && o && num(o[s]) ? ` ${num(o[s])}` : ""}
                </button>
              ))}
            </div>
            <select
              className="select"
              style={{ width: "auto", fontSize: 13 }}
              aria-label="Kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="all">All kinds</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          {q.isPending ? (
            <PanelSkeleton rows={4} />
          ) : q.isError ? (
            <PanelError error={q.error} onRetry={() => q.refetch()} what="Alerts didn’t load" />
          ) : shown.length === 0 ? (
            <div className="empty">
              <span className="empty-icon">
                <Icon name="check-circle" />
              </span>
              <b>Nothing needs you</b>
              <p className="t-small muted">Open alerts appear here and on the bell.</p>
            </div>
          ) : (
            <>
              <div className="palette-group" style={{ padding: "12px 0 0" }}>
                Open · {shown.length}
              </div>
              <ul className="list">
                {shown.map((a) => {
                  const to = subjectRoute(a.subject as { type: string; id: string } | null)
                  const count = num(a.count) ?? 1
                  return (
                    <li key={a.id} className={`alert-item is-${a.severity}`}>
                      <Icon name={SEV_ICON[a.severity] ?? "info"} />
                      <span className="ai-title">
                        {a.title}{" "}
                        {count > 1 ? (
                          <span className="pill pill-neutral num" title="Times it happened while open">
                            ×{count}
                          </span>
                        ) : null}
                      </span>
                      <p className="ai-detail">{a.detail}</p>
                      <div className="ai-meta">
                        <span className="kind">{a.kind}</span>
                        <span className="t-small muted">
                          · {fmtAgo(a.createdAt)}
                          {a.updatedAt !== a.createdAt ? ` · updated ${fmtAgo(a.updatedAt)}` : ""}
                        </span>
                        <span className="grow" />
                        {to ? (
                          <Link className="panel-link" to={to} onClick={onClose}>
                            Open
                            <Icon name="chevron-right" />
                          </Link>
                        ) : null}
                        <button
                          className="btn btn-secondary btn-sm"
                          type="button"
                          disabled={resolve.isPending}
                          onClick={() => resolve.mutate(a.id)}
                        >
                          Resolve
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

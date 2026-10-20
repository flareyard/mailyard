/**
 * Global banners (HANDOFF §3): offline, a workspace being deleted (HAL-3448) with its countdown and Restore,
 * quota exhausted with the next reset, reputation at risk, and domain drift. Each comes from data the shell
 * already has (usage, alerts, the `x-workspace-deleting` header on every response), so banners cost no extra
 * requests.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { useMe } from "../auth/session.ts"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { fmtIn } from "../lib/format.ts"
import { setDeleting, setFixtureDeleting, useDeleting } from "../ops/deletion.ts"
import { fmtCountdown, utcShort } from "../ops/format.ts"
import { isOwner } from "../ops/roles.ts"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"
import { alertsQuery, subjectRoute } from "./AlertsDrawer.tsx"
import { usageQuery } from "./QuotaMeter.tsx"

function useOnline() {
  const [online, set] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => set(true)
    const off = () => set(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])
  return online
}

export function Banners() {
  const online = useOnline()
  const usage = useQuery(usageQuery)
  const alerts = useQuery(alertsQuery)
  const list = alerts.data?.alerts ?? []
  const atRisk = list.find((a) => a.kind === "reputation_at_risk")
  const drift = list.filter((a) => a.kind === "dns_drift")
  const exhausted = usage.data?.today.source === "cloudflare" && usage.data.today.overQuota === true
  const deletesAt = useDeleting()
  if (online && !deletesAt && !atRisk && !drift.length && !exhausted) return null
  return (
    <div className="banners">
      {!online ? (
        <div className="banner banner-offline" role="status">
          <Icon name="wifi-off" />
          <span className="banner-text">
            <b>You’re offline.</b> What’s on screen is from your last visit; actions wait until you’re back.
          </span>
        </div>
      ) : null}
      {deletesAt ? <DeletingBanner deletesAt={deletesAt} /> : null}
      {atRisk ? (
        <div className="banner banner-critical" role="alert">
          <Icon name="octagon" />
          <span className="banner-text">
            <b>{atRisk.title}</b> {atRisk.detail}
          </span>
          <span className="banner-actions">
            <Link className="btn btn-secondary btn-sm" to="/analytics">
              See what’s driving it
            </Link>
          </span>
        </div>
      ) : null}
      {exhausted ? (
        <div className="banner banner-warning" role="status">
          <Icon name="gauge" />
          <span className="banner-text">
            <b>Today’s sending quota is used up.</b> Sends wait for the reset{" "}
            {usage.data?.today.resetsAt ? fmtIn(usage.data.today.resetsAt) : "at 00:00 UTC"}.
          </span>
        </div>
      ) : null}
      {drift.map((d) => {
        const to = subjectRoute(d.subject as { type: string; id: string } | null)
        return (
          <div key={d.id} className="banner banner-warning" role="status">
            <Icon name="domains" />
            <span className="banner-text">
              <b>{d.title}</b> {d.detail}
            </span>
            {to ? (
              <span className="banner-actions">
                <Link className="btn btn-secondary btn-sm" to={to}>
                  Fix records
                </Link>
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** Re-renders every minute, so a countdown stays true without a request. */
function useMinute() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}

/**
 * The workspace is being deleted (HAL-3448): when, how long is left, what still works, and Restore for the
 * owner. Sending answers 409 `workspace-deleting` meanwhile; mail still arrives.
 */
function DeletingBanner({ deletesAt }: { deletesAt: number }) {
  const now = useMinute()
  const me = useMe()
  const qc = useQueryClient()
  const owner = isOwner(me.data)
  const restore = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/workspace/restore", { body: {} })),
    onSuccess: () => {
      if (fixturesEnabled()) setFixtureDeleting(null)
      setDeleting(null)
      qc.invalidateQueries({ queryKey: ["workspace"] })
    },
  })
  const name = me.data?.workspace.name ?? "This workspace"
  const err = restore.error as { message?: string; requestId?: string } | null
  return (
    <div
      className="banner banner-critical"
      role="alert"
      data-endpoint="x-workspace-deleting · POST /v1/workspace/restore (built, HAL-3448)"
      data-od-id="workspace-deleting-banner"
    >
      <Icon name="trash" />
      <span className="banner-text">
        <b>
          {name} is being deleted in {fmtCountdown(deletesAt, now)}.
        </b>{" "}
        Everything goes on {utcShort(deletesAt)}. Sending is stopped until then; mail still arrives, and the
        export started with the request keeps its files.
        {err ? (
          <>
            {" "}
            <span>Restore didn’t go through: {err.message}</span>
            {err.requestId ? <RequestId id={err.requestId} /> : null}
          </>
        ) : null}
      </span>
      <span className="banner-actions">
        <Link className="btn btn-secondary btn-sm" to="/settings/danger">
          Details
        </Link>
        <Gated
          allowed={owner}
          reason="Only the owner can restore the workspace"
          who="Ask the owner to restore it from Settings → Danger zone."
          side="right"
        >
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={restore.isPending}
            onClick={() => restore.mutate()}
          >
            <Icon name="undo" />
            {restore.isPending ? "Restoring…" : "Restore"}
          </button>
        </Gated>
      </span>
    </div>
  )
}

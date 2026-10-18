/**
 * Global banners (HANDOFF §3): offline, quota exhausted with the next reset, reputation at risk, and domain
 * drift. Each comes from data the shell already polls (usage, alerts), so banners cost no extra requests.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { fmtIn } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
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
  if (online && !atRisk && !drift.length && !exhausted) return null
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

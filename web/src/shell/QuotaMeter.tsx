/**
 * The sidebar's usage meter, from GET /v1/usage. Keyed on `today.source` (HANDOFF §3): `cloudflare` draws the
 * meter; `cloudflare-unreachable` and `not-connected` draw a hatched meter with the reason, and the quota,
 * remaining, overQuota and resetsAt fields are treated as unknown.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { api, unwrap } from "../api/client.ts"
import { fmtIn, fmtInt, fmtUsd, num } from "../lib/format.ts"

export const usageQuery = {
  queryKey: ["usage"],
  queryFn: () => unwrap(api.GET("/v1/usage")),
  refetchInterval: 60_000,
}

const pct = (a: number | null, b: number | null) =>
  a === null || !b ? 0 : Math.min(100, Math.round((a / b) * 100))

export function QuotaMeter() {
  const q = useQuery(usageQuery)
  if (q.isPending) {
    return (
      <div className="quota" aria-busy="true">
        <span className="sk sk-bar" />
        <span className="sk sk-bar" />
      </div>
    )
  }
  if (q.isError || !q.data) {
    return (
      <Link className="quota" to="/analytics" aria-label="Usage isn’t available">
        <div className="quota-row">
          <div className="quota-line hide-rail">
            <span>Usage</span>
            <span className="muted">unavailable</span>
          </div>
          <div className="meter meter-unknown" />
        </div>
      </Link>
    )
  }
  const { today, month } = q.data
  const known = today.source === "cloudflare"
  const sent = num(today.sent)
  const quota = known ? num(today.quota) : null
  const tp = pct(sent, quota)
  const billed = num(month.billed)
  const included = num(month.included)
  const projected = num(month.projectedBilled)
  const mp = pct(billed, included)
  const reason =
    today.source === "not-connected"
      ? "Quota unknown: no Email Sending token yet"
      : today.source === "cloudflare-unreachable"
        ? "Quota unknown: Cloudflare didn’t answer"
        : null
  const label = `Today ${fmtInt(sent)}${quota !== null ? ` of ${fmtInt(quota)}` : ""} · Month ${fmtInt(billed)} of ${fmtInt(included)} included`
  return (
    <Link
      className="quota"
      to="/analytics"
      data-endpoint="GET /v1/usage"
      aria-label={`Usage: ${label}`}
      title={label}
    >
      <div className="quota-row">
        <div className="quota-line hide-rail">
          <span>Today</span>
          <span>
            <b>{fmtInt(sent)}</b>
            {quota !== null ? ` / ${fmtInt(quota)}` : ""}
          </span>
        </div>
        {known ? (
          // biome-ignore lint/a11y/useSemanticElements: the design's meter is a styled bar with a projection layer; <meter> can't draw it
          <div
            className={`meter${tp >= 100 ? " is-full" : tp >= 80 ? " is-warn" : ""}`}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={quota ?? 0}
            aria-valuenow={sent ?? 0}
            aria-label="Sent today"
          >
            <span style={{ width: `${tp}%` }} />
          </div>
        ) : (
          <div className="meter meter-unknown" role="img" aria-label={reason ?? "Quota unknown"} />
        )}
        <div className="quota-foot hide-rail">
          {known && today.resetsAt ? `Resets 00:00 UTC · ${fmtIn(today.resetsAt)}` : reason}
        </div>
      </div>
      <div className="quota-row">
        <div className="quota-line hide-rail">
          <span>This month</span>
          <span>
            <b>{fmtInt(billed)}</b> / {fmtInt(included)} included
          </span>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's meter is a styled bar with a projection layer; <meter> can't draw it */}
        <div
          className="meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={included ?? 0}
          aria-valuenow={billed ?? 0}
          aria-label="Billed this month"
        >
          <i className="meter-proj" style={{ width: `${pct(projected, included)}%` }} />
          <span style={{ width: `${mp}%` }} />
        </div>
        <div className="quota-foot hide-rail">
          Projected {fmtInt(projected)}
          {num(month.projectedCostUsd) ? (
            <>
              {" · "}
              <b>{fmtUsd(month.projectedCostUsd)}</b> overage
            </>
          ) : null}
        </div>
      </div>
    </Link>
  )
}

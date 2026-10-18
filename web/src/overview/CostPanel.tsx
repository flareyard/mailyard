/** Cost this billing month: billed against the included sends, projected month end, and the overage arithmetic. */
import { useQuery } from "@tanstack/react-query"
import { fmtInt, fmtUsd, num, toDate } from "../lib/format.ts"
import { Panel } from "../ui/Panel.tsx"
import { costBreakdown, longDate, shortDate } from "./logic.ts"
import { usageQuery } from "./queries.ts"
import { StaleMeta, useOffline } from "./shared.tsx"

export function CostPanel() {
  const offline = useOffline()
  const q = useQuery(usageQuery)
  return (
    <Panel
      id="cost"
      title="Cost"
      to="/analytics/usage"
      linkLabel="Usage"
      span={4}
      endpoint="GET /v1/usage"
      meta={<StaleMeta offline={offline} updatedAt={q.dataUpdatedAt} label="This billing month" />}
      query={q}
      skeleton={
        <div className="stack stack-12" aria-hidden="true">
          <span className="sk sk-stat" style={{ width: "50%" }} />
          <span className="sk sk-bar" />
          {[100, 86, 92, 70].map((w) => (
            <span key={w} className="sk sk-text" style={{ width: `${w}%` }} />
          ))}
        </div>
      }
    >
      {(u) => {
        const mo = u.month
        const c = costBreakdown(mo)
        const from = toDate(mo.from)
        const measured = toDate(u.pricing.measuredAt)
        const per = num(u.pricing.usdPerThousand) ?? 0.35
        return (
          <div className="stack stack-12">
            <div className="stat">
              <span className="stat-label">Billed since {from ? shortDate(from) : "the 1st"}</span>
              <span className="stat-value">
                {fmtInt(c.billed)}{" "}
                <span className="t-label muted ov-sans">of {fmtInt(c.included)} included</span>
              </span>
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: <meter> can't draw the projected layer under the billed one */}
            <div
              className="meter ov-meter-10"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={c.included}
              aria-valuenow={c.billed}
              aria-valuetext={`${fmtInt(c.billed)} of ${fmtInt(c.included)} included sends billed; ${fmtInt(c.projected)} projected by month end`}
              aria-label="Billed against included"
            >
              <i className="meter-proj" style={{ width: `${c.projectedPct.toFixed(1)}%` }} />
              <span style={{ width: `${c.billedPct.toFixed(1)}%` }} />
            </div>
            <div className="legend">
              <span>
                <i style={{ ["--c" as string]: "var(--gray-1000)" }} />
                Billed
              </span>
              <span>
                <i style={{ ["--c" as string]: "var(--gray-500)" }} />
                Projected by month end
              </span>
            </div>
            <table className="table">
              <caption className="sr-only">Projected cost this billing month</caption>
              <tbody>
                <tr>
                  <th scope="row" className="ov-th-plain">
                    Projected month end
                  </th>
                  <td className="r">
                    <b>{fmtInt(c.projected)}</b>
                  </td>
                </tr>
                <tr>
                  <th scope="row" className="ov-th-plain">
                    Projected overage
                  </th>
                  <td className="r">
                    {fmtInt(c.projectedOverage)} × {fmtUsd(per)} / 1,000
                  </td>
                </tr>
                <tr>
                  <th scope="row" className="ov-th-plain">
                    <b>Projected cost</b>
                  </th>
                  <td className="r">
                    <b>{fmtUsd(mo.projectedCostUsd)}</b>
                  </td>
                </tr>
                <tr>
                  <th scope="row" className="ov-th-plain muted">
                    Cost so far
                  </th>
                  <td className="r muted">{fmtUsd(mo.costUsd)}</td>
                </tr>
              </tbody>
            </table>
            <p className="hint">
              Sends to your own verified addresses are free. Prices from Cloudflare
              {measured ? `, read ${longDate(measured)}` : ""}.
            </p>
          </div>
        )
      }}
    </Panel>
  )
}

/**
 * Analytics → Reputation (design: analytics/reputation.html): the 30-day window as Cloudflare judges it, with
 * each rate on its threshold track, and the bounce and complaint rates by day for 30 days. Reputation always reads
 * a 30-day window, whatever the range control says.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { fmtInt, num } from "../lib/format.ts"
import { pct, utcTime } from "../ops/format.ts"
import { Icon } from "../ui/icons.tsx"
import { fmtLine, n0, rateAxis } from "./logic.ts"
import { deliveryQuery, reputationQuery } from "./queries.ts"
import { ChartPanel, dayLong, LineChart, shortDay } from "./shared.tsx"

type Level = "ok" | "warning" | "at-risk" | "insufficient-data"
const LEVEL: Record<Level, { cls: string; pill: string; label: string }> = {
  ok: { cls: "is-ok", pill: "pill-pass", label: "Under warning" },
  warning: { cls: "is-warning", pill: "pill-warn", label: "Warning" },
  "at-risk": { cls: "is-at-risk", pill: "pill-fail", label: "At risk" },
  "insufficient-data": { cls: "is-insufficient", pill: "pill-neutral", label: "Not enough data yet" },
}
const STATUS: Record<string, { pill: string; label: string }> = {
  healthy: { pill: "pill-pass", label: "Healthy" },
  warning: { pill: "pill-warn", label: "Warning" },
  at_risk: { pill: "pill-fail", label: "At risk" },
  "at-risk": { pill: "pill-fail", label: "At risk" },
  suspended: { pill: "pill-fail", label: "Suspended" },
}

/** Where the fill and lines sit: the track runs to 1.6 × at-risk, so at-risk always sits at 62.5%. */
const geometry = (rate: unknown, warn: number, risk: number) => {
  const scale = risk * 1.6 || 1
  const r = num(rate as number)
  return {
    fill: r === null ? 0 : Math.max(0, Math.min((r / scale) * 100, 100)),
    warnAt: (warn / scale) * 100,
    riskAt: (risk / scale) * 100,
  }
}

export function ReputationView() {
  const rep = useQuery(reputationQuery)
  const history = useQuery(deliveryQuery("30d"))
  return (
    <div className="split-even">
      <div className="stack">
        <ChartPanel
          id="now"
          name="Reputation"
          title="30-day window, as Cloudflare judges it"
          endpoint="GET /v1/reputation"
          query={rep}
          foot={false}
          link={
            <Link className="panel-link" to="/domains/reputation">
              Reputation detail
              <Icon name="chevron-right" />
            </Link>
          }
        >
          {(r) => {
            const status = r.status ? (STATUS[r.status] ?? { pill: "pill-neutral", label: r.status }) : null
            const insufficient = r.rates.insufficientData
            const rows = [
              {
                name: "Bounce rate",
                rate: r.rates.bounceRate,
                line: r.policy.customer_bounce,
                level: r.levels.bounce,
              },
              {
                name: "Complaint rate · against deliveries",
                rate: r.rates.complaintRate,
                line: r.policy.complaint,
                level: r.levels.complaint,
              },
              {
                name: "Spam rejection rate",
                rate: r.rates.rejectionRate,
                line: r.policy.spam_rejection,
                level: r.levels.spamRejection,
              },
            ]
            return (
              <div className="stack stack-12">
                <span className="source-line">
                  {r.source === "not-connected" ? (
                    <>Not connected to Cloudflare’s reputation · judged on our own rates</>
                  ) : (
                    <>
                      Status{" "}
                      {status ? (
                        <span className={`pill ${status.pill}`}>
                          <span className="dot" />
                          {status.label}
                        </span>
                      ) : (
                        "unknown"
                      )}
                    </>
                  )}{" "}
                  · policy {r.policySource === "account" ? "from this account" : "as measured 16 Oct 2026"}
                  {r.evaluatedAt ? ` · evaluated ${utcTime(r.evaluatedAt)}` : ""}
                </span>
                {insufficient ? (
                  <p className="hint">
                    {fmtInt(r.totals.sent)} of {fmtInt(r.rates.minimumSends)} sends in the window, so
                    Cloudflare doesn’t rate it yet.
                  </p>
                ) : null}
                <div>
                  {rows.map((row) => {
                    const warn = n0(row.line.warning_at)
                    const risk = n0(row.line.at_risk_at)
                    const g = geometry(row.rate, warn, risk)
                    const lv = LEVEL[row.level]
                    return (
                      <Link key={row.name} className={`thresh ${lv.cls} ana-thresh`} to="/domains/reputation">
                        <div className="thresh-head">
                          <span className="thresh-name">{row.name}</span>
                          <span className="cluster">
                            <span className="thresh-value">
                              {row.level === "insufficient-data" ? "—" : pct(row.rate)}
                            </span>
                            <span className={`pill ${lv.pill}`}>
                              <span className="dot" />
                              {lv.label}
                            </span>
                          </span>
                        </div>
                        <div
                          className="thresh-track"
                          role="img"
                          aria-label={`${row.name} ${pct(row.rate)}; warning at ${fmtLine(warn)}, at risk at ${fmtLine(risk)}`}
                        >
                          <span className="thresh-fill" style={{ width: `${g.fill.toFixed(2)}%` }} />
                          <i className="thresh-line" style={{ left: `${g.warnAt.toFixed(1)}%` }} />
                          <i className="thresh-line risk" style={{ left: `${g.riskAt.toFixed(1)}%` }} />
                        </div>
                        <div className="thresh-scale" aria-hidden="true">
                          <span style={{ left: `${g.warnAt.toFixed(1)}%` }}>Warning {fmtLine(warn)}</span>
                          <span className="risk" style={{ left: `${g.riskAt.toFixed(1)}%` }}>
                            At risk {fmtLine(risk)}
                          </span>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              </div>
            )
          }}
        </ChartPanel>
      </div>
      <div className="stack">
        {(["bounceRate", "complaintRate"] as const).map((key) => (
          <ChartPanel
            key={key}
            id={key === "bounceRate" ? "history" : "history-c"}
            name={key === "bounceRate" ? "Bounce rate" : "Complaint rate"}
            title={key === "bounceRate" ? "Bounce rate, 30 days" : "Complaint rate, 30 days"}
            range="30d"
            endpoint="GET /v1/stats/delivery?range=30d&by=day"
            query={history}
            built="HAL-3366"
            csv="delivery"
          >
            {(d) => {
              const line =
                key === "bounceRate" ? rep.data?.policy.customer_bounce : rep.data?.policy.complaint
              const warn = n0(line?.warning_at) || (key === "bounceRate" ? 0.02 : 0.001)
              const risk = n0(line?.at_risk_at) || (key === "bounceRate" ? 0.05 : 0.002)
              const values = d.days.map((x) => num(x.rates[key]))
              const axis = rateAxis(values, risk)
              const first = d.days[0]?.day
              const last = d.days[d.days.length - 1]?.day
              const name = key === "bounceRate" ? "Bounce rate" : "Complaint rate"
              return (
                <LineChart
                  label={`${name} per day for 30 days`}
                  values={values}
                  top={axis.top}
                  ticks={axis.ticks}
                  thresholds={[
                    { at: axis.at(warn), label: `Warning ${fmtLine(warn)}` },
                    { at: axis.at(risk), label: `At risk ${fmtLine(risk)}`, risk: true },
                  ]}
                  hatch={d.days.map((x) => x.rates.insufficientData)}
                  hatchTitle="Under the minimum sends: not rated"
                  first={first ? shortDay(first) : ""}
                  last={last ? shortDay(last) : ""}
                  table={{
                    head: ["Day", name],
                    rows: d.days.map((x) => [
                      dayLong(x.day),
                      x.rates.insufficientData ? "Under the minimum" : pct(x.rates[key]),
                    ]),
                  }}
                />
              )
            }}
          </ChartPanel>
        ))}
      </div>
    </div>
  )
}

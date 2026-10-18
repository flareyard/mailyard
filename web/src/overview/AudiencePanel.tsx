/** Audience: total contacts with a daily trend, the split by status (an hourly snapshot), and the range's changes. */
import { useQuery } from "@tanstack/react-query"
import { fmtInt, num, toDate } from "../lib/format.ts"
import { Panel } from "../ui/Panel.tsx"
import { hhmm, RANGE_LABEL, type Range, sparkPaths } from "./logic.ts"
import { audienceQuery } from "./queries.ts"
import { StaleMeta, useOffline } from "./shared.tsx"

const STATUS = [
  { key: "subscribed", label: "Subscribed", color: "var(--data-good)" },
  { key: "unconfirmed", label: "Unconfirmed", color: "var(--data-warn)" },
  { key: "unsubscribed", label: "Unsubscribed", color: "var(--data-neutral)" },
  { key: "bounced", label: "Bounced", color: "var(--data-bad)" },
  { key: "complained", label: "Complained", color: "var(--data-bad-strong)" },
  { key: "suppressed", label: "Suppressed", color: "var(--data-bad-soft)" },
] as const

export function AudiencePanel({ range }: { range: Range }) {
  const offline = useOffline()
  const q = useQuery(audienceQuery(range))
  return (
    <Panel
      id="audience"
      title="Audience"
      to="/audience"
      linkLabel="Audience"
      span={4}
      endpoint={`GET /v1/stats/audience?range=${range}`}
      meta={<StaleMeta offline={offline} updatedAt={q.dataUpdatedAt} label={RANGE_LABEL[range]} />}
      query={q}
      isEmpty={(a) => (num(a.total) ?? 0) === 0 && a.totalByDay.every((d) => !num(d.total))}
      empty={
        <div className="empty ov-empty-tight">
          <h3>No contacts yet</h3>
          <p>Contacts you import or collect with a form show here, with how many are subscribed.</p>
        </div>
      }
      skeleton={
        <div className="stack stack-12" aria-hidden="true">
          <span className="sk sk-stat" style={{ width: "40%" }} />
          <span className="sk sk-bar" />
          {[100, 86, 92].map((w) => (
            <span key={w} className="sk sk-text" style={{ width: `${w}%` }} />
          ))}
        </div>
      }
    >
      {(a) => {
        const spark = sparkPaths(a.totalByDay.map((d) => num(d.total)))
        const asOf = toDate(a.asOf)
        return (
          <div className="stack stack-12">
            <div className="spread-nowrap">
              <div className="stat">
                <span className="stat-label">Contacts</span>
                <span className="stat-value">{fmtInt(a.total)}</span>
              </div>
              <div className="ov-spark-box">
                <svg
                  className="spark"
                  viewBox="0 0 100 36"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`Total contacts by day, ${fmtInt(spark.first)} to ${fmtInt(spark.last)}${spark.gaps ? `, ${spark.gaps} ${spark.gaps === 1 ? "day" : "days"} without a count` : ""}`}
                >
                  {spark.lines.map((d) => (
                    <path key={d} className="line" d={d} />
                  ))}
                  {spark.dots.map(([x, y]) => (
                    <circle key={`${x}-${y}`} cx={x.toFixed(2)} cy={y.toFixed(2)} r="1.6" />
                  ))}
                </svg>
              </div>
            </div>
            <div
              className="splitbar"
              role="img"
              aria-label={`Contacts by status: ${STATUS.map((s) => `${s.label} ${fmtInt(a.byStatus[s.key])}`).join(", ")}`}
            >
              {STATUS.filter((s) => (num(a.byStatus[s.key]) ?? 0) > 0).map((s) => (
                <span
                  key={s.key}
                  style={{ flex: num(a.byStatus[s.key]) ?? 0, ["--c" as string]: s.color }}
                  title={`${s.label}: ${fmtInt(a.byStatus[s.key])}`}
                />
              ))}
            </div>
            <div className="legend">
              {STATUS.map((s) => (
                <span key={s.key}>
                  <i style={{ ["--c" as string]: s.color }} />
                  {s.label} <b className="num ov-fg">{fmtInt(a.byStatus[s.key])}</b>
                </span>
              ))}
            </div>
            <p className="hint">
              By status as of {asOf ? `${hhmm(asOf)} UTC` : "the last snapshot"} (an hourly snapshot).
              {spark.gaps
                ? ` The trend has ${spark.gaps} ${spark.gaps === 1 ? "day" : "days"} with no count, drawn as a gap.`
                : ""}
            </p>
            <div className="stat-grid ov-stat-3 ov-divider-top">
              <div className="stat">
                <span className="stat-label">New</span>
                <span className="t-h3 num">+{fmtInt(a.new)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Unsubscribed</span>
                <span className="t-h3 num">{fmtInt(a.unsubscribed)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Suppressed</span>
                <span className="t-h3 num">{fmtInt(a.suppressed)}</span>
              </div>
            </div>
          </div>
        )
      }}
    </Panel>
  )
}

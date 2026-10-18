/**
 * Analytics → Audience (design: audience.html; HANDOFF-ops §15): growth, unsubscribes and suppressions, total
 * contacts per day (a day without a snapshot is a hatched gap, never a dip), the status mix "as of" the hourly
 * snapshot, and subscribers by topic.
 */
import { useQuery } from "@tanstack/react-query"
import { fmtInt, num } from "../lib/format.ts"
import { utcTime } from "../ops/format.ts"
import { countAxis, n0 } from "./logic.ts"
import { audienceQuery, topicsQuery } from "./queries.ts"
import { ChartPanel, dayLong, LineChart, metaFor, SkeletonBlock, shortDay, useRange } from "./shared.tsx"

const STATUS = [
  ["subscribed", "Subscribed", "var(--data-good)"],
  ["unconfirmed", "Unconfirmed", "var(--data-warn)"],
  ["unsubscribed", "Unsubscribed", "var(--data-neutral)"],
  ["bounced", "Bounced", "var(--data-bad)"],
  ["complained", "Complained", "var(--data-bad-strong)"],
  ["suppressed", "Suppressed", "var(--data-bad-soft)"],
] as const

export function AudienceView() {
  const range = useRange("audience")
  const q = useQuery(audienceQuery(range))
  const topics = useQuery(topicsQuery)
  const endpoint = `GET /v1/stats/audience?range=${range}`
  const a = q.data
  return (
    <>
      {a ? (
        <div className="big-figures ana-big">
          <div className="fig">
            <span className="stat-label">New</span>
            <span className="stat-value">+{fmtInt(a.new)}</span>
          </div>
          <div className="fig">
            <span className="stat-label">Unsubscribed</span>
            <span className="stat-value">{fmtInt(a.unsubscribed)}</span>
          </div>
          <div className="fig">
            <span className="stat-label">Suppressed</span>
            <span className="stat-value">{fmtInt(a.suppressed)}</span>
          </div>
          <div className="fig">
            <span className="stat-label">Unconfirmed, double opt-in</span>
            <span className="stat-value">{fmtInt(a.byStatus.unconfirmed)}</span>
            <span className="stat-delta">as of {utcTime(a.asOf)}</span>
          </div>
        </div>
      ) : null}
      <div className="split-even">
        <div className="stack">
          <ChartPanel
            id="growth"
            name="Total contacts"
            title="Total contacts"
            range={range}
            endpoint={endpoint}
            query={q}
            built="HAL-3362"
            csv="audience"
            skeleton={<SkeletonBlock height={200} />}
          >
            {(d) => {
              const values = d.totalByDay.map((x) => num(x.total))
              const axis = countAxis(values, true)
              const first = d.totalByDay[0]?.day
              const last = d.totalByDay[d.totalByDay.length - 1]?.day
              const gaps = values.some((v) => v === null)
              return (
                <>
                  <LineChart
                    label="Total contacts per day; days without a snapshot are gaps"
                    values={values}
                    top={axis.top}
                    ticks={axis.ticks}
                    hatch={values.map((v) => v === null)}
                    hatchTitle="No snapshot"
                    tone="good"
                    first={first ? shortDay(first) : ""}
                    last={last ? shortDay(last) : ""}
                    table={{
                      head: ["Day", "Contacts"],
                      rows: d.totalByDay.map((x) => [
                        dayLong(x.day),
                        x.total === null ? "No snapshot" : fmtInt(x.total),
                      ]),
                    }}
                  />
                  {gaps ? (
                    <p className="hint ana-hint-top">
                      Hatched days have no snapshot (<span className="mono">total: null</span>), so the line
                      breaks rather than guessing.
                    </p>
                  ) : null}
                </>
              )
            }}
          </ChartPanel>
          <ChartPanel
            id="mix"
            name="Contacts by status"
            title={a ? `Contacts by status · as of ${utcTime(a.asOf)}` : "Contacts by status"}
            range={range}
            endpoint={endpoint}
            query={q}
            built="HAL-3362"
            csv="audience"
          >
            {(d) => (
              <div className="stack stack-12">
                <div className="stat">
                  <span className="stat-label">Contacts</span>
                  <span className="stat-value">{fmtInt(d.total)}</span>
                </div>
                <div className="splitbar ana-split18" role="img" aria-label="Contacts by status">
                  {STATUS.filter(([k]) => n0(d.byStatus[k]) > 0).map(([k, , c]) => (
                    <span key={k} style={{ flex: n0(d.byStatus[k]), ["--c" as string]: c }} />
                  ))}
                </div>
                <div className="legend">
                  {STATUS.map(([k, label, c]) => (
                    <span key={k}>
                      <i style={{ ["--c" as string]: c }} />
                      {label} <b className="num ana-fg">{fmtInt(d.byStatus[k])}</b>
                    </span>
                  ))}
                </div>
                <p className="hint">
                  From the hourly snapshot taken at {utcTime(d.asOf)} (<span className="mono">asOf</span>).
                </p>
              </div>
            )}
          </ChartPanel>
        </div>
        <div className="stack">
          <ChartPanel
            id="topics"
            name="Subscribers by topic"
            title="Subscribers by topic"
            meta={metaFor(range)}
            endpoint="GET /v1/topics"
            query={topics}
            empty={(t) =>
              t.topics.some((x) => !x.archived) ? null : <p className="muted t-small">No topics yet.</p>
            }
          >
            {(t) => (
              <ul className="list">
                {t.topics
                  .filter((x) => !x.archived)
                  .sort((x, y) => n0(y.subscribers) - n0(x.subscribers))
                  .map((x) => (
                    <li key={x.id} className="list-row">
                      <span className="grow">
                        <span className="row-title">{x.name}</span>
                        {x.description ? <span className="row-sub">{x.description}</span> : null}
                      </span>
                      <span className="count">{fmtInt(x.subscribers)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </ChartPanel>
        </div>
      </div>
    </>
  )
}

/**
 * Analytics → Engagement (design: engagement.html; HANDOFF-ops §25): per campaign, opens by people and by
 * machines apart, the weekday × hour heatmap in UTC, and unsubscribes by topic. Labelled an estimate throughout.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { fmtInt } from "../lib/format.ts"
import { pct, utcDate } from "../ops/format.ts"
import { Empty } from "../ops/kit.tsx"
import { Icon } from "../ui/icons.tsx"
import { heatGrid, type Metric } from "./logic.ts"
import { engagementQuery } from "./queries.ts"
import { ChartPanel, useRange } from "./shared.tsx"

export function Engagement() {
  const range = useRange("engagement")
  const q = useQuery(engagementQuery(range))
  const [metric, setMetric] = useState<Metric>("opens")
  const endpoint = `GET /v1/stats/engagement?range=${range}`
  return (
    <>
      <div className="callout callout-info ana-note">
        <Icon name="eye" />
        <span>
          <b>Engagement is an estimate.</b> Mail privacy proxies fetch images for people who never open, so
          machine opens are counted separately and left out of the open rate.
        </span>
      </div>
      <div className="stack">
        <ChartPanel
          id="by-campaign"
          name="Engagement by campaign"
          title="By campaign · estimate"
          range={range}
          endpoint={endpoint}
          query={q}
          built="HAL-3366"
          csv="engagement"
          empty={(e) =>
            e.campaigns.length ? null : (
              <Empty
                icon="campaigns"
                title="No campaigns sent in this range"
                action={
                  <Link className="btn btn-secondary btn-sm" to="/campaigns">
                    Open campaigns
                  </Link>
                }
              >
                Opens, clicks and unsubscribes appear per campaign once one goes out.
              </Empty>
            )
          }
        >
          {(e) => (
            <>
              <div className="table-wrap rtable-wrap">
                <table className="rtable">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th className="r">Delivered</th>
                      <th className="r">Opens, people</th>
                      <th className="r">Opens, machines</th>
                      <th className="r">Open rate</th>
                      <th className="r">Clicks</th>
                      <th className="r">Click rate</th>
                      <th className="r">Unsubscribed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.campaigns.map((c) => (
                      <tr key={c.id}>
                        <td className="is-head">
                          <div className="cell-main">
                            <Link to={`/campaigns/${c.id}` as never}>{c.name}</Link>
                            <span className="cell-sub">started {utcDate(c.startedAt)}</span>
                          </div>
                        </td>
                        <td className="r" data-label="Delivered">
                          {fmtInt(c.delivered)}
                        </td>
                        <td className="r" data-label="Opens, people">
                          {fmtInt(c.uniqueOpens)}
                        </td>
                        <td className="r" data-label="Opens, machines">
                          {fmtInt(c.machineOpens)}
                        </td>
                        <td className="r" data-label="Open rate">
                          {pct(c.openRate)}
                        </td>
                        <td className="r" data-label="Clicks">
                          {fmtInt(c.uniqueClicks)}
                        </td>
                        <td className="r" data-label="Click rate">
                          {pct(c.clickRate)}
                        </td>
                        <td className="r" data-label="Unsubscribed">
                          {fmtInt(c.unsubscribed)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint ana-after">
                “People” are unique opens with privacy-proxy fetches taken out; “machines” are those fetches
                (Apple Mail Privacy Protection, Gmail’s image proxy), kept apart and out of the open rate.
              </p>
            </>
          )}
        </ChartPanel>
        <div className="split-even">
          <div className="stack">
            <ChartPanel
              id="heat"
              name="Opens by weekday and hour"
              title={`${metric === "opens" ? "Opens" : "Clicks"} by weekday and hour · estimate`}
              range={range}
              endpoint={`${endpoint} → byHour`}
              query={q}
              built="HAL-3366"
              csv="engagement-hours"
            >
              {(e) => {
                const { grid, summary } = heatGrid(e.byHour, metric)
                return (
                  <div className="stack stack-12">
                    {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
                    <div className="seg" role="group" aria-label="Show">
                      <button
                        type="button"
                        aria-pressed={metric === "opens"}
                        onClick={() => setMetric("opens")}
                      >
                        Opens
                      </button>
                      <button
                        type="button"
                        aria-pressed={metric === "clicks"}
                        onClick={() => setMetric("clicks")}
                      >
                        Clicks
                      </button>
                    </div>
                    <div className="heat" role="img" aria-label={summary}>
                      {grid.map((r) => [
                        <span key={r.weekday} className="hl">
                          {r.weekday}
                        </span>,
                        ...r.cells.map((c) => (
                          <i
                            key={`${r.weekday}-${c.hour}`}
                            style={{ ["--p" as string]: `${c.p}%` }}
                            title={`${r.weekday} ${String(c.hour).padStart(2, "0")}:00 UTC: ${fmtInt(c.opens)} opens, ${fmtInt(c.clicks)} clicks`}
                          />
                        )),
                      ])}
                      <span />
                      {Array.from({ length: 24 }, (_, h) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the 24 hour labels are positional
                        <span key={h} className="hx">
                          {h % 6 === 0 ? h : ""}
                        </span>
                      ))}
                    </div>
                    <div className="scale-legend">
                      Fewer
                      {[5, 30, 60, 90].map((p) => (
                        <i key={p} style={{ ["--p" as string]: `${p}%` }} />
                      ))}
                      More
                    </div>
                    <p className="hint">
                      Hours are <b>UTC</b>, not your local time. Each cell has its opens and clicks on hover.
                    </p>
                  </div>
                )
              }}
            </ChartPanel>
          </div>
          <div className="stack">
            <ChartPanel
              id="unsub"
              name="Unsubscribes by topic"
              title="Unsubscribes by topic"
              range={range}
              endpoint={`${endpoint} → unsubscribesByTopic`}
              query={q}
              built="HAL-3366"
              csv="unsubscribes"
              empty={(e) =>
                e.unsubscribesByTopic.length ? null : (
                  <p className="muted t-small">Nobody unsubscribed from a topic in this range.</p>
                )
              }
            >
              {(e) => (
                <ul className="list">
                  {e.unsubscribesByTopic.map((t) => (
                    <li key={t.topicId} className="list-row">
                      <span className="grow">
                        <span className="row-title">{t.name}</span>
                      </span>
                      <span className="count">{fmtInt(t.unsubscribed)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </ChartPanel>
          </div>
        </div>
      </div>
    </>
  )
}

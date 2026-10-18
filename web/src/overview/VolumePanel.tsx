/** Volume by stream: stacked bars per day (7 d, 30 d) or per hour (24 h), all UTC. */
import { useQuery } from "@tanstack/react-query"
import { fmtInt } from "../lib/format.ts"
import { Panel } from "../ui/Panel.tsx"
import {
  dayLabel,
  hhmm,
  parseDay,
  RANGE_LABEL,
  type Range,
  STREAM_META,
  STREAMS,
  shortDate,
  stackBars,
  weekday,
  xLabelShown,
} from "./logic.ts"
import { volumeQuery } from "./queries.ts"
import { StaleMeta, useOffline } from "./shared.tsx"

export function VolumePanel({ range }: { range: Range }) {
  const offline = useOffline()
  const q = useQuery(volumeQuery(range))
  const by = range === "24h" ? "hour" : "day"
  return (
    <Panel
      id="volume"
      title="Volume by stream"
      to="/analytics"
      linkLabel="Analytics"
      span={8}
      endpoint={`GET /v1/stats/volume?range=${range}&by=${by}`}
      meta={<StaleMeta offline={offline} updatedAt={q.dataUpdatedAt} label={RANGE_LABEL[range]} />}
      query={q}
      skeleton={<VolumeSkeleton />}
    >
      {(v) => {
        const hourly = v.by === "hour"
        const raw = hourly ? v.hours : v.days
        const buckets = raw.map((b) => {
          const at = "hour" in b ? new Date(b.hour) : parseDay(b.day)
          return { at, byStream: b.byStream }
        })
        const { step, cols, totals } = stackBars(buckets)
        const sparse = hourly ? 6 : buckets.length > 10 ? 7 : null
        const labels = buckets.map((b) =>
          hourly ? `${hhmm(b.at).slice(0, 2)}:00` : sparse ? shortDate(b.at) : weekday(b.at),
        )
        const when = (b: { at: Date }) =>
          hourly ? `${weekday(b.at)} ${hhmm(b.at).slice(0, 2)}:00 UTC` : dayLabel(b.at)
        const empty = cols.every((c) => c.total === 0)
        return (
          <div className="stack stack-12">
            <div className="legend">
              {STREAMS.map((s) => (
                <span key={s}>
                  <i className={STREAM_META[s].swatch} />
                  {STREAM_META[s].label} <b className="num ov-fg">{fmtInt(totals[s])}</b>
                </span>
              ))}
            </div>
            <div className="bars ov-bars" style={{ ["--bar-gap" as string]: sparse ? "3px" : "8px" }}>
              <div className="bars-axis" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} style={{ bottom: `${i * 25}%` }}>
                    {fmtInt(step * i)}
                  </span>
                ))}
              </div>
              {/* biome-ignore lint/a11y/useSemanticElements: the design's plot holds grid lines (<i>) beside the bars, which a <ul> can't */}
              <div
                className="bars-plot"
                role="list"
                aria-label={
                  hourly ? "Sends per hour by stream, last 24 hours, UTC" : "Sends per day by stream"
                }
              >
                {[1, 2, 3, 4].map((i) => (
                  <i key={i} className="bars-grid" style={{ bottom: `${i * 25}%` }} />
                ))}
                {cols.map((c, i) => {
                  const b = buckets[i]
                  const tip = `${b ? when(b) : ""}: ${fmtInt(c.total)} sent · ${STREAMS.map((s) => `${s} ${fmtInt(c.values[s])}`).join(", ")}`
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a bar in the design's flex plot; its list is the div above
                    <span
                      key={b?.at.toISOString() ?? i}
                      className="bar-col"
                      role="listitem"
                      aria-label={tip}
                      title={tip}
                    >
                      {c.segs.map((s) => (
                        <span
                          key={s.stream}
                          className="bar-seg"
                          style={{
                            height: `${s.height.toFixed(2)}%`,
                            ["--c" as string]: STREAM_META[s.stream].color,
                          }}
                        />
                      ))}
                    </span>
                  )
                })}
              </div>
              <div className={`bars-x${sparse ? " is-sparse" : ""}`} aria-hidden="true">
                {labels.map((l, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: labels repeat across a 30-day range
                  <span key={i} className={xLabelShown(i, labels.length, sparse) ? "show" : ""}>
                    {l}
                  </span>
                ))}
              </div>
            </div>
            <p className="hint">
              {empty ? "Nothing was sent in this range. " : ""}
              {hourly ? "Hourly, last 24 hours (UTC)." : "Daily (UTC)."} Replies sent from mailboxes count as
              Mailbox. Test sends and mail from outside Mailyard aren’t counted.
            </p>
          </div>
        )
      }}
    </Panel>
  )
}

function VolumeSkeleton() {
  return (
    <div className="bars" aria-hidden="true">
      <div />
      <div className="bars-plot ov-sk-plot">
        {[30, 25, 88, 36, 34, 37, 75].map((h, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <span key={i} className="sk ov-sk-bar" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  )
}

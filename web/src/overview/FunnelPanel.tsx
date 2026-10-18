/** Delivery funnel: sent, then each outcome as a share of sent, plus approximate delivery time. */
import { useQuery } from "@tanstack/react-query"
import { fmtInt, num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { Panel } from "../ui/Panel.tsx"
import { fmtQuantile, fmtRate, funnelRows, RANGE_LABEL, type Range } from "./logic.ts"
import { deliveryQuery } from "./queries.ts"
import { AppLink, PanelFoot, StaleMeta, useOffline } from "./shared.tsx"

/** Mailyard started timing deliveries on this day; earlier sends have no delivery time. */
const TIMING_SINCE = "18 Oct 2026"

export function FunnelPanel({ range }: { range: Range }) {
  const offline = useOffline()
  const q = useQuery(deliveryQuery(range))
  return (
    <Panel
      id="funnel"
      title="Delivery funnel"
      to="/transactional/messages"
      linkLabel="Message log"
      span={8}
      endpoint={`GET /v1/stats/delivery?range=${range}`}
      meta={<StaleMeta offline={offline} updatedAt={q.dataUpdatedAt} label={RANGE_LABEL[range]} />}
      query={q}
      skeleton={<FunnelSkeleton />}
    >
      {(d) => {
        const { sent, rows } = funnelRows(d.totals)
        const dt = d.deliveryTime
        const samples = num(dt.samples) ?? 0
        return (
          <>
            <div className="funnel">
              <AppLink className="funnel-row is-total" href={`/transactional/messages?range=${range}`}>
                <span className="f-label">Sent</span>
                <span className="f-bar">
                  <span style={{ width: sent ? "100%" : "0%", ["--c" as string]: "var(--data-neutral)" }} />
                </span>
                <span className="f-count">{fmtInt(sent)}</span>
                <span className="f-pct">{sent ? "100%" : "—"}</span>
              </AppLink>
              <div className="funnel-sep" />
              {rows.map((r) => (
                <AppLink
                  key={r.key}
                  className="funnel-row"
                  href={`/transactional/messages?status=${r.status}&range=${range}`}
                  aria-label={`${r.label}: ${fmtInt(r.count)}, ${r.pct} of sent`}
                >
                  <span className="f-label">
                    {r.label}
                    {r.sub ? <span className="sub"> · {r.sub}</span> : null}
                  </span>
                  <span className="f-bar">
                    <span style={{ width: `${r.width.toFixed(2)}%`, ["--c" as string]: r.color }} />
                  </span>
                  <span className="f-count">{fmtInt(r.count)}</span>
                  <span className="f-pct">{r.pct}</span>
                </AppLink>
              ))}
            </div>
            {samples === 0 ? (
              <div
                className="callout callout-info ov-mt-12"
                data-endpoint="GET /v1/stats/delivery → deliveryTime"
              >
                <Icon name="clock" />
                <span>
                  <b>Delivery time: collecting since {TIMING_SINCE}.</b> Mailyard started timing deliveries
                  that day, and none has been timed yet in this range.
                </span>
              </div>
            ) : (
              <>
                <div className="spread ov-divider-top" data-endpoint="GET /v1/stats/delivery → deliveryTime">
                  <span className="t-label">
                    Delivery time <span className="pill pill-neutral">approximate</span>
                  </span>
                  <span className="t-label">
                    <b className="num">{fmtQuantile(dt.medianMs, samples)}</b> median ·{" "}
                    <b className="num">{fmtQuantile(dt.p95Ms, samples)}</b> p95
                  </span>
                </div>
                <p className="hint">
                  From {fmtInt(samples)} deliveries timed since {TIMING_SINCE}, when timing started. Values
                  are bucket upper bounds.
                </p>
              </>
            )}
            <PanelFoot>
              {d.rates.insufficientData ? (
                <span>
                  Rates need {fmtInt(d.rates.minimumSends)} sends; {fmtInt(sent)} so far in this range
                </span>
              ) : (
                <span>
                  Delivery rate <b className="num ov-fg">{fmtRate(d.rates.deliveryRate)}</b> · complaints are
                  counted within delivered
                </span>
              )}
            </PanelFoot>
          </>
        )
      }}
    </Panel>
  )
}

function FunnelSkeleton() {
  return (
    <div className="stack stack-12" aria-hidden="true">
      {[100, 92, 18, 9, 6, 4, 8, 3].map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="funnel-row">
          <span className="sk sk-text" style={{ width: "70%" }} />
          <span className="sk sk-bar" style={{ width: `${w}%` }} />
          <span className="sk sk-text" />
          <span className="sk sk-text" />
        </div>
      ))}
    </div>
  )
}

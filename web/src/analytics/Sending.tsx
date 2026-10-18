/**
 * Analytics → Sending (design: sending*.html; HANDOFF-ops §25): the headline figures, volume by stream, rates by
 * day against Cloudflare's lines, delivery time, mailbox providers and deferral reasons. Each panel reads its own
 * endpoint, so one failing never blanks the page.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { fmtInt, num } from "../lib/format.ts"
import { pct } from "../ops/format.ts"
import { Empty } from "../ops/kit.tsx"
import { Icon } from "../ui/icons.tsx"
import {
  deliveredShare,
  fmtLine,
  histogram,
  n0,
  providerName,
  quantile,
  type Range,
  rateAxis,
  STREAM_META,
  STREAMS,
  stackBars,
  xLabelShown,
} from "./logic.ts"
import { deferralsQuery, deliveryQuery, providersQuery, reputationQuery, volumeQuery } from "./queries.ts"
import {
  ChartPanel,
  dayLong,
  LineChart,
  metaFor,
  SkeletonBlock,
  shortDay,
  useRange,
  weekdayOf,
} from "./shared.tsx"

/** Production began recording delivery time and deferral reasons on this day (HANDOFF-ops §25). */
export const HISTORY_SINCE = "18 Oct 2026"

/** Cloudflare's published lines, used only when GET /v1/reputation can't be read; its `policy` wins otherwise. */
const DEFAULT_POLICY = {
  customer_bounce: { warning_at: 0.02, at_risk_at: 0.05, minimum_denominator: 100 },
  complaint: { warning_at: 0.001, at_risk_at: 0.002, minimum_denominator: 100 },
  spam_rejection: { warning_at: 0.01, at_risk_at: 0.03, minimum_denominator: 100 },
}

export function Sending() {
  const range = useRange("sending")
  const delivery = useQuery(deliveryQuery(range))
  const d = delivery.data
  const insufficient = d?.rates.insufficientData === true
  const collecting = d ? n0(d.deliveryTime.samples) === 0 : false
  const minimum = n0(d?.rates.minimumSends) || 100
  return (
    <>
      {d && insufficient ? (
        <div className="callout callout-info ana-note" role="status">
          <Icon name="info" />
          <span>
            <b>Not enough data yet.</b> {fmtInt(d.totals.sent)} of {fmtInt(minimum)} sends in this range.
            Counts are real; rates appear at {fmtInt(minimum)}, the minimum Cloudflare uses, and the hatched
            part of each chart is below it.
          </span>
        </div>
      ) : null}
      {d && collecting && !insufficient ? (
        <div className="callout callout-info ana-note" role="status">
          <Icon name="info" />
          <span>
            <b>Delivery time and deferral reasons are new.</b> Mailyard has recorded them since{" "}
            {HISTORY_SINCE}, so both start empty and fill in as mail goes out. Sent, delivered and the rates
            go back further.
          </span>
        </div>
      ) : null}
      <Figures range={range} />
      <div className="stack">
        <VolumePanel range={range} />
        <div className="split-even">
          <div className="stack">
            <RatesPanel range={range} />
            <DeliveryTimePanel range={range} />
          </div>
          <div className="stack">
            <ProvidersPanel range={range} />
            <DeferralsPanel range={range} />
          </div>
        </div>
      </div>
    </>
  )
}

function Figures({ range }: { range: Range }) {
  const q = useQuery(deliveryQuery(range))
  if (q.isPending)
    return (
      <div className="big-figures ana-big" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="fig">
            <span className="sk sk-text" style={{ width: "50%" }} />
            <span className="sk sk-stat" />
          </div>
        ))}
      </div>
    )
  if (!q.data) return null
  const d = q.data
  const insufficient = d.rates.insufficientData
  const samples = n0(d.deliveryTime.samples)
  return (
    <div className="big-figures ana-big">
      <Link className="fig" to="/transactional/messages">
        <span className="stat-label">Sent</span>
        <span className="stat-value">{fmtInt(d.totals.sent)}</span>
        <span className="stat-delta">{metaFor(range)}</span>
      </Link>
      <div className="fig">
        <span className="stat-label">Delivery rate</span>
        {insufficient ? (
          <span className="stat-value">
            <span className="t-label">Not enough data yet</span>
          </span>
        ) : (
          <span className="stat-value">{pct(d.rates.deliveryRate)}</span>
        )}
        <span className="stat-delta">
          {fmtInt(d.totals.delivered)} delivered
          {insufficient ? ` · ${fmtInt(d.totals.sent)} of ${fmtInt(d.rates.minimumSends)} sends` : ""}
        </span>
      </div>
      <a className="fig" href="#h-delivery-time">
        <span className="stat-label">
          Delivery time, median <span className="pill pill-neutral ana-pill-sm">approximate</span>
        </span>
        {samples ? (
          <>
            <span className="stat-value ana-fig-small">{quantile(d.deliveryTime.medianMs, samples)}</span>
            <span className="stat-delta">95th percentile {quantile(d.deliveryTime.p95Ms, samples)}</span>
          </>
        ) : (
          <>
            <span className="stat-value ana-fig-small">Collecting</span>
            <span className="stat-delta">since {HISTORY_SINCE}</span>
          </>
        )}
      </a>
      <Link className="fig" to="/transactional/messages" search={{ status: "deferred" } as never}>
        <span className="stat-label">Deferred, still retrying</span>
        <span className="stat-value">{fmtInt(d.totals.deferred)}</span>
        <span className="stat-delta">See the reasons below</span>
      </Link>
    </div>
  )
}

function VolumePanel({ range }: { range: Range }) {
  const q = useQuery(volumeQuery(range))
  const by = range === "24h" ? "hour" : "day"
  const endpoint = `GET /v1/stats/volume?range=${range}&by=${by}`
  return (
    <ChartPanel
      id="volume"
      name="Volume by stream"
      title="Volume by stream"
      range={range}
      endpoint={endpoint}
      query={q}
      built="HAL-3366"
      csv="volume"
      skeleton={<SkeletonBlock height={200} />}
    >
      {(v) => {
        const hourly = v.by === "hour"
        const buckets = hourly
          ? v.hours.map((h) => ({ key: h.hour, byStream: h.byStream }))
          : v.days.map((x) => ({ key: x.day, byStream: x.byStream }))
        const { step, cols, totals } = stackBars(buckets)
        const sparse = hourly ? 6 : buckets.length > 10 ? 7 : null
        const label = (k: string) => (hourly ? `${k.slice(11, 13)}:00` : sparse ? shortDay(k) : weekdayOf(k))
        const when = (k: string) =>
          hourly ? `${weekdayOf(k.slice(0, 10))} ${k.slice(11, 13)}:00 UTC` : dayLong(k)
        const nothing = cols.every((c) => c.total === 0)
        return (
          <div className="stack stack-12">
            <div className="legend">
              {STREAMS.map((s) => (
                <span key={s}>
                  <i style={{ ["--c" as string]: STREAM_META[s].color }} />
                  {STREAM_META[s].label} <b className="num ana-fg">{fmtInt(totals[s])}</b>
                </span>
              ))}
            </div>
            <div
              className="bars"
              style={{ ["--bar-gap" as string]: hourly ? "2px" : sparse ? "3px" : "8px" }}
            >
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
                aria-label={hourly ? "Sends per hour, UTC by stream" : "Sends per day by stream"}
              >
                {[1, 2, 3, 4].map((i) => (
                  <i key={i} className="bars-grid" style={{ bottom: `${i * 25}%` }} />
                ))}
                {cols.map((c, i) => {
                  const b = buckets[i]
                  const tip = `${b ? when(b.key) : ""}: ${fmtInt(c.total)} sent · ${STREAMS.map((s) => `${s} ${fmtInt(c.values[s])}`).join(", ")}`
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a bar in the design's flex plot; its list is the div above
                    <span key={b?.key ?? i} className="bar-col" role="listitem" aria-label={tip} title={tip}>
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
                {buckets.map((b, i) => (
                  <span key={b.key} className={xLabelShown(i, buckets.length, sparse) ? "show" : ""}>
                    {label(b.key)}
                  </span>
                ))}
              </div>
            </div>
            <p className="hint">
              {nothing ? "Nothing was sent in this range. " : ""}Four streams, always. Replies from a mailbox
              count as <b>mailbox</b>; test sends and mail that didn’t go through Mailyard aren’t counted.
              {hourly ? " Hourly bars, UTC." : ""}
            </p>
          </div>
        )
      }}
    </ChartPanel>
  )
}

function RatesPanel({ range }: { range: Range }) {
  const q = useQuery(deliveryQuery(range))
  const rep = useQuery(reputationQuery)
  const policy = rep.data?.policy ?? DEFAULT_POLICY
  const endpoint =
    range === "24h" ? "GET /v1/stats/delivery?range=24h" : `GET /v1/stats/delivery?range=${range}&by=day`
  return (
    <ChartPanel
      id="rates-time"
      name="Rates by day"
      title="Rates by day against Cloudflare’s lines"
      range={range}
      endpoint={endpoint}
      query={q}
      built="HAL-3366"
      csv="delivery"
      skeleton={<SkeletonBlock height={420} />}
    >
      {(d) => {
        if (range === "24h")
          return (
            <p className="muted">
              One day is a single point. Rates by day need 7 or 30 days; today’s rates are in the figures
              above.
            </p>
          )
        const lines = [
          { key: "bounceRate", name: "Bounce rate · against sends", line: policy.customer_bounce },
          { key: "complaintRate", name: "Complaint rate · against deliveries", line: policy.complaint },
          { key: "rejectionRate", name: "Spam rejection rate · against sends", line: policy.spam_rejection },
        ] as const
        const insufficient = d.rates.insufficientData
        const minimum = n0(d.rates.minimumSends) || 100
        return (
          <div className="stack stack-24">
            {lines.map((l) => {
              const values = d.days.map((x) => num(x.rates[l.key]))
              const warn = n0(l.line.warning_at)
              const risk = n0(l.line.at_risk_at)
              const axis = rateAxis(values, risk)
              const first = d.days[0]?.day
              const last = d.days[d.days.length - 1]?.day
              return (
                <div key={l.key}>
                  <div className="spread ana-rate-head">
                    <span className="thresh-name">{l.name}</span>
                    <span className="thresh-value">
                      {insufficient ? "Not enough data yet" : pct(d.rates[l.key])}
                    </span>
                  </div>
                  <LineChart
                    label={`${l.name} per day against the warning and at-risk lines`}
                    values={values}
                    top={axis.top}
                    ticks={axis.ticks}
                    thresholds={[
                      { at: axis.at(warn), label: `Warning ${fmtLine(warn)}` },
                      { at: axis.at(risk), label: `At risk ${fmtLine(risk)}`, risk: true },
                    ]}
                    hatch={d.days.map((x) => x.rates.insufficientData)}
                    hatchLabel={`Under ${fmtInt(minimum)} sends`}
                    hatchTitle={`Under ${fmtInt(minimum)} sends: not rated`}
                    first={first ? shortDay(first) : ""}
                    last={last ? shortDay(last) : ""}
                    table={{
                      head: ["Day", l.name],
                      rows: d.days.map((x) => [
                        dayLong(x.day),
                        x.rates.insufficientData ? "Under the minimum" : pct(x.rates[l.key]),
                      ]),
                    }}
                  />
                </div>
              )
            })}
            <p className="hint">
              Lines from{" "}
              {rep.data
                ? rep.data.policySource === "account"
                  ? "this account’s Cloudflare policy"
                  : "Cloudflare’s policy as measured on 16 Oct 2026"
                : "Cloudflare’s published policy (reputation didn’t load)"}
              . Days under {fmtInt(minimum)} sends are hatched and not rated.
            </p>
          </div>
        )
      }}
    </ChartPanel>
  )
}

function DeliveryTimePanel({ range }: { range: Range }) {
  const q = useQuery(deliveryQuery(range))
  return (
    <ChartPanel
      id="delivery-time"
      name="Delivery time"
      title="Delivery time"
      range={range}
      endpoint={`GET /v1/stats/delivery?range=${range} → deliveryTime`}
      query={q}
      built="HAL-3366"
      csv="delivery"
      empty={(d) =>
        n0(d.deliveryTime.samples) === 0 ? (
          <Empty icon="clock" title={`Collecting since ${HISTORY_SINCE}`}>
            Mailyard started recording delivery time on {HISTORY_SINCE}. Nothing older exists, so this fills
            in as mail goes out; the counts above are unaffected.
          </Empty>
        ) : null
      }
    >
      {(d) => {
        const t = d.deliveryTime
        const rows = histogram(t.buckets)
        return (
          <div className="stack stack-12">
            <div className="stat-grid ana-two">
              <div className="stat">
                <span className="stat-label">Median</span>
                <span className="stat-value">{quantile(t.medianMs, t.samples)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">95th percentile</span>
                <span className="stat-value">{quantile(t.p95Ms, t.samples)}</span>
              </div>
            </div>
            <div
              className="hb hist"
              role="img"
              aria-label={`Delivery time histogram, ${fmtInt(t.samples)} messages`}
            >
              {rows.map((r) => (
                <div key={r.label} className="hist-row">
                  <span className="hist-lab">{r.label}</span>
                  <span className="hb-track">
                    <span
                      style={{
                        flex: `0 0 ${r.width.toFixed(1)}%`,
                        ["--c" as string]: "var(--data-transactional)",
                      }}
                    />
                  </span>
                  <span className="hb-n">{fmtInt(r.n)}</span>
                </div>
              ))}
            </div>
            <p className="hint">
              <span className="pill pill-neutral">Approximate</span> Times fall into buckets, so a quantile is
              its bucket’s upper bound. {fmtInt(t.samples)} messages, from accepted to delivered.
            </p>
          </div>
        )
      }}
    </ChartPanel>
  )
}

function ProvidersPanel({ range }: { range: Range }) {
  const q = useQuery(providersQuery(range))
  return (
    <ChartPanel
      id="providers"
      name="Provider results"
      title="By mailbox provider"
      range={range}
      endpoint={`GET /v1/stats/providers?range=${range}`}
      query={q}
      csv="providers"
      skeleton={<SkeletonBlock height={260} />}
      empty={(p) =>
        p.providers.length ? null : (
          <Empty icon="send" title="Nothing delivered in this range">
            Providers appear once mail reaches someone’s inbox.
          </Empty>
        )
      }
    >
      {(p) => (
        <>
          <div className="legend ana-legend">
            <span>
              <i className="swatch-good" />
              Delivered
            </span>
            <span>
              <i className="swatch-warn" />
              Deferred
            </span>
            <span>
              <i className="swatch-bad" />
              Bounced
            </span>
            <span>
              <i style={{ ["--c" as string]: "var(--data-bad-strong)" }} />
              Complained
            </span>
          </div>
          <div className="hb">
            {p.providers.map((r) => {
              const parts = [
                ["delivered", r.delivered, "var(--data-good)"],
                ["deferred", r.deferred, "var(--data-warn)"],
                ["bounced", r.bounced, "var(--data-bad)"],
                ["complained", r.complained, "var(--data-bad-strong)"],
              ] as const
              const share = deliveredShare(r.delivered, r.total)
              return (
                <div key={r.provider} className="hb-row">
                  <span className="hb-name">{providerName(r.provider)}</span>
                  <span
                    className="hb-track"
                    role="img"
                    aria-label={`${r.provider}: ${parts.map(([k, v]) => `${n0(v)} ${k}`).join(", ")}`}
                  >
                    {parts
                      .filter(([, v]) => n0(v) > 0)
                      .map(([k, v, c]) => (
                        <span
                          key={k}
                          style={{ flex: n0(v), ["--c" as string]: c }}
                          title={`${k}: ${n0(v)}`}
                        />
                      ))}
                  </span>
                  <span className="hb-n">{fmtInt(r.total)}</span>
                  <span className="hb-sub">
                    {share === null ? "—" : `${pct(share)} delivered`} · {fmtInt(r.deferred)} deferred ·{" "}
                    {fmtInt(r.bounced)} bounced · {fmtInt(r.complained)} complained
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </ChartPanel>
  )
}

function DeferralsPanel({ range }: { range: Range }) {
  const q = useQuery(deferralsQuery(range))
  const delivery = useQuery(deliveryQuery(range))
  const collecting = delivery.data ? n0(delivery.data.deliveryTime.samples) === 0 : false
  return (
    <ChartPanel
      id="deferrals"
      name="Deferral reasons"
      title="Deferral reasons"
      range={range}
      endpoint={`GET /v1/stats/deferrals?range=${range}`}
      query={q}
      built="HAL-3366"
      csv="deferrals"
      empty={(d) =>
        d.reasons.length ? null : collecting ? (
          <Empty icon="clock" title={`Collecting since ${HISTORY_SINCE}`}>
            Mailyard started recording deferral reasons on {HISTORY_SINCE}. Nothing older exists, so this
            fills in as mail goes out; the counts above are unaffected.
          </Empty>
        ) : (
          <Empty icon="check-circle" title="No deferrals in this range">
            Every message was accepted or refused outright; nothing is waiting on a retry.
          </Empty>
        )
      }
    >
      {(d) => (
        <>
          <div>
            <table className="rtable dfr-table" data-od-id="deferrals">
              <thead>
                <tr>
                  <th className="r">#</th>
                  <th>Reason · SMTP status · provider</th>
                  <th className="r">Count</th>
                </tr>
              </thead>
              <tbody>
                {d.reasons.slice(0, 50).map((r, i) => (
                  <tr key={`${r.reason}-${r.smtpStatus}-${r.provider}`}>
                    <td className="r num" data-label="#">
                      {i + 1}
                    </td>
                    <td className="is-head">
                      <span className="cell-main">
                        <span>{r.reason}</span>
                        <span className="cell-sub">
                          <span className="mono">{r.smtpStatus ?? "no SMTP status"}</span> ·{" "}
                          {providerName(r.provider)}
                        </span>
                      </span>
                    </td>
                    <td className="r num" data-label="Count">
                      {fmtInt(r.count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint ana-after">
            The top 50 reasons, most frequent first. Deferred mail is retried by Mailyard (up to 8 attempts);
            a steady 421 from one provider means the governor’s pace for it could come down.
          </p>
        </>
      )}
    </ChartPanel>
  )
}

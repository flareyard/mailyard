/**
 * The report (design: campaign-report.html, -insufficient, -loading, -error, -viewer; GAPS-audience A7.5–A7.7).
 * `GET /v1/campaigns/{id}/report`: the funnel with machine-only opens shown apart, the rates against the
 * account's own Cloudflare lines, opens and clicks over the first 168 hours, the A/B result, clicks per link,
 * providers, and the recipients (`?status=` is the URL). Under 100 sends every rate reads "Not enough data yet".
 * Resend to non-openers is a sheet at `?resend=1`; Compare campaigns goes to Analytics → Engagement.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { allTopicsQuery, segmentsQuery } from "../../audience/kit/queries.ts"
import {
  ApiErrorCallout,
  BackLink,
  SampleMarker,
  StatusPill,
  useCan,
  useNow,
} from "../../audience/kit/ui.tsx"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import {
  classifyRate,
  DEFAULT_POLICY,
  fmtRate,
  LEVEL_PILL,
  type Line,
  thresholdGeometry,
} from "../../overview/logic.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError } from "../../ui/Panel.tsx"
import { useCampaign } from "../editor/EditorContext.tsx"
import {
  activitySummary,
  activityTitle,
  audienceLine,
  fillActivity,
  fmtStamp,
  fmtWhen,
  funnelRows,
  humanOpens,
  INSUFFICIENT,
  niceMax,
  type RecipientFilter,
  recipientLabel,
  recipientPill,
  recipientsCsv,
} from "../logic.ts"
import {
  type Campaign,
  type Recipient,
  type Report,
  recipientsQuery,
  reportQuery,
  reputationQuery,
} from "../queries.ts"
import { AppLink } from "../ui.tsx"
import { ResendSheet } from "./ResendSheet.tsx"

type Props = {
  id: string
  status?: RecipientFilter | undefined
  cursor?: string | undefined
  resend?: 1 | undefined
}
type Search = { status?: RecipientFilter; cursor?: string; resend?: 1 }

/** The report's URL state with some keys changed; `undefined` drops a key. */
function withSearch(
  cur: Props,
  patch: { status?: RecipientFilter | undefined; cursor?: string | undefined; resend?: 1 | undefined },
): Search {
  const next = { status: cur.status, cursor: cur.cursor, resend: cur.resend, ...patch }
  return {
    ...(next.status ? { status: next.status } : {}),
    ...(next.cursor ? { cursor: next.cursor } : {}),
    ...(next.resend ? { resend: next.resend } : {}),
  }
}

export function CampaignReport({ id, status, cursor, resend }: Props) {
  const campaign = useCampaign(id)
  const report = useQuery({
    ...reportQuery(id),
    refetchInterval: (q) =>
      q.state.data && "status" in q.state.data && q.state.data.status === "sending" ? 30_000 : false,
  })
  const c = campaign.data && "status" in campaign.data ? campaign.data : null
  const r = report.data && "campaignId" in report.data ? report.data : null
  const navigate = useNavigate()
  const here = { id, status, cursor, resend }
  const closeResend = () =>
    void navigate({
      to: "/campaigns/$campaignId/report",
      params: { campaignId: id },
      search: withSearch(here, { resend: undefined }),
      replace: true,
    })
  return (
    <>
      <BackLink to="/campaigns">Campaigns</BackLink>
      {c ? <Head c={c} r={r} here={here} /> : null}
      {report.isPending ? (
        <ReportSkeleton />
      ) : !r ? (
        <section
          className="panel is-error"
          data-endpoint={`GET /v1/campaigns/${id}/report`}
          data-od-id="panel-report"
          aria-labelledby="h-report"
        >
          <header className="panel-head">
            <h2 className="panel-title" id="h-report">
              Report
            </h2>
          </header>
          <div className="panel-body">
            <PanelError error={report.error} onRetry={() => report.refetch()} what="The report didn’t load" />
          </div>
        </section>
      ) : (
        <div className="grid-12">
          {r.insufficientData ? (
            <div className="callout callout-info span-12" role="status">
              <Icon name="info" />
              <span>
                <b>{INSUFFICIENT}.</b>{" "}
                {r.status === "cancelled"
                  ? `It was cancelled after ${fmtInt(r.sent)} sends.`
                  : `${fmtInt(r.sent)} of ${fmtInt(r.minimumSends)} sends so far.`}{" "}
                Every rate and the machine-open share stay empty until then, so no percentage is shown
                anywhere; the counts below are real.
              </span>
            </div>
          ) : null}
          {!r.tracked ? (
            <div className="callout callout-warn span-12" role="status">
              <Icon name="eye" />
              <span>
                <b>Open and click tracking was off for this campaign.</b> Opens, clicks and the activity chart
                stay empty; deliveries, bounces and complaints are counted either way.
              </span>
            </div>
          ) : null}
          <Funnel r={r} c={c} here={here} />
          <Rates r={r} />
          <Activity r={r} startedAt={c?.startedAt ?? null} />
          <AbPanel r={r} />
          <Links r={r} />
          <Providers r={r} />
          <Recipients here={here} total={r.sent} />
        </div>
      )}
      {resend && c ? <ResendSheet campaign={c} report={r} onClose={closeResend} /> : null}
    </>
  )
}

function Head({ c, r, here }: { c: Campaign; r: Report | null; here: Props }) {
  const status = here.status
  const segments = useQuery(segmentsQuery)
  const topics = useQuery(allTopicsQuery)
  const write = useCan("campaigns.write", "resend campaigns")
  const now = useNow(60_000)
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<unknown>(null)
  const when =
    c.status === "cancelled"
      ? `Cancelled ${fmtStamp(c.finishedAt ?? c.updatedAt, now)}`
      : c.status === "sent"
        ? `Sent ${fmtStamp(c.finishedAt ?? c.startedAt, now)}`
        : num(c.startedAt) !== null
          ? `Started ${fmtStamp(c.startedAt, now)}`
          : `Scheduled ${fmtWhen(c.sendAt)}`
  const resendBlock = !write.allowed
    ? {
        reason: write.me?.role === "viewer" ? "Viewers can’t resend campaigns" : "You can’t resend campaigns",
        who: write.who,
      }
    : c.status !== "sent"
      ? { reason: "Resend once the campaign has finished sending", who: undefined }
      : !c.trackOpens
        ? { reason: "Without open tracking there’s no telling who didn’t open", who: undefined }
        : null
  const exportAll = async () => {
    setExporting(true)
    setExportErr(null)
    try {
      const all: Recipient[] = []
      let next: string | null | undefined
      for (let page = 0; page < 500; page++) {
        const res = await unwrap(
          api.GET("/v1/campaigns/{id}/recipients", {
            params: {
              path: { id: c.id },
              query: { limit: "200", ...(next ? { cursor: next } : {}), ...(status ? { status } : {}) },
            },
          }),
        )
        all.push(...(res?.recipients ?? []))
        next = res?.nextCursor
        if (!next) break
      }
      const blob = new Blob([recipientsCsv(all)], { type: "text/csv;charset=utf-8" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `${
        c.name
          .replace(/[^\w-]+/g, "-")
          .replace(/^-|-$/g, "")
          .toLowerCase() || c.id
      }-recipients${status ? `-${status}` : ""}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    } catch (e) {
      setExportErr(e)
    } finally {
      setExporting(false)
    }
  }
  return (
    <>
      <div className="obj-head" data-od-id="object-head">
        <div className="oh-main">
          <h1 data-od-id="page-title">{c.name}</h1>
          <div className="oh-sub">
            <StatusPill status={c.status} />
            <code className="mono">{c.id}</code>
            <span>
              {audienceLine(c, {
                segment: segments.data?.find((s) => s.id === c.segmentId)?.name,
                topic: topics.data?.find((t) => t.id === c.topicId)?.name,
              })}
            </span>
            <span>{when}</span>
          </div>
        </div>
        <div className="oh-actions">
          <SampleMarker />
          {c.status === "sending" || c.status === "paused" ? (
            <Link className="btn btn-ghost btn-sm" to="/campaigns/$campaignId" params={{ campaignId: c.id }}>
              <Icon name="pulse" />
              Sending view
            </Link>
          ) : null}
          <AppLink
            className="btn btn-ghost btn-sm"
            href="/analytics/engagement?range=30d"
            data-od-id="engagement-link"
          >
            <Icon name="analytics" />
            Compare campaigns
          </AppLink>
          <button
            className={`btn btn-ghost btn-sm${exporting ? " is-loading" : ""}`}
            type="button"
            data-endpoint={`GET /v1/campaigns/${c.id}/recipients (all pages → CSV)`}
            onClick={exportAll}
            disabled={exporting || !r || num(r.sent) === 0}
          >
            {exporting ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" />}
            Export
          </button>
          <Gated allowed={!resendBlock} reason={resendBlock?.reason} who={resendBlock?.who} side="right">
            <Link
              className="btn btn-secondary btn-sm"
              to="/campaigns/$campaignId/report"
              params={{ campaignId: c.id }}
              search={withSearch(here, { resend: 1 })}
              data-endpoint={`POST /v1/campaigns/${c.id}/resend-non-openers`}
              data-od-id="resend"
            >
              <Icon name="replay" />
              Resend to non-openers
            </Link>
          </Gated>
        </div>
      </div>
      {exportErr ? <ApiErrorCallout error={exportErr} what="The export didn’t finish." /> : null}
    </>
  )
}

function Funnel({ r, c, here }: { r: Report; c: Campaign | null; here: Props }) {
  const id = here.id
  const rows = funnelRows(r, c?.replyTo)
  const machine = num(r.machineOnlyOpens) ?? 0
  return (
    <section
      className="panel span-8"
      data-endpoint={`GET /v1/campaigns/${id}/report → funnel counts`}
      data-od-id="panel-funnel"
      aria-labelledby="h-funnel"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-funnel">
          Delivery funnel
        </h2>
      </header>
      <div className="panel-body">
        <div className="legend" style={{ marginBottom: 10 }}>
          <span>
            <i className="swatch-good" />
            Human opens
          </span>
          <span>
            <i className="swatch-neutral" />
            Machine-only opens
          </span>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's .funnel grid rows, as the Overview's funnel */}
        <div className="funnel" role="list">
          {rows.map((row) => {
            const inner = (
              <>
                <span className="f-label">
                  {row.label}
                  {row.sub ? <span className="sub">{row.sub}</span> : null}
                </span>
                <span className="f-bar">
                  <span style={{ width: `${row.width}%`, ["--c" as string]: row.color }} />
                  {row.machine !== undefined ? (
                    <span
                      style={{
                        left: `${row.width}%`,
                        width: `${row.machine}%`,
                        ["--c" as string]: "var(--data-neutral)",
                      }}
                    />
                  ) : null}
                </span>
                <span className="f-count">{fmtInt(row.count)}</span>
                <span className="f-pct">{row.pct}</span>
              </>
            )
            const cls = `funnel-row${row.total ? " is-total" : ""}`
            return (
              // biome-ignore lint/a11y/useSemanticElements: a display:contents wrapper keeps the design's grid rows
              <div key={row.key} role="listitem" style={{ display: "contents" }}>
                {row.sepBefore ? <div className="funnel-sep" /> : null}
                {row.status ? (
                  <Link
                    className={cls}
                    to="/campaigns/$campaignId/report"
                    params={{ campaignId: id }}
                    search={withSearch(here, { status: row.status, cursor: undefined })}
                    hash="recipients"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className={cls}>{inner}</div>
                )}
              </div>
            )
          })}
        </div>
        <div className="callout callout-info" style={{ marginTop: 12 }}>
          <Icon name="eye" />
          {r.insufficientData || num(r.machineOpenShare) === null ? (
            <span>
              <b>
                Machine-only opens: {fmtInt(machine)} of {fmtInt(r.opened)}.
              </b>{" "}
              Their share (<code className="mono">machineOpenShare</code>): not enough data yet (100 sends
              needed). Apple Mail Privacy Protection fetches images without a person reading, so opens run
              high; clicks are the trustworthy signal.
            </span>
          ) : (
            <span>
              <b>Apple Mail Privacy Protection inflates opens.</b> {fmtInt(machine)} of {fmtInt(r.opened)}{" "}
              opens ({Math.round((num(r.machineOpenShare) ?? 0) * 100)}%,{" "}
              <code className="mono">machineOpenShare</code>) were machine-only: Apple’s proxy fetched the
              images without a person reading it. People opened{" "}
              {fmtRate(
                num(r.delivered)
                  ? humanOpens(r.opened, r.machineOnlyOpens) / (num(r.delivered) as number)
                  : null,
              )}{" "}
              of delivered; clicks are the trustworthy signal.
            </span>
          )}
        </div>
      </div>
      <footer className="panel-foot">
        <span>
          Delivered, opened, clicked and unsubscribed are shares of delivered; bounces and failures of sent;
          complaints of delivered.
        </span>
      </footer>
    </section>
  )
}

function Thresh({
  name,
  anchor,
  rate,
  line,
  sent,
  insufficient,
}: {
  name: string
  anchor: string
  rate: unknown
  line: Line
  sent: unknown
  insufficient: boolean
}) {
  const level = classifyRate(rate as number, line, { sent: sent as number, insufficient })
  const g = thresholdGeometry(rate as number, line.warning_at, line.at_risk_at)
  const warn = fmtRate(line.warning_at)
  const risk = fmtRate(line.at_risk_at)
  const lines = (
    <>
      <i className="thresh-line" style={{ left: `${g.warnAt.toFixed(1)}%` }} />
      <i className="thresh-line risk" style={{ left: `${g.riskAt.toFixed(1)}%` }} />
    </>
  )
  const scale = (
    <div className="thresh-scale" aria-hidden="true">
      <span style={{ left: `${g.warnAt.toFixed(1)}%` }}>Warning {warn}</span>
      <span className="risk" style={{ left: `${g.riskAt.toFixed(1)}%` }}>
        At risk {risk}
      </span>
    </div>
  )
  if (level === "insufficient-data")
    return (
      <AppLink className="thresh is-insufficient cmp-plain-link" href={`/domains/reputation#${anchor}`}>
        <div className="thresh-head">
          <span className="thresh-name">{name}</span>
          <span className="pill pill-neutral">Not enough data yet</span>
        </div>
        <div
          className="thresh-track"
          role="img"
          aria-label={`${name}: not enough data yet, ${fmtInt(sent as number)} of 100 sends`}
        >
          {lines}
        </div>
        {scale}
        <div className="thresh-note">
          {fmtInt(sent as number)} of 100 sends. Cloudflare doesn’t rate an account under 100, so neither do
          we.
        </div>
      </AppLink>
    )
  const pill = LEVEL_PILL[level]
  return (
    <AppLink className={`thresh is-${level} cmp-plain-link`} href={`/domains/reputation#${anchor}`}>
      <div className="thresh-head">
        <span className="thresh-name">{name}</span>
        <span className="cluster">
          <span className="thresh-value">{fmtRate(rate as number)}</span>
          <span className={`pill ${pill.cls}`}>
            <span className="dot" />
            {pill.label}
          </span>
        </span>
      </div>
      <div
        className="thresh-track"
        role="img"
        aria-label={`${name} ${fmtRate(rate as number)}; warning at ${warn}, at risk at ${risk}`}
      >
        <span className="thresh-fill" style={{ width: `${g.fill.toFixed(2)}%` }} />
        {lines}
      </div>
      {scale}
    </AppLink>
  )
}

function Rates({ r }: { r: Report }) {
  const rep = useQuery(reputationQuery)
  const policy = rep.data && "policy" in rep.data ? rep.data.policy : DEFAULT_POLICY
  const source = rep.data && "policySource" in rep.data ? rep.data.policySource : null
  const no = r.insufficientData
  const human = num(r.delivered)
    ? humanOpens(r.opened, r.machineOnlyOpens) / (num(r.delivered) as number)
    : null
  const row = (label: string, v: unknown) => (
    <div className="row" key={label}>
      <span>{label}</span>
      {no || v === null || v === undefined ? (
        <span className="not-enough">{no ? INSUFFICIENT : "—"}</span>
      ) : (
        <b>{fmtRate(v as number)}</b>
      )}
    </div>
  )
  return (
    <section
      className="panel span-4"
      data-endpoint="GET /v1/campaigns/:id/report → rates · GET /v1/reputation policy"
      data-od-id="panel-rates"
      aria-labelledby="h-rates"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-rates">
          Against Cloudflare’s lines
        </h2>
      </header>
      <div className="panel-body">
        <div>
          <Thresh
            name="Bounce rate · of sent"
            anchor="bounce"
            rate={r.rates.bounce}
            line={policy.customer_bounce}
            sent={r.sent}
            insufficient={no}
          />
          <Thresh
            name="Complaint rate · of delivered"
            anchor="complaint"
            rate={r.rates.complaint}
            line={policy.complaint}
            sent={r.sent}
            insufficient={no}
          />
        </div>
        <div className="lc-split" style={{ marginTop: 12 }}>
          {row("Delivery", r.rates.delivery)}
          {row("Opens, all", r.rates.open)}
          {row("Opens by people", no ? null : human)}
          {row("Clicks", r.rates.click)}
          {row("Click to open", r.rates.clickToOpen)}
          {row("Unsubscribes", r.rates.unsubscribe)}
          {row("Machine-open share", r.machineOpenShare)}
        </div>
      </div>
      <footer className="panel-foot">
        <span>
          {source ? (
            <>
              Lines are this account’s Cloudflare policy (policySource <code className="mono">{source}</code>
              ).{" "}
            </>
          ) : (
            "Lines are Cloudflare’s published defaults while the account’s policy can’t be read. "
          )}
          “Opens by people” is opened minus machineOnlyOpens, over delivered.
        </span>
      </footer>
    </section>
  )
}

function Activity({ r, startedAt }: { r: Report; startedAt: number | string | null }) {
  const points = fillActivity(r.activity)
  const s = activitySummary(points)
  const top = niceMax(s.max)
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const start = num(startedAt)
  return (
    <section
      className="panel span-8"
      data-endpoint="GET /v1/campaigns/:id/report → activity"
      data-od-id="panel-activity"
      aria-labelledby="h-activity"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-activity">
          Opens and clicks over time
        </h2>
      </header>
      <div className="panel-body">
        {r.insufficientData ? (
          <div className="empty" data-od-id="empty-state">
            <span className="empty-icon">
              <Icon name="analytics" />
            </span>
            <h3>Too little to chart</h3>
            <p>
              {fmtInt(r.sent)} sends so far{r.status === "cancelled" ? " before it was cancelled" : ""}.
              Activity charts start at {fmtInt(r.minimumSends)}.
            </p>
          </div>
        ) : s.total === 0 ? (
          <div className="empty" data-od-id="empty-state">
            <span className="empty-icon">
              <Icon name="analytics" />
            </span>
            <h3>No opens yet</h3>
            <p>Opens and clicks show here hour by hour for the first 7 days after sending starts.</p>
          </div>
        ) : (
          <>
            <div className="legend" style={{ marginBottom: 10 }}>
              <span>
                <i className="swatch-camp" />
                First opens
              </span>
              <span>
                <i className="swatch-tx" />
                Of which clicked
              </span>
              {start !== null ? <span>Sending started {fmtWhen(start)}</span> : null}
            </div>
            <div
              className="bars hours-chart"
              role="img"
              aria-label={`Opens by hour after sending started: ${s.firstDayShare}% of opens came in the first 24 hours; the busiest hour was hour ${s.peak.hour} with ${fmtInt(s.peak.opens)} opens`}
            >
              <div className="bars-axis">
                {ticks.map((t) => (
                  <span key={t} style={{ bottom: `${t * 100}%` }}>
                    {fmtInt(Math.round(top * t))}
                  </span>
                ))}
              </div>
              <div className="bars-plot">
                {ticks.slice(1).map((t) => (
                  <i key={t} className="bars-grid" style={{ bottom: `${t * 100}%` }} />
                ))}
                {[1, 2, 3, 4, 5, 6].map((d) => (
                  <i key={d} className="day-line" style={{ left: `${((d * 24) / 168) * 100}%` }} />
                ))}
                {points.map((p) => (
                  <span key={p.hour} className="bar-col" title={activityTitle(p, start)}>
                    <span
                      className="bar-seg"
                      style={{
                        height: `${((p.clicks / top) * 100).toFixed(2)}%`,
                        ["--c" as string]: "var(--data-transactional)",
                      }}
                    />
                    <span
                      className="bar-seg"
                      style={{
                        height: `${(((p.opens - p.clicks) / top) * 100).toFixed(2)}%`,
                        ["--c" as string]: "var(--data-campaign)",
                      }}
                    />
                  </span>
                ))}
              </div>
              <div className="hours-x" aria-hidden="true">
                {[0, 24, 48, 72, 96, 120, 144, 168].map((h) => (
                  <span key={h} style={{ left: `${((h / 168) * 100).toFixed(3)}%` }}>
                    {h}
                  </span>
                ))}
              </div>
              <div className="hours-cap">Hours after sending started · a line marks each day</div>
            </div>
            <details className="stack stack-8" style={{ marginTop: 12 }}>
              <summary className="label" style={{ cursor: "pointer", minHeight: 24 }}>
                {s.firstDayShare}% of opens came in the first 24 hours · by day
              </summary>
              <div className="lc-split">
                {s.days.map((n, d) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: seven fixed days
                  <div key={d} className="row">
                    <span>
                      Day {d + 1} · hours {d * 24}–{d * 24 + 23}
                      {start !== null
                        ? ` · from ${fmtWhen(start + d * 86_400_000).replace(/, \d\d:\d\d UTC$/, "")} UTC`
                        : ""}
                    </span>
                    <b>{fmtInt(n)} opens</b>
                  </div>
                ))}
              </div>
            </details>
            <p className="hint" style={{ marginTop: 8 }}>
              <code className="mono">activity[].hour</code> is whole hours from{" "}
              <code className="mono">startedAt</code> to each contact’s first open, 0–167, so the chart covers
              the first 7 days. Hover a bar for its day, hour and clock time.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

function AbPanel({ r }: { r: Report }) {
  const ab = r.ab
  return (
    <section
      className="panel span-4"
      data-endpoint="GET /v1/campaigns/:id/report → ab"
      data-od-id="panel-ab"
      aria-labelledby="h-ab"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-ab">
          A/B result
        </h2>
      </header>
      <div className="panel-body">
        {!ab ? (
          <p className="hint">
            No A/B test on this campaign (<code className="mono">ab: null</code>).
          </p>
        ) : (
          <div className="stack stack-12">
            <div className="abcards" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
              {ab.variants.map((v) => {
                const win = ab.winner === v.variant
                const sent = num(v.sent) ?? 0
                const rate = (x: unknown) =>
                  r.insufficientData || !sent ? "—" : fmtRate((num(x as number) ?? 0) / sent)
                return (
                  <div key={v.variant} className={`abcard${win ? " is-winner" : ""}`}>
                    <div className="spread">
                      <span className="ab-tag">{v.variant.toUpperCase()}</span>
                      {win ? (
                        <span className="pill pill-pass">
                          <span className="dot" />
                          Winner · by {ab.metric}
                        </span>
                      ) : null}
                    </div>
                    <span className="ab-subj">{v.subject}</span>
                    <div className="ab-stats">
                      <div className="stat">
                        <span className="stat-label">Sent</span>
                        <span className="stat-value cmp-ab-value">{fmtInt(sent)}</span>
                      </div>
                      <div className="stat">
                        <span className="stat-label">Opened</span>
                        <span className="stat-value cmp-ab-value">{rate(v.opened)}</span>
                      </div>
                      <div className="stat">
                        <span className="stat-label">Clicked</span>
                        <span className="stat-value cmp-ab-value">{rate(v.clicked)}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="hint">
              {ab.winner
                ? `${ab.winner.toUpperCase()} won on ${ab.metric} and went to the rest.`
                : "The test is still running; the winner goes to the rest when it ends."}
              {ab.metric === "opens"
                ? " Opens include machine opens, so the next test should pick by clicks."
                : ""}
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

function Links({ r }: { r: Report }) {
  const max = Math.max(1, ...r.links.map((l) => num(l.clicks) ?? 0))
  return (
    <section
      className="panel span-6"
      data-endpoint="GET /v1/campaigns/:id/report → links"
      data-od-id="panel-links"
      aria-labelledby="h-links"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-links">
          Clicks per link
        </h2>
      </header>
      <div className="panel-body">
        {r.links.length === 0 ? (
          <p className="hint">No clicks yet.</p>
        ) : (
          <>
            <div className="linkbars">
              {r.links.map((l) => (
                <div key={l.url} className="linkbar">
                  <div className="lb-url">
                    <code className="mono" title={l.url}>
                      {l.url}
                    </code>
                    <div className="lb-track">
                      <span style={{ width: `${Math.round(((num(l.clicks) ?? 0) / max) * 100)}%` }} />
                    </div>
                  </div>
                  <span className="lb-n">{fmtInt(l.clicks)}</span>
                  <span className="lb-p">{fmtInt(l.machineClicks)} machine</span>
                </div>
              ))}
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Machine clicks are link scanners in corporate mail, counted apart.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

function Providers({ r }: { r: Report }) {
  return (
    <section
      className="panel span-6"
      data-endpoint="GET /v1/campaigns/:id/report → providers"
      data-od-id="panel-providers"
      aria-labelledby="h-providers"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-providers">
          By mailbox provider
        </h2>
      </header>
      <div className="panel-body">
        {r.insufficientData || r.providers.length === 0 ? (
          <p className="hint">Too few sends to split by provider.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th className="r">Sent</th>
                  <th className="r">Delivered</th>
                  <th className="r">Opened</th>
                  <th className="r">Bounced</th>
                  <th className="r">Complained</th>
                </tr>
              </thead>
              <tbody>
                {r.providers.map((p) => {
                  const sent = num(p.sent) ?? 0
                  const del = num(p.delivered) ?? 0
                  return (
                    <tr key={p.provider}>
                      <td>{p.provider.replace(/^./, (c) => c.toUpperCase())}</td>
                      <td className="r">{fmtInt(sent)}</td>
                      <td className="r">{sent ? `${((del / sent) * 100).toFixed(1)}%` : "—"}</td>
                      <td className="r">
                        {del ? `${(((num(p.opened) ?? 0) / del) * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className="r">{fmtInt(p.bounced)}</td>
                      <td className="r">{fmtInt(p.complained)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

const FILTER_LABEL: Record<RecipientFilter, string> = {
  delivered: "Delivered",
  opened: "Opened",
  clicked: "Clicked",
  bounced: "Bounced",
  complained: "Complained",
  unsubscribed: "Unsubscribed",
  failed: "Failed",
  pending: "Pending",
}
const TAB_ORDER: readonly RecipientFilter[] = [
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "unsubscribed",
  "failed",
  "pending",
]

function Recipients({ here, total }: { here: Props; total: number }) {
  const { id, status, cursor } = here
  const q = useQuery(recipientsQuery(id, status, cursor))
  const now = useNow(60_000)
  const data = q.data && "recipients" in q.data ? q.data : null
  return (
    <section
      className="panel span-12"
      id="recipients"
      data-endpoint={`GET /v1/campaigns/${id}/recipients?status=&cursor=&limit=`}
      data-od-id="panel-recipients"
      aria-labelledby="h-recipients"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-recipients">
          Recipients
        </h2>
      </header>
      <div className="panel-body">
        <nav className="au-tabs" aria-label="Filter recipients" style={{ margin: "0 0 8px" }}>
          <Link
            className="au-tab"
            to="/campaigns/$campaignId/report"
            params={{ campaignId: id }}
            search={withSearch(here, { status: undefined, cursor: undefined })}
            aria-current={status ? undefined : "page"}
            activeProps={{}}
          >
            All
          </Link>
          {TAB_ORDER.map((t) => (
            <Link
              key={t}
              className="au-tab"
              to="/campaigns/$campaignId/report"
              params={{ campaignId: id }}
              search={withSearch(here, { status: t, cursor: undefined })}
              aria-current={status === t ? "page" : undefined}
              activeProps={{}}
            >
              {FILTER_LABEL[t]}
            </Link>
          ))}
        </nav>
        {q.isPending ? (
          <div className="stack stack-8" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows
              <span key={i} className="sk sk-text" />
            ))}
          </div>
        ) : !data ? (
          <PanelError error={q.error} onRetry={() => q.refetch()} what="Recipients didn’t load" />
        ) : data.recipients.length === 0 ? (
          <p className="hint" style={{ padding: "12px 0" }}>
            {status ? `Nobody is ${FILTER_LABEL[status].toLowerCase()}.` : "No recipients yet."}
          </p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table dt">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Status</th>
                    <th>Provider</th>
                    <th>Variant</th>
                    <th className="r">Opens</th>
                    <th className="r">Clicks</th>
                    <th className="r">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recipients.map((x) => (
                    <tr key={x.messageId}>
                      <td>
                        {x.contactId ? (
                          <AppLink className="cell-link" href={`/audience/contacts/${x.contactId}`}>
                            {x.name ?? x.email}
                          </AppLink>
                        ) : (
                          <span className="cell-link">{x.name ?? x.email}</span>
                        )}
                        <span className="cell-sub mono">{x.email}</span>
                      </td>
                      <td>
                        <span className={`pill ${recipientPill(x.status)}`}>
                          <span className="dot" />
                          {recipientLabel(x.status, x.bounceType)}
                        </span>
                      </td>
                      <td>{x.provider ? x.provider.replace(/^./, (c) => c.toUpperCase()) : "—"}</td>
                      <td>{x.variant ? x.variant.toUpperCase() : "—"}</td>
                      <td className="r">
                        {fmtInt(x.opens)}
                        {num(x.machineOpens) ? (
                          <span className="cell-sub">{fmtInt(x.machineOpens)} machine</span>
                        ) : null}
                      </td>
                      <td className="r">{fmtInt(x.clicks)}</td>
                      <td className="r">
                        <AppLink className="link-quiet" href={`/transactional/messages/${x.messageId}`}>
                          {fmtStamp(x.sentAt, now)}
                        </AppLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dt-foot">
              <span>
                {fmtInt(data.recipients.length)}{" "}
                {status ? FILTER_LABEL[status].toLowerCase() : `of ${fmtInt(total)}`} on this page · status is
                a URL filter
              </span>
              <span className="cluster">
                {cursor ? (
                  <Link
                    className="btn btn-ghost btn-sm"
                    to="/campaigns/$campaignId/report"
                    params={{ campaignId: id }}
                    search={withSearch(here, { cursor: undefined })}
                  >
                    First page
                  </Link>
                ) : null}
                {data.nextCursor ? (
                  <Link
                    className="btn btn-secondary btn-sm"
                    to="/campaigns/$campaignId/report"
                    params={{ campaignId: id }}
                    search={withSearch(here, { cursor: data.nextCursor ?? undefined })}
                  >
                    Next page
                    <Icon name="chevron-right" />
                  </Link>
                ) : null}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function ReportSkeleton() {
  const block = (span: number, h: number) => (
    <section className={`panel span-${span}`} aria-busy="true">
      <div className="panel-body stack stack-8">
        <span className="sk sk-title" />
        <span className="sk sk-bar" style={{ height: h }} />
      </div>
    </section>
  )
  return (
    <div className="grid-12" aria-busy="true">
      {block(8, 220)}
      {block(4, 220)}
      {block(8, 180)}
      {block(4, 180)}
      {block(12, 240)}
    </div>
  )
}

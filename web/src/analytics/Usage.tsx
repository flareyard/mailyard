/**
 * Analytics → Usage and cost (design: usage*.html): today's quota from Cloudflare (or "unknown" when it didn't
 * answer), the billing month with its projection, a send forecast (both arms of GET /v1/usage/forecast), and
 * storage in R2 split by kind and mailbox.
 */
import { useQuery } from "@tanstack/react-query"
import { type FormEvent, type ReactNode, useState } from "react"
import { fmtAgo, fmtIn, fmtInt, fmtUsd, num } from "../lib/format.ts"
import { utcDate, utcShort, utcTime } from "../ops/format.ts"
import { BuiltPill } from "../ops/kit.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../ui/Panel.tsx"
import {
  extraCost,
  fmtStorage,
  forecastStrip,
  monthLines,
  n0,
  parseRecipients,
  storageText,
} from "./logic.ts"
import { forecastQuery, storageQuery, usageQuery } from "./queries.ts"

const DEFAULT_RECIPIENTS = 3400

function Shell({
  id,
  title,
  meta,
  endpoint,
  pill,
  children,
}: {
  id: string
  title: string
  meta?: string | undefined
  endpoint: string
  pill?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      className="panel"
      data-endpoint={endpoint}
      data-od-id={`panel-${id}`}
      aria-labelledby={`h-${id}`}
    >
      <header className="panel-head">
        <h2 className="panel-title" id={`h-${id}`}>
          {title}
        </h2>
        <div className="cluster">
          {meta ? <span className="panel-meta">{meta}</span> : null}
          {pill}
        </div>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function Usage() {
  return (
    <div className="split-even">
      <div className="stack">
        <TodayPanel />
        <ForecastPanel />
      </div>
      <div className="stack">
        <MonthPanel />
        <StoragePanel />
      </div>
    </div>
  )
}

function TodayPanel() {
  const q = useQuery(usageQuery)
  const t = q.data?.today
  return (
    <Shell
      id="today"
      title="Daily quota"
      meta={t ? `source: ${t.source}` : undefined}
      endpoint="GET /v1/usage → today"
    >
      {q.isPending ? (
        <PanelSkeleton rows={3} />
      ) : q.isError || !t ? (
        <PanelError error={q.error} onRetry={() => q.refetch()} what="Today’s quota didn’t load" />
      ) : (
        <div className="stack stack-12">
          <div className="stat">
            <span className="stat-label">Sent today</span>
            <span className="stat-value">
              {fmtInt(t.sent)}
              {t.quota !== null ? (
                <span className="t-label muted ana-unit"> of {fmtInt(t.quota)}</span>
              ) : null}
            </span>
          </div>
          {t.quota !== null ? (
            // biome-ignore lint/a11y/useSemanticElements: the design's meter is a styled track and fill, which <meter> can't take
            <div
              className="meter ana-meter"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={n0(t.quota)}
              aria-valuenow={n0(t.sent)}
              aria-label="Sent today"
            >
              <span
                style={{ width: `${Math.min(100, (n0(t.sent) / (n0(t.quota) || 1)) * 100).toFixed(1)}%` }}
              />
            </div>
          ) : (
            <div className="meter meter-unknown ana-meter" role="img" aria-label="Quota unknown" />
          )}
          {t.source === "cloudflare" ? (
            <dl className="kv">
              <dt>Remaining</dt>
              <dd>{fmtInt(t.remaining)}</dd>
              <dt>Resets</dt>
              <dd>
                {t.resetsAt ? `${utcTime(t.resetsAt)} · ${fmtIn(t.resetsAt)}` : "00:00 UTC"}
                {t.overQuota ? " · used up, sends wait for the reset" : ""}
              </dd>
              <dt>Source</dt>
              <dd>
                Cloudflare <span className="mono">/email/sending/limits</span>
              </dd>
            </dl>
          ) : (
            <div className="callout callout-warn">
              <Icon name="warn" />
              <span>
                {t.source === "cloudflare-unreachable" ? (
                  <>
                    <b>Cloudflare didn’t answer</b>, so today’s quota is unknown (
                    <span className="mono">today.source: cloudflare-unreachable</span>). Sending continues on
                    the fallback quota. Month figures come from our own ledger and are exact.
                  </>
                ) : (
                  <>
                    <b>Cloudflare isn’t connected</b>, so today’s quota is unknown (
                    <span className="mono">today.source: not-connected</span>). Month figures come from our
                    own ledger and are exact.
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </Shell>
  )
}

function ForecastPanel() {
  const [text, setText] = useState(fmtInt(DEFAULT_RECIPIENTS))
  const [recipients, setRecipients] = useState(DEFAULT_RECIPIENTS)
  const [invalid, setInvalid] = useState(false)
  const q = useQuery(forecastQuery(recipients))
  const usage = useQuery(usageQuery)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = parseRecipients(text)
    setInvalid(n === null)
    if (n !== null) setRecipients(n)
  }
  const f = q.data
  return (
    <Shell id="forecast" title="Forecast a send" endpoint={`GET /v1/usage/forecast?recipients=${recipients}`}>
      <div className="forecast">
        <form className="stack stack-12" onSubmit={submit} noValidate>
          <div className="field">
            <label className="label" htmlFor="fc-n">
              Recipients
            </label>
            <input
              className="input"
              id="fc-n"
              name="recipients"
              inputMode="numeric"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={invalid || undefined}
              aria-describedby="fc-n-hint"
            />
            <span className={invalid ? "field-error" : "hint"} id="fc-n-hint">
              {invalid
                ? "Enter a whole number of recipients, such as 3,400."
                : "How many people the send would reach."}
            </span>
          </div>
          <button className="btn btn-secondary" type="submit">
            <Icon name="clock" />
            Forecast
          </button>
        </form>
        <div className="forecast-out" aria-live="polite">
          {q.isPending ? (
            <PanelSkeleton rows={4} />
          ) : q.isError || !f ? (
            <PanelError error={q.error} onRetry={() => q.refetch()} what="The forecast didn’t load" />
          ) : f.possible ? (
            <>
              <div className="stat">
                <span className="stat-label">Finishes</span>
                <span className="stat-value">{f.finishesBy ? utcShort(f.finishesBy) : "—"}</span>
              </div>
              <dl className="kv">
                <dt>Sendable today</dt>
                <dd>
                  {fmtInt(f.sendableToday)} of today’s {fmtInt(f.quota)}
                </dd>
                <dt>Extra days</dt>
                <dd>{fmtInt(f.additionalDays)}</dd>
                <dt>Billed after</dt>
                <dd>{fmtInt(f.cost.billedAfter)} this month</dd>
                <dt>Extra cost</dt>
                <dd>
                  <b>{fmtUsd(f.cost.extraUsd)}</b>
                </dd>
              </dl>
              <div
                className="day-strip"
                style={{ ["--days" as string]: f.days.length }}
                role="img"
                aria-label={`Sends per day: ${forecastStrip(f.days, f.quota)
                  .map((d) => `${d.label} ${fmtInt(d.n)}`)
                  .join(", ")}`}
              >
                {forecastStrip(f.days, f.quota).map((d, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: days are positional from today
                  <span key={i}>
                    <i>
                      <b style={{ height: `${d.height}%` }} />
                    </i>
                    {d.label}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="callout callout-warn">
                <Icon name="warn" />
                <span>
                  <b>Can’t plan this yet.</b> {f.reason}
                </span>
              </div>
              {usage.data ? (
                <p className="hint">
                  The cost part doesn’t need Cloudflare: {fmtInt(f.recipients)} more sends this month would
                  cost about{" "}
                  {fmtUsd(
                    extraCost(
                      usage.data.month.billed,
                      usage.data.month.included,
                      usage.data.pricing.usdPerThousand,
                      n0(f.recipients),
                    ),
                  )}{" "}
                  on top.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Shell>
  )
}

function MonthPanel() {
  const q = useQuery(usageQuery)
  const u = q.data
  return (
    <Shell id="month" title="This billing month" endpoint="GET /v1/usage → month, pricing">
      {q.isPending ? (
        <PanelSkeleton rows={4} />
      ) : q.isError || !u ? (
        <PanelError error={q.error} onRetry={() => q.refetch()} what="The billing month didn’t load" />
      ) : (
        (() => {
          const m = monthLines(u.month)
          const per = n0(u.pricing.usdPerThousand)
          const monthEnd = new Date(Date.parse(u.month.from))
          monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0)
          return (
            <div className="stack stack-12">
              <div className="stat">
                <span className="stat-label">
                  Billed since {utcDate(u.month.from).replace(/ \d{4}$/, "")}
                </span>
                <span className="stat-value">
                  {fmtInt(m.billed)}{" "}
                  <span className="t-label muted ana-unit">of {fmtInt(m.included)} included</span>
                </span>
              </div>
              <div
                className="meter ana-meter"
                role="img"
                aria-label={`Billed ${fmtInt(m.billed)} of ${fmtInt(m.included)} included; projected ${fmtInt(m.projected)}`}
              >
                <i className="meter-proj" style={{ width: `${m.projectedPct.toFixed(1)}%` }} />
                <span style={{ width: `${m.billedPct.toFixed(1)}%` }} />
              </div>
              <div className="legend">
                <span>
                  <i style={{ ["--c" as string]: "var(--gray-1000)" }} />
                  Billed
                </span>
                <span>
                  <i style={{ ["--c" as string]: "var(--gray-500)" }} />
                  Projected by {utcDate(monthEnd.getTime()).replace(/ \d{4}$/, "")}
                </span>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    <tr>
                      <td>Overage so far</td>
                      <td className="r">
                        {fmtInt(m.overage)} × ${per.toFixed(2)} / 1,000 = <b>{fmtUsd(u.month.costUsd)}</b>
                      </td>
                    </tr>
                    <tr>
                      <td>Projected month end</td>
                      <td className="r">
                        <b>{fmtInt(m.projected)}</b>
                      </td>
                    </tr>
                    <tr>
                      <td>Projected overage</td>
                      <td className="r">
                        {fmtInt(m.projectedOverage)} × ${per.toFixed(2)} / 1,000
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <b>Projected cost</b>
                      </td>
                      <td className="r">
                        <b>{fmtUsd(u.month.projectedCostUsd)}</b>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="hint">
                {fmtInt(u.pricing.includedPerMonth)} included a month, then ${per.toFixed(2)} per 1,000. Hard
                bounces count; sends blocked by suppression don’t; sends to your verified addresses are free.
                Prices read {utcDate(u.pricing.measuredAt)}.
              </p>
            </div>
          )
        })()
      )}
    </Shell>
  )
}

function StoragePanel() {
  const q = useQuery(storageQuery)
  const s = q.data
  const parts = s
    ? ([
        ["Mail", s.mailBytes, "var(--data-mailbox)"],
        ["Exports", s.exportsBytes, "var(--data-campaign)"],
        ["Uploads", s.uploadsBytes, "var(--data-automation)"],
      ] as const)
    : []
  const total = s ? fmtStorage(s.totalBytes) : null
  return (
    <Shell
      id="storage"
      title="Storage in R2"
      endpoint="GET /v1/usage/storage"
      pill={<BuiltPill issue="HAL-3366" />}
    >
      {q.isPending ? (
        <PanelSkeleton rows={4} />
      ) : q.isError || !s || !total ? (
        <PanelError error={q.error} onRetry={() => q.refetch()} what="Storage didn’t load" />
      ) : (
        <div className="stack stack-12">
          <div className="stat">
            <span className="stat-label">Total</span>
            <span className="stat-value">
              {total.value} <span className="unit">{total.unit}</span>
            </span>
          </div>
          <div className="splitbar ana-split14" role="img" aria-label="Storage by kind">
            {parts
              .filter(([, v]) => n0(v) > 0)
              .map(([k, v, c]) => (
                <span
                  key={k}
                  style={{ flex: n0(v), ["--c" as string]: c }}
                  title={`${k}: ${storageText(v)}`}
                />
              ))}
          </div>
          <div className="legend">
            {parts.map(([k, v, c]) => (
              <span key={k}>
                <i style={{ ["--c" as string]: c }} />
                {k} <b className="num ana-fg">{storageText(v)}</b>
              </span>
            ))}
          </div>
          {s.byMailbox.length ? (
            <div>
              <table className="rtable">
                <thead>
                  <tr>
                    <th>Mailbox</th>
                    <th className="r">Messages</th>
                    <th className="r">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byMailbox.map((m) => (
                    <tr key={m.mailboxId}>
                      <td className="is-head">
                        <span className="mono">{m.address}</span>
                      </td>
                      <td className="r" data-label="Messages">
                        {num(m.messages) === null ? (
                          <span className="muted">not measured</span>
                        ) : (
                          fmtInt(m.messages)
                        )}
                      </td>
                      <td className="r" data-label="Size">
                        {num(m.bytes) === null ? (
                          <span className="muted">not measured</span>
                        ) : (
                          storageText(m.bytes)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="hint">
            Measured {fmtAgo(s.measuredAt)} (<span className="mono">measuredAt</span>). A mailbox that hasn’t
            been measured yet says so rather than showing 0. Billed by Cloudflare on your account, not by
            Mailyard.
          </p>
        </div>
      )}
    </Shell>
  )
}

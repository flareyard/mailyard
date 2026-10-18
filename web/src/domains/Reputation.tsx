/**
 * Reputation (design: reputation, -at-risk, -not-connected, -not-enough-data; HANDOFF-ops §5, §14). Each rate
 * against Cloudflare's lines from `GET /v1/reputation.policy`, saying which `policySource` they came from.
 * Bounce and spam rejection count against sends, complaints against deliveries. Under the minimum, no rate is
 * judged and the track hatches. At risk: the countdown to suspension and Pause all campaigns. Without the
 * Cloudflare connection the rates are Mailyard's own counts against the default lines.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { useMe } from "../auth/session.ts"
import { fmtInt, num } from "../lib/format.ts"
import { pct, utcShort, utcTime } from "../ops/format.ts"
import { hasScope } from "../ops/roles.ts"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { Panel } from "../ui/Panel.tsx"
import {
  countdown,
  LEVEL_CLASS,
  LEVEL_PILL,
  type Level,
  policyLine,
  type Reputation,
  reputationState,
  suspensionAt,
  thresholdGeometry,
} from "./logic.ts"
import { activeCampaignsQuery, reputationQuery } from "./queries.ts"
import { DomainsHead, StatePill } from "./ui.tsx"
import "./domains.css"

export function ReputationPage() {
  const q = useQuery(reputationQuery)
  const atRisk = q.data ? reputationState(q.data).label === "At risk" : false
  return (
    <>
      <DomainsHead
        sub="Cloudflare judges the whole account on these rates. Under the at-risk line for 168 hours, sending is suspended."
        actions={atRisk ? <PauseAll /> : null}
      />
      <div className="split-2">
        <div className="stack">
          <Panel
            id="rates"
            title="Each rate against its lines"
            endpoint="GET /v1/reputation"
            query={q}
            meta={q.data ? `${fmtInt(q.data.totals.sent)} sends in 30 days` : undefined}
          >
            {(r) => <Rates r={r} />}
          </Panel>
          <section
            className="panel"
            data-endpoint="GET /v1/reputation/drivers (not filed)"
            data-od-id="panel-drivers"
            aria-labelledby="h-drivers"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-drivers">
                What drove each rate
              </h2>
              <div className="cluster">
                <span className="pill pill-proposal" data-od-id="proposed-marker">
                  Proposed · not filed
                  <span className="sr-only">
                    . GET /v1/reputation/drivers isn’t in the live API and has no issue: HAL-3366 shipped
                    analytics without it.
                  </span>
                </span>
              </div>
            </header>
            <div className="panel-body">
              <p className="muted">
                Mailyard can’t yet show which sends drove a rate. The bounces and complaints themselves are in{" "}
                <Link to="/transactional">the message log</Link>, filtered by status.
              </p>
            </div>
          </section>
        </div>
        <div className="stack">
          <Panel
            id="rules"
            title="How Cloudflare judges you"
            endpoint="GET /v1/reputation → policy"
            query={q}
          >
            {(r) => <Rules r={r} />}
          </Panel>
        </div>
      </div>
    </>
  )
}

function Rates({ r }: { r: Reputation }) {
  const state = reputationState(r)
  const minimum = num(r.rates.minimumSends) ?? 100
  const sent = num(r.totals.sent) ?? 0
  const p = r.policy
  const suspends = state.label === "At risk" ? suspensionAt(r) : null
  return (
    <div className="stack stack-16">
      <div className="spread">
        <div className="stack stack-4">
          <span className="cluster">
            <StatePill state={state} big />
            {r.statusSince && r.source !== "not-connected" ? (
              <span className="t-small muted">since {utcShort(r.statusSince)}</span>
            ) : null}
          </span>
          <span className="source-line">
            {r.source === "not-connected"
              ? "Judged on our own rates: Cloudflare reputation isn’t connected, so these are Mailyard’s counts against the default lines"
              : `Judged by Cloudflare · ${policyLine(r.policySource)}${r.evaluatedAt ? ` · evaluated ${utcTime(r.evaluatedAt)}` : ""}`}
          </span>
        </div>
        <span className="source-line">
          Window <b>{r.window}</b> · minimum <b>{fmtInt(minimum)}</b> sends
        </span>
      </div>
      {r.source === "not-connected" ? (
        <div className="callout callout-info">
          <Icon name="info" />
          <span>
            <b>Cloudflare reputation isn’t connected.</b> The status, grace countdown and complaint counts
            need a Cloudflare token with Email Sending read. Until then the lines below are Cloudflare’s
            published defaults and the rates are ours.
          </span>
          <Link
            className="btn btn-secondary btn-sm dm-callout-action"
            to={"/settings/sending" as "/settings"}
          >
            Connect
          </Link>
        </div>
      ) : null}
      {suspends ? <AtRisk at={suspends} since={r.graceStartedAt ?? r.statusSince} levels={r.levels} /> : null}
      <div>
        <Thresh
          id="bounce"
          name="Bounce rate"
          value={r.rates.bounceRate}
          level={r.levels.bounce}
          warningAt={num(p.customer_bounce.warning_at) ?? 0.02}
          atRiskAt={num(p.customer_bounce.at_risk_at) ?? 0.05}
          sent={sent}
          minimum={num(p.customer_bounce.minimum_denominator) ?? minimum}
        />
        <Thresh
          id="complaint"
          name="Complaint rate · against deliveries"
          value={r.rates.complaintRate}
          level={r.levels.complaint}
          warningAt={num(p.complaint.warning_at) ?? 0.001}
          atRiskAt={num(p.complaint.at_risk_at) ?? 0.002}
          sent={sent}
          minimum={num(p.complaint.minimum_denominator) ?? minimum}
        />
        <Thresh
          id="spam"
          name="Spam rejection rate"
          value={r.rates.rejectionRate}
          level={r.levels.spamRejection}
          warningAt={num(p.spam_rejection.warning_at) ?? 0.01}
          atRiskAt={num(p.spam_rejection.at_risk_at) ?? 0.03}
          sent={sent}
          minimum={num(p.spam_rejection.minimum_denominator) ?? minimum}
        />
      </div>
    </div>
  )
}

function AtRisk({ at, since, levels }: { at: number; since: string | null; levels: Reputation["levels"] }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const which = [
    levels.bounce === "at-risk" ? "Bounce rate" : null,
    levels.complaint === "at-risk" ? "Complaint rate" : null,
    levels.spamRejection === "at-risk" ? "Spam rejection rate" : null,
  ].filter(Boolean)
  return (
    <div className="callout callout-error" role="alert">
      <Icon name="octagon" />
      <span>
        <b>At risk{since ? ` since ${utcShort(since)}` : ""}.</b> Cloudflare suspends sending 168 hours after
        going at risk:{" "}
        <span className="countdown" data-countdown={new Date(at).toISOString()}>
          {countdown(at, now)}
        </span>
        .{" "}
        {which.length
          ? `${which.join(" and ")} ${which.length === 1 ? "has" : "have"} to fall under the at-risk line over the 30-day window.`
          : "Rates have to fall under the at-risk lines over the 30-day window."}
      </span>
    </div>
  )
}

function Thresh({
  id,
  name,
  value,
  level,
  warningAt,
  atRiskAt,
  sent,
  minimum,
}: {
  id: string
  name: string
  value: number | string | null
  level: Level
  warningAt: number
  atRiskAt: number
  sent: number
  minimum: number
}) {
  const v = num(value)
  const insufficient = level === "insufficient-data" || v === null
  const g = thresholdGeometry(insufficient ? null : v, warningAt, atRiskAt)
  const pill = LEVEL_PILL[insufficient ? "insufficient-data" : level]
  const lines = `warning at ${pct(warningAt)}, at risk at ${pct(atRiskAt)}`
  return (
    <div className={`thresh ${LEVEL_CLASS[insufficient ? "insufficient-data" : level]}`} id={id}>
      <div className="thresh-head">
        <span className="thresh-name">{name}</span>
        {insufficient ? (
          <span className="pill pill-neutral">{pill.label}</span>
        ) : (
          <span className="cluster">
            <span className="thresh-value">{pct(v)}</span>
            <StatePill state={pill} />
          </span>
        )}
      </div>
      <div
        className="thresh-track"
        role="img"
        aria-label={
          insufficient
            ? `${name}: not enough data yet, ${fmtInt(sent)} of ${fmtInt(minimum)} sends`
            : `${name} ${pct(v)}; ${lines}`
        }
      >
        {g.fill !== null ? <span className="thresh-fill" style={{ width: `${g.fill.toFixed(2)}%` }} /> : null}
        <i className="thresh-line" style={{ left: `${g.warning.toFixed(1)}%` }} />
        <i className="thresh-line risk" style={{ left: `${g.risk}%` }} />
      </div>
      <div className="thresh-scale" aria-hidden="true">
        <span style={{ left: `${g.warning.toFixed(1)}%` }}>Warning {pct(warningAt)}</span>
        <span className="risk" style={{ left: `${g.risk}%` }}>
          At risk {pct(atRiskAt)}
        </span>
      </div>
      {insufficient ? (
        <div className="thresh-note">
          {fmtInt(sent)} of {fmtInt(minimum)} sends. Cloudflare doesn’t rate an account under{" "}
          {fmtInt(minimum)}, so neither do we.
        </div>
      ) : null}
    </div>
  )
}

function Rules({ r }: { r: Reputation }) {
  const p = r.policy
  const min = num(r.rates.minimumSends) ?? 100
  const hours = num(p.suspension_after_hours) ?? 168
  return (
    <ul className="role-list">
      <li>
        <Icon name="info" />
        <span>Bounce and spam-rejection rates are counted against sends; complaints against deliveries.</span>
      </li>
      <li>
        <Icon name="info" />
        <span>
          Under {fmtInt(min)} sends in the window, no rate is judged. We show “Not enough data yet”.
        </span>
      </li>
      <li>
        <Icon name="warn" />
        <span>
          Warning lines: bounce {pct(p.customer_bounce.warning_at)}, complaint {pct(p.complaint.warning_at)},
          spam rejection {pct(p.spam_rejection.warning_at)}. At risk: {pct(p.customer_bounce.at_risk_at)},{" "}
          {pct(p.complaint.at_risk_at)}, {pct(p.spam_rejection.at_risk_at)}.
        </span>
      </li>
      <li>
        <Icon name="octagon" />
        <span>At risk for {fmtInt(hours)} hours means suspension.</span>
      </li>
      <li>
        <Icon name="info" />
        <span>
          Lines:{" "}
          {r.policySource === "account" ? "read from this Cloudflare account" : policyLine(r.policySource)}.
        </span>
      </li>
    </ul>
  )
}

/**
 * Pause every active campaign (`POST /v1/campaigns/{id}/pause`, one call each, as the design notes), for an
 * account at risk. Needs the send scope.
 */
function PauseAll() {
  const me = useMe()
  const qc = useQueryClient()
  const active = useQuery(activeCampaignsQuery)
  const list = (active.data?.campaigns ?? []).filter(
    (c) => c.status === "sending" || c.status === "scheduled",
  )
  const pause = useMutation({
    mutationFn: async () => {
      const out = await Promise.allSettled(
        list.map((c) => unwrap(api.POST("/v1/campaigns/{id}/pause", { params: { path: { id: c.id } } }))),
      )
      return {
        ok: out.filter((o) => o.status === "fulfilled").length,
        failed: out.filter((o) => o.status === "rejected").length,
      }
    },
    onSuccess: ({ ok, failed }) => {
      void qc.invalidateQueries({ queryKey: ["campaigns"] })
      toast(
        failed
          ? {
              tone: "warn",
              title: `Paused ${ok} of ${ok + failed} campaigns`,
              sub: "The rest refused; open Campaigns to see why.",
            }
          : { title: `Paused ${ok} campaign${ok === 1 ? "" : "s"}` },
      )
    },
    onError: (e) => toast({ tone: "bad", title: "Nothing was paused", sub: e.message }),
  })
  const allowed = hasScope(me.data, "send")
  return (
    <Gated
      allowed={allowed && list.length > 0}
      side="right"
      reason={allowed ? "No campaign is sending" : "You can’t pause campaigns"}
      who={
        allowed
          ? "Campaigns that are sending or scheduled can be paused from here."
          : "Owners, admins and senders can pause a campaign."
      }
    >
      <button
        className={`btn btn-danger${pause.isPending ? " is-loading" : ""}`}
        type="button"
        onClick={() => pause.mutate()}
        data-endpoint="POST /v1/campaigns/{id}/pause (each)"
      >
        {pause.isPending ? <span className="spinner" /> : <Icon name="pause" />}
        Pause all campaigns{list.length ? ` (${list.length})` : ""}
      </button>
    </Gated>
  )
}

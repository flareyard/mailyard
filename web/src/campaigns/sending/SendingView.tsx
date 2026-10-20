/**
 * The sending view (design: campaign-sending.html, -cancel, -paused-reputation, -paused-complaint, -paused-admin,
 * -held-quota, -held-warmup; GAPS-audience A7.11, A7.12). Progress from `GET /v1/campaigns/{id}/pace`, polled
 * every 5 s: sent of audience, the ETA, the pace ("160 an hour"; "Paused" when `ratePerHour` is null, never 0) and
 * the outcomes. A pause is routed by `pausedBy` and quotes `pausedReason`; a hold (`heldUntil`, `heldBy`) isn't a
 * pause: it says when it carries on, with no Resume. The side shows the governor's shared pace.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { AlertRef } from "../../audience/kit/AlertRef.tsx"
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
import { fmtIn, fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError } from "../../ui/Panel.tsx"
import {
  audienceLine,
  fmtHeld,
  fmtStamp,
  fmtWhen,
  HELD_BY_WORDS,
  isHeld,
  recipientsLine,
  sentPct,
} from "../logic.ts"
import { type Campaign, campaignQuery, governorQuery, paceQuery } from "../queries.ts"
import { AppLink } from "../ui.tsx"
import { CancelSheet, ResumeAnywaySheet, useCampaignAction } from "./actions.tsx"

const PROVIDERS = ["gmail", "microsoft", "yahoo", "apple", "other"] as const
const PROVIDER_LABEL: Record<(typeof PROVIDERS)[number], string> = {
  gmail: "Gmail",
  microsoft: "Microsoft",
  yahoo: "Yahoo",
  apple: "Apple",
  other: "Other",
}

export function SendingView({ campaign: initial }: { campaign: Campaign }) {
  const live = useQuery({ ...campaignQuery(initial.id), refetchInterval: 15_000 })
  const c = live.data && "status" in live.data ? live.data : initial
  const active = c.status === "sending" || c.status === "scheduled"
  const pace = useQuery({ ...paceQuery(c.id), refetchInterval: active ? 5000 : false })
  const segments = useQuery(segmentsQuery)
  const topics = useQuery(allTopicsQuery)
  const write = useCan("campaigns.write", "pause, resume and cancel campaigns")
  const pause = useCampaignAction(c.id, "pause")
  const resume = useCampaignAction(c.id, "resume")
  const [cancelling, setCancelling] = useState(false)
  const [resumeAnyway, setResumeAnyway] = useState(false)
  const now = useNow(30_000)
  const held = isHeld(c)
  const auto = c.status === "paused" && (c.pausedBy === "bounce_rate" || c.pausedBy === "complaint_rate")
  const p = pace.data && "sent" in pace.data ? pace.data : null
  const sent = num(p?.sent) ?? 0
  const audience = num(c.audienceSize) ?? sent + (num(p?.remaining) ?? 0)
  const pct = sentPct(sent, audience)
  const rate = num(p?.ratePerHour)
  const segName = segments.data?.find((s) => s.id === c.segmentId)?.name
  const topicName = topics.data?.find((t) => t.id === c.topicId)?.name
  const bounceRate = sent ? (num(p?.bounced) ?? 0) / sent : null
  const complaintRate = num(p?.delivered) ? (num(p?.complained) ?? 0) / (num(p?.delivered) as number) : null

  const pauseButton = (
    <Gated allowed={write.allowed} reason="You can’t pause campaigns" who={write.who} side="right">
      <button
        className={`btn ${held ? "btn-secondary" : "btn-primary"} btn-sm${pause.isPending ? " is-loading" : ""}`}
        type="button"
        data-endpoint={`POST /v1/campaigns/${c.id}/pause`}
        data-od-id="pause"
        onClick={() => pause.mutate()}
      >
        {pause.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="pause" />}
        Pause
      </button>
    </Gated>
  )
  const resumeButton = (
    <Gated allowed={write.allowed} reason="You can’t resume campaigns" who={write.who} side="right">
      <button
        className={`btn ${auto ? "btn-secondary" : "btn-primary"} btn-sm${resume.isPending ? " is-loading" : ""}`}
        type="button"
        data-endpoint={`POST /v1/campaigns/${c.id}/resume`}
        data-od-id="resume"
        onClick={() => (auto ? setResumeAnyway(true) : resume.mutate())}
      >
        {resume.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" />}
        {auto ? "Resume anyway…" : "Resume"}
      </button>
    </Gated>
  )

  return (
    <>
      <BackLink to="/campaigns">Campaigns</BackLink>
      <div className="obj-head" data-od-id="object-head">
        <div className="oh-main">
          <h1 data-od-id="page-title">{c.name}</h1>
          <div className="oh-sub">
            <StatusPill status={c.status} />
            <code className="mono">{c.id}</code>
            <span>
              {audienceLine(c, { segment: segName, topic: topicName })} · {recipientsLine(c.audienceSize)}
            </span>
            <span>
              {num(c.startedAt) !== null
                ? `Started ${fmtStamp(c.startedAt, now)}`
                : `Starts ${fmtWhen(c.sendAt)}`}
            </span>
          </div>
        </div>
        <div className="oh-actions">
          <SampleMarker />
          <Gated allowed={write.allowed} reason="You can’t cancel campaigns" who={write.who}>
            <button
              className="btn btn-danger-ghost btn-sm"
              type="button"
              data-endpoint={`POST /v1/campaigns/${c.id}/cancel`}
              onClick={() => setCancelling(true)}
            >
              <Icon name="x" />
              Cancel…
            </button>
          </Gated>
          {c.status === "paused" ? resumeButton : pauseButton}
        </div>
      </div>
      {pause.isError ? <ApiErrorCallout error={pause.error} what="It wasn’t paused." /> : null}
      {resume.isError ? <ApiErrorCallout error={resume.error} what="It didn’t resume." /> : null}
      <div className="editor cmp-editor">
        <div className="stack">
          <section
            className={`panel${pace.isError ? " is-error" : ""}`}
            data-endpoint={`GET /v1/campaigns/${c.id}/pace`}
            data-od-id="panel-progress"
            aria-labelledby="h-progress"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-progress">
                Progress
              </h2>
              <div className="cluster">
                <span className="panel-meta">
                  {c.status === "paused" ? "Paused" : held ? "Held · polling every 5 s" : "Polling every 5 s"}
                </span>
              </div>
            </header>
            <div className="panel-body">
              <div className="stack stack-16">
                <PauseCallout c={c} remaining={p?.remaining} now={now} />
                {pace.isPending ? (
                  <div className="stack stack-8" aria-hidden="true">
                    <span className="sk sk-title" />
                    <span className="sk sk-bar" />
                  </div>
                ) : !p ? (
                  <PanelError error={pace.error} onRetry={() => pace.refetch()} what="Progress didn’t load" />
                ) : (
                  <>
                    <div className="bigprog">
                      <div className="bp-top">
                        <span>
                          <span className="bp-n">{fmtInt(sent)}</span>{" "}
                          <span className="bp-of">
                            of {fmtInt(audience)} sent · {Math.round(pct)}%
                          </span>
                        </span>
                        <span className="muted">
                          {c.status === "paused" ? (
                            "No ETA while paused"
                          ) : held ? (
                            <>
                              Carries on at <b>{fmtHeld(c.heldUntil)}</b>
                              {num(p.eta.at) !== null ? (
                                <>
                                  {" "}
                                  · ETA <b>{fmtWhen(p.eta.at)}</b>
                                </>
                              ) : null}
                            </>
                          ) : num(p.eta.at) !== null ? (
                            <>
                              ETA <b>{fmtStamp(p.eta.at, now)}</b> at today’s quota
                            </>
                          ) : (
                            "ETA once the pace settles"
                          )}
                        </span>
                      </div>
                      <div
                        className={`progress${c.status === "paused" ? " is-paused" : ""}`}
                        role="progressbar"
                        aria-valuenow={sent}
                        aria-valuemax={audience}
                        aria-label="Sent"
                      >
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <div
                      className="pace-rate"
                      data-od-id="pace-rate"
                      data-endpoint={`GET /v1/campaigns/${c.id}/pace · ratePerHour`}
                    >
                      <span className="label">Pace</span>
                      <b className={rate === null ? "is-paused" : ""}>
                        {rate === null ? "Paused" : `${fmtInt(rate)} an hour`}
                      </b>
                      <span className="hint">
                        {rate === null
                          ? `No sends go out while it’s paused${p.reason ? `: ${p.reason}` : ""}`
                          : held
                            ? "Sends in the last hour; 0 while it’s held"
                            : "Sends in the last hour"}
                      </span>
                    </div>
                    <div className="bigstats">
                      <div>
                        <span className="bs-l">
                          <i className="sw" style={{ ["--c" as string]: "var(--data-good)" }} />
                          Delivered
                        </span>
                        <span className="bs-v">{fmtInt(p.delivered)}</span>
                      </div>
                      <div className={c.pausedBy === "bounce_rate" ? "is-bad" : ""}>
                        <span className="bs-l">
                          <i className="sw" style={{ ["--c" as string]: "var(--data-bad)" }} />
                          Bounced
                        </span>
                        <span className="bs-v">{fmtInt(p.bounced)}</span>
                        {c.pausedBy === "bounce_rate" && bounceRate !== null ? (
                          <span className="bs-s">{(bounceRate * 100).toFixed(1)}% of sent</span>
                        ) : null}
                      </div>
                      <div className={c.pausedBy === "complaint_rate" ? "is-bad" : ""}>
                        <span className="bs-l">
                          <i className="sw" style={{ ["--c" as string]: "var(--data-bad-strong)" }} />
                          Complained
                        </span>
                        <span className="bs-v">{fmtInt(p.complained)}</span>
                        {c.pausedBy === "complaint_rate" && complaintRate !== null ? (
                          <span className="bs-s">{(complaintRate * 100).toFixed(2)}% of delivered</span>
                        ) : null}
                      </div>
                      <div>
                        <span className="bs-l">
                          <i className="sw" style={{ ["--c" as string]: "var(--data-neutral)" }} />
                          Remaining
                        </span>
                        <span className="bs-v">{fmtInt(p.remaining)}</span>
                      </div>
                    </div>
                  </>
                )}
                {auto ? (
                  <div className="cluster">
                    {c.segmentId ? (
                      <AppLink
                        className="btn btn-secondary btn-sm"
                        href={`/audience/segments/${c.segmentId}`}
                      >
                        <Icon name="filter" />
                        Review the segment
                      </AppLink>
                    ) : null}
                    <Link
                      className="link-quiet"
                      to="/campaigns/$campaignId/report"
                      params={{ campaignId: c.id }}
                      search={{ status: c.pausedBy === "complaint_rate" ? "complained" : "bounced" }}
                    >
                      {c.pausedBy === "complaint_rate" ? "See who complained" : "See the bounces"}
                      <Icon name="chevron-right" />
                    </Link>
                  </div>
                ) : null}
                {c.status === "paused" ? <AlertRef kind="campaign_paused" subjectId={c.id} /> : null}
              </div>
            </div>
          </section>
          <section
            className="panel"
            data-endpoint={`GET /v1/campaigns/${c.id}/report`}
            data-od-id="panel-so-far"
            aria-labelledby="h-so-far"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-so-far">
                So far
              </h2>
            </header>
            <div className="panel-body">
              <p className="hint">
                Opens and clicks build up for days after a send. The report is live while it sends.
              </p>
              <Link
                className="btn btn-secondary btn-sm"
                to="/campaigns/$campaignId/report"
                params={{ campaignId: c.id }}
                style={{ marginTop: 12 }}
              >
                Open the report
                <Icon name="chevron-right" />
              </Link>
            </div>
          </section>
        </div>
        <div className="side">
          <GovernorPanel fromAddress={c.fromAddress} />
        </div>
      </div>
      {cancelling ? (
        <CancelSheet
          id={c.id}
          name={c.name}
          sent={sent}
          remaining={p?.remaining ?? null}
          canPause={c.status !== "paused" && write.allowed}
          onClose={() => setCancelling(false)}
          onPause={() => pause.mutate()}
        />
      ) : null}
      {resumeAnyway ? (
        <ResumeAnywaySheet
          id={c.id}
          name={c.name}
          reason={c.pausedReason}
          pausedBy={c.pausedBy ?? ""}
          onClose={() => setResumeAnyway(false)}
        />
      ) : null}
    </>
  )
}

function PauseCallout({
  c,
  remaining,
  now,
}: {
  c: Campaign
  remaining: number | string | null | undefined
  now: number
}) {
  if (isHeld(c)) {
    const by = HELD_BY_WORDS[c.heldBy ?? ""] ?? "held"
    return (
      <div className="callout callout-info held" role="status" data-od-id={`held-${c.heldBy ?? "quota"}`}>
        <Icon name="clock" />
        <span>
          <b>
            Held until {fmtHeld(c.heldUntil)} ({by}).
          </b>{" "}
          {c.heldBy === "warmup"
            ? "Today’s warm-up cap for the sending domain is reached."
            : "Today’s sends are used, after the transactional reserve."}{" "}
          It’s still sending: the {fmtInt(remaining)} left go out from {fmtHeld(c.heldUntil)},{" "}
          {(num(c.heldUntil) ?? 0) > now ? `${fmtIn(c.heldUntil, now)}, ` : ""}by themselves. There’s no
          Resume, because nothing is paused.
        </span>
      </div>
    )
  }
  if (c.status !== "paused") return null
  if (c.pausedBy === "bounce_rate" || c.pausedBy === "complaint_rate") {
    const what = c.pausedBy === "bounce_rate" ? "bounce rate" : "complaint rate"
    return (
      <div
        className="callout callout-error"
        role="alert"
        data-od-id={c.pausedBy === "bounce_rate" ? "paused-bounce" : "paused-complaint"}
      >
        <Icon name="octagon" />
        <span>
          <b>Paused automatically: {what}.</b> {c.pausedReason ? `“${c.pausedReason}” ` : ""}
          <code className="mono">pausedBy: {c.pausedBy}</code>{" "}
          {c.pausedBy === "bounce_rate"
            ? "The governor stopped it ahead of Cloudflare’s 5% at-risk line. Bounces usually come from old addresses; check who it goes to before resuming."
            : "Complaints cost more reputation than bounces. Check who it went to and whether they asked for it before resuming."}
        </span>
      </div>
    )
  }
  return (
    <div className="callout callout-info" role="status" data-od-id="paused-admin">
      <Icon name="pause" />
      <span>
        <b>Paused{c.pausedBy === "admin" ? " by hand" : ""}.</b>{" "}
        {c.pausedReason ? `“${c.pausedReason}” ` : ""}
        {c.pausedBy ? <code className="mono">pausedBy: {c.pausedBy}</code> : null} Nothing is wrong with the
        sending; Resume picks up where it stopped, and what’s sent stays sent.
      </span>
    </div>
  )
}

function GovernorPanel({ fromAddress }: { fromAddress: string }) {
  const g = useQuery({ ...governorQuery, refetchInterval: 15_000 })
  const d = g.data && "quota" in g.data ? g.data : null
  const domain = (fromAddress.match(/@([^>\s]+)/)?.[1] ?? "").toLowerCase()
  const warm = d?.warming.find((w) => w.domain === domain) ?? null
  const source =
    d?.quotaSource === "cloudflare"
      ? "from Cloudflare"
      : d?.quotaSource === "configured"
        ? "set in Sending"
        : "a fallback"
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/sending/governor"
      data-od-id="panel-governor"
      aria-labelledby="h-governor"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-governor">
          Pace
        </h2>
        <div className="cluster">
          <span className="panel-meta">Shared with every stream</span>
        </div>
      </header>
      <div className="panel-body">
        {!d ? (
          g.isError ? (
            <PanelError error={g.error} onRetry={() => g.refetch()} what="The governor didn’t answer" />
          ) : (
            <span className="sk sk-text" />
          )
        ) : (
          <div className="stack stack-16">
            <div className="lc-split">
              <div className="row">
                <span>Bulk sends left today</span>
                <b>{fmtInt(d.bulkRemaining)}</b>
              </div>
              <div className="row">
                <span>Held back for transactional mail</span>
                <b>{fmtInt(d.transactionalReserve)}</b>
              </div>
              <div className="row">
                <span>Daily quota ({source})</span>
                <b>{fmtInt(d.quota)}</b>
              </div>
              <div className="row">
                <span>Resets</span>
                <b>{fmtHeld(d.resetsAt)}</b>
              </div>
            </div>
            <div className="divider" />
            <div className="stack stack-8">
              <span className="label">Per provider, this minute</span>
              <div className="pacebars">
                {PROVIDERS.map((k) => {
                  const n = num(d.providerThisMinute[k]) ?? 0
                  const cap = num(d.config.providerPerMinute[k]) ?? 0
                  return (
                    <div key={k} className="pacebar">
                      <span>{PROVIDER_LABEL[k]}</span>
                      {/* biome-ignore lint/a11y/useSemanticElements: the design's styled .pb-track meter */}
                      <div
                        className="pb-track"
                        role="meter"
                        aria-valuenow={n}
                        aria-valuemax={cap}
                        aria-label={`${k} this minute`}
                      >
                        <span style={{ width: `${cap ? Math.min(100, (n / cap) * 100) : 0}%` }} />
                      </div>
                      <span className="pb-n">
                        <b>{fmtInt(n)}</b> / {fmtInt(cap)} a min
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
            {warm || d.config.pause ? (
              <>
                <div className="divider" />
                <div className="stack stack-8">
                  <span className="label">{warm ? "Warming" : "Auto-pause"}</span>
                  <p className="hint">
                    {warm ? (
                      <>
                        <span className="mono">{warm.domain}</span> is on day {fmtInt(warm.day)} of warm-up:
                        cap {fmtInt(warm.cap)} today, {fmtInt(warm.sentToday)} sent.{" "}
                      </>
                    ) : null}
                    Auto-pause at {((num(d.config.pause.bounceRate) ?? 0) * 100).toFixed(1)}% bounces over{" "}
                    {fmtInt(d.config.pause.minOutcomes)} outcomes, or{" "}
                    {((num(d.config.pause.complaintRate) ?? 0) * 100).toFixed(2)}% complaints.
                  </p>
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}

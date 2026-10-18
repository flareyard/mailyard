/**
 * Going out now: campaigns sending, paused or scheduled with their pace and ETA, then the automations running.
 * Campaign progress refreshes on focus (HANDOFF §4 "Live"); there is no workspace socket.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId } from "react"
import { ApiError, api, unwrap } from "../api/client.ts"
import { useMe } from "../auth/session.ts"
import { fmtIn, fmtInt, num, toDate } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { Panel, RequestId } from "../ui/Panel.tsx"
import { dayTime, hhmm, sameUtcDay } from "./logic.ts"
import {
  activeCampaignsQuery,
  automations24hQuery,
  automationsSummaryQuery,
  type Ok,
  paceQuery,
  usageQuery,
} from "./queries.ts"
import { AppLink, combineQueries, StaleMeta, useOffline } from "./shared.tsx"

type Campaign = Ok<"/v1/campaigns">["campaigns"][number]
type Pace = Ok<"/v1/campaigns/{id}/pace">
type Usage = Ok<"/v1/usage">
type Data = {
  campaigns: { c: Campaign; pace: Pace | undefined; paceFailed: boolean }[]
  summary: Ok<"/v1/automations/summary"> | undefined
  automations: Ok<"/v1/automations"> | undefined
  usage: Usage | undefined
}

export function GoingOutPanel() {
  const offline = useOffline()
  const campaigns = useQuery(activeCampaignsQuery)
  const list = (campaigns.data?.campaigns ?? []).filter(
    (c) => c.status === "sending" || c.status === "paused" || c.status === "scheduled",
  )
  const paces = useQueries({ queries: list.map((c) => paceQuery(c.id)) })
  const summary = useQuery(automationsSummaryQuery)
  const automations = useQuery(automations24hQuery)
  const usage = useQuery(usageQuery)
  const query = combineQueries<Data>([campaigns], [...paces, summary, automations, usage], () => ({
    campaigns: list.map((c, i) => ({ c, pace: paces[i]?.data, paceFailed: paces[i]?.isError ?? false })),
    summary: summary.data,
    automations: automations.data,
    usage: usage.data,
  }))
  return (
    <Panel
      id="going-out"
      title="Going out now"
      to="/campaigns"
      linkLabel="Campaigns"
      span={7}
      endpoint="GET /v1/campaigns?status=active · GET /v1/campaigns/{id}/pace · GET /v1/automations?range=24h · GET /v1/automations/summary"
      meta={<StaleMeta offline={offline} updatedAt={query.dataUpdatedAt} label="Refreshes on focus" />}
      query={query}
      skeleton={<GoingOutSkeleton />}
    >
      {(d) => (
        <div className="stack stack-16">
          {d.campaigns.length ? (
            <div className="going">
              {d.campaigns.map(({ c, pace, paceFailed }) => (
                <CampaignItem key={c.id} c={c} pace={pace} paceFailed={paceFailed} usage={d.usage} />
              ))}
            </div>
          ) : (
            <div className="empty ov-empty-going">
              <span className="empty-icon">
                <Icon name="campaigns" />
              </span>
              <h3>Nothing is going out</h3>
              <p>Campaigns you send or schedule show their progress and ETA here.</p>
              <AppLink className="btn btn-secondary btn-sm" href="/campaigns/new">
                <Icon name="plus" className="icon-12" />
                New campaign
              </AppLink>
            </div>
          )}
          <Automations summary={d.summary} automations={d.automations} />
        </div>
      )}
    </Panel>
  )
}

function CampaignItem({
  c,
  pace,
  paceFailed,
  usage,
}: {
  c: Campaign
  pace: Pace | undefined
  paceFailed: boolean
  usage: Usage | undefined
}) {
  const href = `/campaigns/${encodeURIComponent(c.id)}`
  const audience = num(c.audienceSize) ?? 0
  const cloudflare = usage?.today.source === "cloudflare"
  const paceNote = paceFailed ? (
    <span className="ov-text-warn">Progress couldn’t be read just now</span>
  ) : !pace ? (
    <span className="sk sk-text ov-sk-inline" aria-hidden="true" />
  ) : null

  if (c.status === "scheduled") {
    const starts = toDate(c.sendAt)
    const finishes = toDate(pace?.eta.at ?? null)
    const quota = num(usage?.today.quota)
    return (
      <div className="going-item" data-endpoint={`GET /v1/campaigns/${c.id}/pace`}>
        <div className="spread-nowrap">
          <AppLink className="row-title ov-inherit" href={href}>
            {c.name}
          </AppLink>
          <span className="pill pill-neutral">
            <span className="dot" />
            Scheduled
          </span>
        </div>
        <div className="going-meta">
          {starts ? (
            <span>
              Starts <b>{dayTime(starts)} UTC</b>
            </span>
          ) : null}
          <span>
            <b>{fmtInt(audience)}</b> recipients
          </span>
          {paceNote ??
            (finishes ? (
              <span>
                {cloudflare && quota !== null ? `At ${fmtInt(quota)} a day` : "At the fallback quota"},
                finishes <b>{dayTime(finishes)} UTC</b>
              </span>
            ) : null)}
        </div>
      </div>
    )
  }

  const paused = c.status === "paused" || Boolean(pace?.paused)
  const sent = num(pace?.sent) ?? num(c.summary?.sent) ?? 0
  const progress = audience ? Math.min(100, Math.round((sent / audience) * 100)) : 0
  const over = Boolean(usage?.today.overQuota)
  const resets = toDate(usage?.today.resetsAt ?? null)
  const rate = num(pace?.ratePerHour)
  const eta = toDate(pace?.eta.at ?? null)
  const why = pace?.reason ?? c.pausedReason
  return (
    <div className="going-item" data-endpoint={`GET /v1/campaigns/${c.id}/pace`}>
      <div className="spread-nowrap">
        <AppLink className="row-title ov-inherit" href={href}>
          {c.name}
        </AppLink>
        {paused ? (
          <span className="pill pill-warn">
            <span className="dot" />
            Paused
          </span>
        ) : (
          <span className="pill pill-info">
            <span className="dot" />
            Sending
          </span>
        )}
      </div>
      <div
        className={`progress${paused ? " is-paused" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={audience}
        aria-valuenow={sent}
        aria-label={`${c.name} progress`}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="spread">
        <div className="going-meta">
          <span>
            <b>{fmtInt(sent)}</b> of {fmtInt(audience)} sent
          </span>
          {paceNote ?? (
            <>
              <span>
                Pace <b>{rate === null ? "paused" : `${fmtInt(rate)} an hour`}</b>
              </span>
              <span>
                {paused ? (
                  over && resets ? (
                    `Resumes at the quota reset, ${hhmm(resets)} UTC`
                  ) : (
                    "No ETA while paused"
                  )
                ) : eta ? (
                  <>
                    ETA <b>{sameUtcDay(eta) ? `today ${hhmm(eta)}` : dayTime(eta)} UTC</b> at{" "}
                    {cloudflare ? "today’s quota" : "the fallback quota"}
                  </>
                ) : (
                  "ETA after the next reset"
                )}
              </span>
            </>
          )}
        </div>
        <PauseResume id={c.id} name={c.name} paused={paused} quotaUsed={over} resets={resets} />
      </div>
      {paused && why ? (
        <div className="callout callout-warn ov-callout-tight">
          <Icon name="pause" />
          <span>{why}</span>
        </div>
      ) : null}
    </div>
  )
}

function PauseResume({
  id,
  name,
  paused,
  quotaUsed,
  resets,
}: {
  id: string
  name: string
  paused: boolean
  quotaUsed: boolean
  resets: Date | null
}) {
  const me = useMe()
  const qc = useQueryClient()
  const rid = useId()
  const label = paused ? "Resume" : "Pause"
  const m = useMutation({
    mutationFn: () =>
      paused
        ? unwrap(api.POST("/v1/campaigns/{id}/resume", { params: { path: { id } } }))
        : unwrap(api.POST("/v1/campaigns/{id}/pause", { params: { path: { id } } })),
    onSettled: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  })
  const role = me.data?.role
  const noRole = role === "viewer" || role === "agent"
  const blocked = paused && quotaUsed
  if (noRole || blocked) {
    return (
      <span className="has-reason">
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          aria-disabled="true"
          aria-describedby={rid}
        >
          <Icon name={blocked ? "play" : "lock"} className="icon-12" />
          {label}
        </button>
        <span className="reason-pop is-right" role="tooltip" id={rid}>
          {blocked ? (
            <>
              <b>The daily quota is used</b>
              <span className="reason-who">
                Sending resumes on its own
                {resets ? ` at ${hhmm(resets)} UTC, ${fmtIn(resets.getTime())}` : " at the reset"}.
              </span>
            </>
          ) : (
            <>
              <b>You can’t {label.toLowerCase()} campaigns</b>
              <span className="reason-who">
                Owners, admins and senders can {label.toLowerCase()} a campaign.
              </span>
            </>
          )}
        </span>
      </span>
    )
  }
  const err = m.error instanceof ApiError ? m.error : null
  return (
    <span className="stack stack-4 ov-align-end">
      <button
        className="btn btn-secondary btn-sm"
        type="button"
        data-endpoint={`POST /v1/campaigns/{id}/${label.toLowerCase()}`}
        aria-label={`${label} ${name}`}
        disabled={m.isPending}
        onClick={() => m.mutate()}
      >
        <Icon name={paused ? "play" : "pause"} className="icon-12" />
        {m.isPending ? (paused ? "Resuming…" : "Pausing…") : label}
      </button>
      {m.isError ? (
        <span className="t-small ov-text-fail" role="alert">
          {err ? `${label} was refused: ${err.message}` : `${label} didn’t reach Mailyard.`}
          {err?.requestId ? <RequestId id={err.requestId} /> : null}
        </span>
      ) : null}
    </span>
  )
}

function Automations({
  summary,
  automations,
}: {
  summary: Ok<"/v1/automations/summary"> | undefined
  automations: Ok<"/v1/automations"> | undefined
}) {
  const live = (automations?.automations ?? []).filter((a) => a.status === "live")
  return (
    <div>
      <div className="spread ov-mb-4">
        <h3 className="t-h4">Automations running</h3>
        <AppLink className="link-quiet" href="/automations">
          All automations
          <Icon name="chevron-right" className="icon-12" />
        </AppLink>
      </div>
      {summary ? (
        <p className="t-small muted ov-mb-6" data-endpoint="GET /v1/automations/summary">
          {fmtInt(summary.live)} live · {fmtInt(summary.activeRuns)} active runs · {fmtInt(summary.sends7d)}{" "}
          sends in 7 days
        </p>
      ) : null}
      {automations ? (
        live.length ? (
          <div className="table-wrap">
            <table className="table" data-endpoint="GET /v1/automations?range=24h">
              <thead>
                <tr>
                  <th scope="col">Automation</th>
                  <th scope="col" className="r">
                    Active runs
                  </th>
                  <th scope="col" className="r">
                    Entered, 24 h
                  </th>
                  <th scope="col" className="r">
                    Failed, 24 h
                  </th>
                </tr>
              </thead>
              <tbody>
                {live.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <AppLink className="ov-plain-link" href={`/automations/${encodeURIComponent(a.id)}`}>
                        {a.name}
                      </AppLink>
                    </td>
                    <td className="r">{fmtInt(a.activeRuns)}</td>
                    <td className="r">{fmtInt(a.entered)}</td>
                    <td className={`r${num(a.failed) ? " ov-failed" : ""}`}>{fmtInt(a.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="t-small muted">
            No automation is live. Published automations list here with their runs over the last 24 hours.
          </p>
        )
      ) : (
        <p className="t-small muted">
          The automations list didn’t load; it retries when you come back to the tab.
        </p>
      )}
    </div>
  )
}

function GoingOutSkeleton() {
  return (
    <div className="stack stack-16" aria-hidden="true">
      <span className="sk sk-title" />
      <span className="sk sk-bar" style={{ height: 8 }} />
      <span className="sk sk-text" style={{ width: "60%" }} />
      <span className="sk sk-title" />
      <div className="stack stack-12">
        {[100, 86, 92, 70].map((w) => (
          <span key={w} className="sk sk-text" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  )
}

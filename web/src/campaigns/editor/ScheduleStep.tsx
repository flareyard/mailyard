/**
 * Step 5, schedule (design: campaign-schedule.html, -forecast, -quota, -timezone; GAPS-audience A7.9, A7.10). Now
 * or at a time in an IANA zone (stored as `timezone` beside the UTC `sendAt`; a bad zone is a 400 on `timezone`,
 * shown on the field). The forecast is `GET /v1/usage/forecast?recipients=&startAt=&campaignId=`: a bar a day of
 * the bulk share, with the campaigns queued ahead and this one stacked inside. With no known quota it says why
 * and how to fix it. `POST /v1/campaigns/{id}/schedule` refuses a key with send limits (`409 agent_limit`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { ApiErrorCallout, FieldError, useCan } from "../../audience/kit/ui.tsx"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, fmtUsd, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError } from "../../ui/Panel.tsx"
import {
  agentRefusal,
  allZones,
  checksSummary,
  fmtDayKey,
  fmtHeld,
  fmtWhen,
  forecastBars,
  isTimeZone,
  utcToZoned,
  zonedToUtc,
} from "../logic.ts"
import { checksQuery, type Forecast, forecastQuery, governorQuery, previewQuery } from "../queries.ts"
import { CancelSheet, useCampaignAction } from "../sending/actions.tsx"
import { AGENT_WHO, AgentRefusalCallout, AppLink } from "../ui.tsx"
import { useEditor } from "./EditorContext.tsx"
import { EditorFrame } from "./EditorFrame.tsx"
import { useFocusParam } from "./focus.ts"

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Tomorrow 09:00 in the zone, the default for a new schedule. */
function defaultWhen(tz: string) {
  const t = utcToZoned(Date.now() + 86_400_000, tz)
  return { date: t.date, time: "09:00" }
}

export function ScheduleStep({ focus }: { focus?: string | undefined }) {
  const ed = useEditor()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const c = ed.draft
  const write = useCan("campaigns.write", "schedule campaigns")
  const checks = useQuery(checksQuery(ed.id))
  const preview = useQuery(previewQuery(ed.id, num(ed.server.updatedAt)))
  const governor = useQuery(governorQuery)
  const zones = useMemo(allZones, [])
  useFocusParam(focus === "timezone" ? "s-tz" : focus === "sendAt" ? "s-date" : undefined)

  const tz = c.timezone ?? browserZone()
  const [tzText, setTzText] = useState(tz)
  const initial =
    num(c.sendAt) !== null
      ? utcToZoned(num(c.sendAt) as number, isTimeZone(tz) ? tz : "UTC")
      : defaultWhen(isTimeZone(tz) ? tz : "UTC")
  const [mode, setMode] = useState<"now" | "later">(
    c.status === "scheduled" || num(c.sendAt) !== null ? "later" : "later",
  )
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const zoneOk = isTimeZone(tzText)
  const sendAt = mode === "now" ? null : zoneOk ? zonedToUtc(date, time, tzText) : null
  const [forecastFrom, setForecastFrom] = useState<string | null>(null)
  const fcStart = forecastFrom ? Date.parse(`${forecastFrom}:00Z`) : sendAt
  const sendable =
    preview.data && "sendable" in preview.data
      ? (num(preview.data.sendable) ?? 0)
      : (num(c.audienceSize) ?? null)
  const forecast = useQuery({
    ...forecastQuery(sendable ?? 0, Number.isFinite(fcStart) ? (fcStart as number) : null, ed.id),
    enabled: sendable !== null && sendable > 0,
  })

  const [refused, setRefused] = useState<ReturnType<typeof agentRefusal>>(null)
  const schedule = useMutation({
    mutationFn: async (at: number | null) => {
      if (ed.editable && ed.state !== "saved") {
        const ok = await ed.flush()
        if (!ok) throw new Error("The campaign has changes that didn’t save; fix them first.")
      }
      return unwrap(
        api.POST("/v1/campaigns/{id}/schedule", {
          params: { path: { id: ed.id } },
          body: at === null ? {} : { sendAt: at },
        }),
      )
    },
    onSuccess: (res) => {
      setRefused(null)
      qc.invalidateQueries({ queryKey: ["campaigns"] })
      if (res && "status" in res) {
        qc.setQueryData(["campaigns", ed.id], res)
        void navigate({ to: "/campaigns/$campaignId", params: { campaignId: ed.id } })
      }
    },
    onError: (e) => setRefused(agentRefusal(e)),
  })

  const sum = checks.data && "checks" in checks.data ? checksSummary(checks.data.checks) : null
  const tzErr =
    ed.error?.status === 400 && ed.error.body.field === "timezone"
      ? ed.error.message
      : !zoneOk && tzText.trim()
        ? `${tzText.trim()} isn't a time zone (use an IANA name, like Africa/Lagos).`
        : null
  const schedErrField =
    schedule.error && "body" in (schedule.error as object)
      ? ((schedule.error as { body?: { field?: string } }).body?.field ?? null)
      : null
  const fc = forecast.data
  const quotaUsedNow = mode === "now" && fc?.possible === true && num(fc.sendableToday) === 0
  const resetAt = num(governor.data?.resetsAt)
  const past = sendAt !== null && sendAt < Date.now() - 60_000
  const agentBlocked = refused?.reason === "agent_limit"

  const block = !write.allowed
    ? { reason: "You can’t schedule campaigns", who: write.who }
    : agentBlocked
      ? { reason: "This key can’t schedule campaigns", who: AGENT_WHO }
      : sum && !sum.ready
        ? {
            reason: `${sum.fail} check${sum.fail === 1 ? "" : "s"} fail${sum.fail === 1 ? "s" : ""}`,
            who: "Fix them on the Checks step; warnings don’t block.",
          }
        : sendable === 0
          ? {
              reason: "Nobody in this audience can be sent to",
              who: "Change the audience on the Audience step.",
            }
          : mode === "later" && !sendAt
            ? { reason: "Pick a date, time and a valid time zone", who: undefined }
            : past
              ? { reason: "That time has passed", who: "Pick a time from now on." }
              : null

  const actions =
    c.status === "draft" ? (
      <>
        <button
          className="btn btn-ghost btn-sm edit-only"
          type="button"
          onClick={async () => {
            if (await ed.flush()) void navigate({ to: "/campaigns", search: { status: "draft" } })
          }}
        >
          Save as draft
        </button>
        {quotaUsedNow ? (
          <>
            <Gated
              allowed={false}
              reason="The daily quota is used"
              who={`Schedule it for ${fmtHeld(resetAt)} instead, or later. Sending resumes at the reset.`}
              side="right"
            >
              <button className="btn btn-secondary btn-sm edit-only" type="button" data-od-id="send-now">
                <Icon name="send" />
                Send now
              </button>
            </Gated>
            <Gated
              allowed={!block && resetAt !== null}
              reason={block?.reason ?? "The reset time isn’t known"}
              who={block?.who}
              side="right"
            >
              <button
                className={`btn btn-primary btn-sm edit-only${schedule.isPending ? " is-loading" : ""}`}
                type="button"
                data-endpoint={`POST /v1/campaigns/${ed.id}/schedule {sendAt: reset}`}
                onClick={() => schedule.mutate(resetAt)}
              >
                <Icon name="calendar" />
                Queue for {fmtHeld(resetAt)}
              </button>
            </Gated>
          </>
        ) : (
          <Gated allowed={!block} reason={block?.reason} who={block?.who} side="right">
            <button
              className={`btn btn-primary btn-sm edit-only${schedule.isPending ? " is-loading" : ""}`}
              type="button"
              data-endpoint={`POST /v1/campaigns/${ed.id}/schedule`}
              data-od-id="schedule"
              onClick={() => schedule.mutate(mode === "now" ? null : sendAt)}
            >
              {schedule.isPending ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <Icon name={mode === "now" ? "send" : "calendar"} />
              )}
              {mode === "now" ? "Send now" : sendAt ? `Schedule for ${fmtWhen(sendAt)}` : "Schedule"}
            </button>
          </Gated>
        )}
      </>
    ) : c.status === "scheduled" ? (
      <ScheduledActions />
    ) : null

  return (
    <EditorFrame step="schedule" actions={actions}>
      {refused ? <AgentRefusalCallout refusal={refused} what="It wasn’t scheduled." /> : null}
      {schedule.isError && !refused ? (
        <div style={{ marginBottom: 16 }}>
          <ApiErrorCallout error={schedule.error} what="It wasn’t scheduled." />
          {schedErrField === "checks" ? (
            <Link className="link" to="/campaigns/$campaignId/checks" params={{ campaignId: ed.id }}>
              Open the checks
            </Link>
          ) : schedErrField === "audience" || schedErrField === "exclude" ? (
            <Link className="link" to="/campaigns/$campaignId/audience" params={{ campaignId: ed.id }}>
              Open the audience
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className="editor cmp-editor">
        <div className="stack">
          <section
            className="panel"
            data-endpoint={`POST /v1/campaigns/${ed.id}/schedule {sendAt} · PATCH {timezone}`}
            data-od-id="panel-when"
            aria-labelledby="h-when"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-when">
                Schedule
              </h2>
            </header>
            <div className="panel-body">
              {c.status !== "draft" ? (
                <div className="stack stack-12">
                  <div className="callout callout-info" role="status">
                    <Icon name="calendar" />
                    <span>
                      <b>
                        {c.status === "scheduled" ? "Scheduled for" : "Was scheduled for"} {fmtWhen(c.sendAt)}
                      </b>
                      {c.timezone && num(c.sendAt) !== null ? (
                        <>
                          {" "}
                          · {utcToZoned(num(c.sendAt) as number, c.timezone).time} in{" "}
                          <code className="mono">{c.timezone}</code>
                        </>
                      ) : null}
                      .{" "}
                      {c.status === "scheduled"
                        ? "Pause it to hold it, or cancel it and duplicate it to change anything."
                        : ""}
                    </span>
                  </div>
                  <p className="hint">
                    {fmtInt(c.audienceSize)} recipients were counted when it was scheduled; the template
                    version and the audience are fixed from then.
                  </p>
                </div>
              ) : (
                <div className="stack stack-16">
                  <fieldset className="stack stack-8" style={{ border: 0, margin: 0, padding: 0 }}>
                    <legend className="label" style={{ marginBottom: 8 }}>
                      When
                    </legend>
                    <div className="choices">
                      {(
                        [
                          ["now", "Now", "Starts within a minute, paced to the quota."],
                          ["later", "At a time", "Pick a date, time and time zone."],
                        ] as const
                      ).map(([m, title, sub]) => (
                        <label key={m} className={`choice${mode === m ? " is-selected" : ""}`}>
                          <input
                            type="radio"
                            name="when"
                            className="sr-only"
                            checked={mode === m}
                            onChange={() => setMode(m)}
                          />
                          <span className={`status-icon${mode === m ? "" : " status-idle"}`}>
                            <Icon name={mode === m ? "check-circle" : "circle"} />
                          </span>
                          <span className="strong">{title}</span>
                          <span />
                          <span className="c-sub">{sub}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {mode === "later" ? (
                    <div className="fgrid">
                      <div className="field">
                        <label className="label" htmlFor="s-date">
                          Date
                        </label>
                        <input
                          className="input"
                          id="s-date"
                          type="date"
                          value={date}
                          onChange={(e) => setDate(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="s-time">
                          Time
                        </label>
                        <input
                          className="input"
                          id="s-time"
                          type="time"
                          value={time}
                          onChange={(e) => setTime(e.target.value)}
                        />
                      </div>
                      <div className="field full">
                        <label className="label" htmlFor="s-tz">
                          Time zone{" "}
                          <span className="opt">
                            IANA name · <code className="mono">timezone</code>
                          </span>
                        </label>
                        <input
                          className="input mono"
                          id="s-tz"
                          list="tz-list"
                          value={tzText}
                          autoComplete="off"
                          data-endpoint={`PATCH /v1/campaigns/${ed.id} {timezone}`}
                          onChange={(e) => {
                            setTzText(e.target.value)
                            if (isTimeZone(e.target.value)) ed.set({ timezone: e.target.value.trim() })
                          }}
                          onBlur={() => {
                            if (tzText.trim() && !isTimeZone(tzText) && ed.editable)
                              ed.set({ timezone: tzText.trim() })
                          }}
                          {...(tzErr ? { "aria-invalid": true, "aria-describedby": "tz-err" } : {})}
                        />
                        <datalist id="tz-list">
                          {zones.map((z) => (
                            <option key={z} value={z} />
                          ))}
                        </datalist>
                        {tzErr ? (
                          <FieldError id="tz-err">
                            {tzErr} <code className="mono">timezone</code>
                          </FieldError>
                        ) : null}
                        {sendAt !== null ? (
                          <span className="hint">
                            {fmtWhen(sendAt).replace(/, \d\d:\d\d UTC$/, "")}, {time} in {tzText} is{" "}
                            <b>{fmtWhen(sendAt).slice(-9)}</b>. Mailyard stores{" "}
                            <code className="mono">sendAt</code> in UTC and keeps{" "}
                            <code className="mono">timezone</code>, so this screen can say “{time} in{" "}
                            {tzText.split("/").pop()?.replace(/_/g, " ")}” back.
                          </span>
                        ) : (
                          <span className="hint">
                            Type a zone like Africa/Lagos; the picker suggests IANA names as you type.
                          </span>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </section>
        </div>
        <div className="side">
          <section
            className="panel"
            data-endpoint={`GET /v1/usage/forecast?recipients=${sendable ?? ""}&startAt=${fcStart ?? ""}&campaignId=${ed.id}`}
            data-od-id="panel-eta"
            aria-labelledby="h-eta"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-eta">
                Forecast
              </h2>
            </header>
            <div className="panel-body">
              <div className="stack stack-12">
                <div className="field">
                  <label className="label" htmlFor="fc-start">
                    Forecast from{" "}
                    <span className="opt">
                      <code className="mono">startAt</code> · UTC
                    </span>
                  </label>
                  <input
                    className="input"
                    id="fc-start"
                    type="datetime-local"
                    value={
                      forecastFrom ?? (sendAt !== null ? new Date(sendAt).toISOString().slice(0, 16) : "")
                    }
                    onChange={(e) => setForecastFrom(e.target.value || null)}
                  />
                  <span className="hint">
                    Defaults to the scheduled time; change it to see another start.
                  </span>
                </div>
                {sendable === 0 ? (
                  <p className="hint">
                    Nobody in this audience can be sent to yet, so there’s nothing to forecast.
                  </p>
                ) : !fc ? (
                  forecast.isError ? (
                    <PanelError
                      error={forecast.error}
                      onRetry={() => forecast.refetch()}
                      what="The forecast didn’t load"
                    />
                  ) : (
                    <div className="stack stack-8" aria-hidden="true">
                      <span className="sk sk-text" />
                      <span className="sk sk-bar" style={{ height: 120 }} />
                    </div>
                  )
                ) : !fc.possible ? (
                  <div className="stack stack-12" data-od-id="forecast-none">
                    <div className="callout callout-warn" role="status">
                      <Icon name="warn" />
                      <span>
                        <b>Can’t forecast until Mailyard can read your daily quota.</b> The forecast says: “
                        {fc.reason}” Scheduling still works; only the day-by-day estimate needs the quota.
                      </span>
                    </div>
                    <ol className="role-list">
                      <li>
                        <Icon name="key" />
                        <span>
                          Connect a <b>read-only</b> Cloudflare API token in Settings → Sending, so Mailyard
                          reads the account’s real daily limit.
                        </span>
                      </li>
                      <li>
                        <Icon name="sliders" />
                        <span>Or set the quota by hand in Sending, if you know it.</span>
                      </li>
                    </ol>
                    <AppLink className="btn btn-secondary btn-sm" href="/settings/sending">
                      <Icon name="settings" />
                      Open Sending settings
                    </AppLink>
                  </div>
                ) : (
                  <Plan fc={fc} />
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </EditorFrame>
  )
}

type Possible = Extract<Forecast, { possible: true }>

function Plan({ fc }: { fc: Possible }) {
  const bars = forecastBars(fc.days)
  const maxAvail = Math.max(0, ...bars.map((b) => b.available))
  const reserve = (num(fc.quota) ?? 0) - maxAvail
  return (
    <div className="eta" data-od-id="forecast-plan">
      <p className="eta-line">
        <b>{fmtInt(fc.recipients)}</b> recipients finish by <b>{fmtDayKey(fc.finishesBy?.slice(0, 10))}</b>
        {num(fc.additionalDays)
          ? `, ${fmtInt(fc.additionalDays)} days after the first`
          : ", the day it starts"}
        .
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: the design's .fcbars, a group of labelled day bars */}
      <div className="fcbars" role="group" aria-label="Capacity per day from today to the finish">
        {bars.map((b) => (
          <div key={b.day} className="fcday" role="img" aria-label={b.aria}>
            <div className="fc-col">
              <div className="fc-track" style={{ height: `${b.heightPct}%` }}>
                <span className="fc-free" style={{ flex: b.free }} />
                <span className="fc-queued" style={{ flex: b.queued }} />
                <span className="fc-mine" style={{ flex: b.mine }} />
              </div>
            </div>
            <span className="fc-l">
              <b>{b.mine ? fmtInt(b.mine) : "—"}</b>
              {b.label}
            </span>
          </div>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="sw" style={{ ["--c" as string]: "var(--data-campaign)" }} />
          This campaign
        </span>
        <span>
          <i className="sw" style={{ ["--c" as string]: "var(--data-transactional)" }} />
          Queued ahead (scheduled and sending campaigns)
        </span>
        <span>
          <i className="sw" style={{ ["--c" as string]: "var(--data-track)" }} />
          Still free
        </span>
      </div>
      <div className="lc-split">
        <div className="row">
          <span>
            Sendable today <span className="opt">net of the reserve</span>
          </span>
          <b>{fmtInt(fc.sendableToday)}</b>
        </div>
        <div className="row">
          <span>Bulk sends a day</span>
          <b>
            {fmtInt(maxAvail)} of {fmtInt(fc.quota)}
          </b>
        </div>
        <div className="row">
          <span>Extra days</span>
          <b>{fmtInt(fc.additionalDays)}</b>
        </div>
        {fc.cost ? (
          <>
            <div className="row">
              <span>Billed this month after it</span>
              <b>{fmtInt(fc.cost.billedAfter)}</b>
            </div>
            <div className="row">
              <span>Overage it adds, at $0.35 per 1,000</span>
              <b>{fmtUsd(fc.cost.extraUsd)}</b>
            </div>
          </>
        ) : null}
      </div>
      <p className="hint">
        <b>The transactional reserve</b> keeps {reserve > 0 ? `${fmtInt(reserve)} sends` : "a share"} of the
        daily quota for receipts, password resets and replies, so a campaign can never use up the mail people
        are waiting for. Bars show only the bulk share that’s left. It’s forecast with{" "}
        <code className="mono">campaignId</code>, so it isn’t queued behind itself.
      </p>
    </div>
  )
}

function ScheduledActions() {
  const ed = useEditor()
  const write = useCan("campaigns.write", "pause and cancel campaigns")
  const pause = useCampaignAction(ed.id, "pause")
  const [cancelling, setCancelling] = useState(false)
  return (
    <>
      <Gated allowed={write.allowed} reason="You can’t cancel campaigns" who={write.who}>
        <button className="btn btn-danger-ghost btn-sm" type="button" onClick={() => setCancelling(true)}>
          <Icon name="x" />
          Cancel…
        </button>
      </Gated>
      <Gated allowed={write.allowed} reason="You can’t pause campaigns" who={write.who} side="right">
        <button
          className={`btn btn-secondary btn-sm${pause.isPending ? " is-loading" : ""}`}
          type="button"
          data-endpoint={`POST /v1/campaigns/${ed.id}/pause`}
          onClick={() => pause.mutate()}
        >
          <Icon name="pause" />
          Pause
        </button>
      </Gated>
      {pause.isError ? <ApiErrorCallout error={pause.error} what="It wasn’t paused." /> : null}
      {cancelling ? (
        <CancelSheet
          id={ed.id}
          name={ed.draft.name}
          sent={0}
          remaining={ed.draft.audienceSize}
          canPause={write.allowed}
          onClose={() => setCancelling(false)}
          onPause={() => pause.mutate()}
        />
      ) : null}
    </>
  )
}

/**
 * Settings → Sending and governor (design: sending, sending-unreachable; HANDOFF-ops §6). What the governor
 * sees right now (GET /v1/sending/governor, live) and its settings (GET/PUT /v1/settings/sending): daily quota,
 * the transactional reserve, per-provider pace, warm-up and the automatic pause. Rates are fractions in the API
 * and percentages on screen.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { ApiError, api, unwrap } from "../api/client.ts"
import { fmtIn, fmtInt, num } from "../lib/format.ts"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../ui/Panel.tsx"
import { changedFields, fromPercentInput, toPercentInput, unsavedLine } from "./logic.ts"
import { ApiRefusal } from "./mailboxes/CreateMailbox.tsx"
import { type Governor, governorQuery, type SendingSettings, sendingSettingsQuery } from "./queries.ts"
import { SaveBar, SectionHead } from "./ui.tsx"

const STREAMS = ["transactional", "campaign", "automation", "mailbox"] as const
const PROVIDERS = ["gmail", "microsoft", "yahoo", "apple", "other"] as const
const PROVIDER_LABEL: Record<(typeof PROVIDERS)[number], string> = {
  gmail: "Gmail",
  microsoft: "Microsoft",
  yahoo: "Yahoo",
  apple: "Apple",
  other: "Other",
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function SendingPage() {
  const gov = useQuery(governorQuery)
  const settings = useQuery(sendingSettingsQuery)
  const unreachable = (e: unknown) => e instanceof ApiError && e.status === 503
  if (gov.isError && unreachable(gov.error))
    return (
      <>
        <SectionHead title="Sending and governor" sub="How fast mail goes out, and when it stops itself." />
        <section
          className="panel is-error"
          data-endpoint="GET /v1/sending/governor · GET/PUT /v1/settings/sending"
          data-od-id="panel-governor"
          aria-labelledby="h-governor"
        >
          <header className="panel-head">
            <h2 className="panel-title" id="h-governor">
              Governor
            </h2>
          </header>
          <div className="panel-body">
            <div className="error-block" role="alert" data-od-id="error-block">
              <h3>
                <Icon name="x-circle" />
                The sending governor didn’t answer
              </h3>
              <p>
                <code className="mono">GET /v1/sending/governor</code> answered <b>503 GovernorUnreachable</b>
                . Sends keep queueing and go out when it’s back; nothing is lost. Settings can’t be read or
                saved until then.
              </p>
              <div className="cluster">
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={() => Promise.all([gov.refetch(), settings.refetch()])}
                >
                  <Icon name="refresh" />
                  Retry
                </button>
                {(gov.error as ApiError).requestId ? (
                  <span className="req-id">
                    Request id <code className="mono">{(gov.error as ApiError).requestId}</code>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </>
    )
  return (
    <>
      <SectionHead title="Sending and governor" sub="How fast mail goes out, and when it stops itself." />
      <section
        className="panel"
        data-endpoint="GET /v1/sending/governor"
        data-od-id="panel-governor"
        aria-labelledby="h-governor"
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-governor">
            Right now
          </h2>
          <div className="cluster">
            <span className="panel-meta">live</span>
          </div>
        </header>
        <div className="panel-body">
          {gov.isPending ? (
            <PanelSkeleton rows={4} />
          ) : gov.isError ? (
            <PanelError error={gov.error} onRetry={() => gov.refetch()} what="The governor didn’t load" />
          ) : (
            <RightNow g={gov.data} />
          )}
        </div>
      </section>
      {settings.isPending ? (
        <div className="panel">
          <div className="panel-body">
            <PanelSkeleton rows={8} />
          </div>
        </div>
      ) : settings.isError ? (
        <div className="panel is-error">
          <div className="panel-body">
            <PanelError
              error={settings.error}
              onRetry={() => settings.refetch()}
              what="Sending settings didn’t load"
            />
          </div>
        </div>
      ) : (
        <SettingsForm s={settings.data} g={gov.data} />
      )}
    </>
  )
}

function RightNow({ g }: { g: Governor }) {
  const quota = num(g.quota) ?? 0
  const sent = STREAMS.map((s) => [s, num(g.sent[s]) ?? 0] as const)
  const total = sent.reduce((n, [, v]) => n + v, 0)
  const left = Math.max(0, quota - total)
  const reserve = num(g.transactionalReserve) ?? 0
  return (
    <div className="stack stack-12">
      <div className="spread">
        <div className="stat">
          <span className="stat-label">Sent today</span>
          <span className="stat-value">
            {fmtInt(total)}{" "}
            <span className="t-label muted" style={{ fontFamily: "var(--font-sans)" }}>
              of {fmtInt(quota)} · quota from {g.quotaSource}
            </span>
          </span>
        </div>
        <span className="t-small muted">resets 00:00 UTC, {fmtIn(g.resetsAt as number)}</span>
      </div>
      <div
        className="splitbar"
        style={{ height: 14, background: "var(--data-track)" }}
        role="img"
        aria-label={`Today by stream: ${sent.map(([s, v]) => `${s} ${v}`).join(", ")}, ${left} left`}
      >
        {sent.map(([s, v]) =>
          v ? (
            <span key={s} style={{ flex: v, ["--c" as string]: `var(--data-${s})` }} title={`${s}: ${v}`} />
          ) : null,
        )}
        {left ? <span style={{ flex: left, ["--c" as string]: "var(--data-track)" }} /> : null}
      </div>
      <div className="legend">
        {sent.map(([s, v]) => (
          <span key={s}>
            <i style={{ ["--c" as string]: `var(--data-${s})` }} />
            {cap(s)}{" "}
            <b className="num" style={{ color: "var(--my-fg)" }}>
              {fmtInt(v)}
            </b>
          </span>
        ))}
      </div>
      <dl className="kv">
        <dt>Left for bulk</dt>
        <dd>
          <b>{fmtInt(g.bulkRemaining)}</b> campaign and automation sends
        </dd>
        <dt>Held for transactional</dt>
        <dd>
          <b>{fmtInt(reserve)}</b>
          {quota ? ` (${Math.round((reserve / quota) * 100)}% of the quota)` : ""}, so receipts never wait on
          a campaign
        </dd>
        <dt>Warming</dt>
        <dd>
          {g.warming.length
            ? g.warming.map((w, i) => (
                <span key={w.domain}>
                  {i ? "; " : ""}
                  <span className="mono">{w.domain}</span> day {num(w.day)}: cap {fmtInt(w.cap)},{" "}
                  {fmtInt(w.sentToday)} sent
                </span>
              ))
            : "No domain is warming up"}
        </dd>
      </dl>
    </div>
  )
}

type Form = {
  dailyQuota: string
  fallbackQuota: string
  reserve: string
  pace: Record<(typeof PROVIDERS)[number], string>
  warmOn: boolean
  warmStart: string
  warmFactor: string
  warmBounce: string
  warmComplaint: string
  pauseBounce: string
  pauseComplaint: string
}

const formOf = (s: SendingSettings): Form => ({
  dailyQuota: s.dailyQuota === null ? "" : String(s.dailyQuota),
  fallbackQuota: String(s.fallbackQuota),
  reserve: toPercentInput(s.transactionalReserve as number),
  pace: Object.fromEntries(
    PROVIDERS.map((p) => [p, String(num(s.providerPerMinute[p]) ?? "")]),
  ) as Form["pace"],
  warmOn: s.warmup.enabled,
  warmStart: String(s.warmup.start),
  warmFactor: String(num(s.warmup.factor) ?? ""),
  warmBounce: toPercentInput(s.warmup.maxBounceRate as number),
  warmComplaint: toPercentInput(s.warmup.maxComplaintRate as number),
  pauseBounce: toPercentInput(s.pause.bounceRate as number),
  pauseComplaint: toPercentInput(s.pause.complaintRate as number),
})

const LABELS: Partial<Record<keyof Form, string>> = {
  dailyQuota: "daily quota",
  fallbackQuota: "daily quota",
  reserve: "transactional reserve",
  pace: "provider pace",
  warmOn: "warm-up",
  warmStart: "warm-up",
  warmFactor: "warm-up",
  warmBounce: "warm-up",
  warmComplaint: "warm-up",
  pauseBounce: "automatic pause",
  pauseComplaint: "automatic pause",
}

/** Which inputs aren't numbers in range; the key is the field. */
function problems(f: Form): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {}
  const int = (v: string, min: number) => /^\d+$/.test(v.trim()) && Number(v) >= min
  if (f.dailyQuota.trim() && !int(f.dailyQuota, 1))
    out.dailyQuota = "A whole number, or empty for Cloudflare’s."
  if (!int(f.fallbackQuota, 1)) out.fallbackQuota = "A whole number."
  const r = fromPercentInput(f.reserve)
  if (r === null || r < 0 || r > 0.9) out.reserve = "0 to 90%."
  for (const p of PROVIDERS) if (!int(f.pace[p], 1)) out[`pace.${p}`] = "At least 1."
  if (!int(f.warmStart, 1)) out.warmStart = "A whole number."
  const fac = Number(f.warmFactor)
  if (!Number.isFinite(fac) || fac < 1 || fac > 5) out.warmFactor = "1 to 5."
  for (const k of ["warmBounce", "warmComplaint", "pauseBounce", "pauseComplaint"] as const) {
    const v = fromPercentInput(f[k])
    if (v === null || v <= 0 || v > 1) out[k] = "A percentage above 0."
  }
  return out
}

function SettingsForm({ s, g }: { s: SendingSettings; g: Governor | undefined }) {
  const qc = useQueryClient()
  const initial = useMemo(() => formOf(s), [s])
  const [f, setF] = useState(initial)
  useEffect(() => setF(initial), [initial])
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }))
  const changed = changedFields(initial, f, LABELS)
  const bad = problems(f)
  const blocked = Object.keys(bad).length > 0
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/v1/settings/sending", {
          body: {
            dailyQuota: f.dailyQuota.trim() ? Number(f.dailyQuota) : null,
            fallbackQuota: Number(f.fallbackQuota),
            transactionalReserve: fromPercentInput(f.reserve) ?? 0,
            providerPerMinute: Object.fromEntries(PROVIDERS.map((p) => [p, Number(f.pace[p])])),
            warmup: {
              enabled: f.warmOn,
              start: Number(f.warmStart),
              factor: Number(f.warmFactor),
              maxBounceRate: fromPercentInput(f.warmBounce) ?? 0,
              maxComplaintRate: fromPercentInput(f.warmComplaint) ?? 0,
            },
            pause: {
              bounceRate: fromPercentInput(f.pauseBounce) ?? 0,
              complaintRate: fromPercentInput(f.pauseComplaint) ?? 0,
            },
          },
        }),
      ),
    onSuccess: (r) => {
      qc.setQueryData(sendingSettingsQuery.queryKey, r)
      qc.invalidateQueries({ queryKey: governorQuery.queryKey })
      toast({ title: "Sending settings saved", sub: "They apply to the next send" })
    },
  })
  const err = (k: string) =>
    bad[k] ? (
      <span className="field-error">
        <Icon name="x-circle" />
        {bad[k]}
      </span>
    ) : null
  const quotaHint = g ? `Use Cloudflare’s (${fmtInt(g.quota)})` : "Use Cloudflare’s"
  return (
    <>
      <div className="panel" data-endpoint="GET/PUT /v1/settings/sending" data-od-id="panel-sending-form">
        <div className="panel-body">
          <section className="form-section">
            <div className="fs-head">
              <h2>Daily quota</h2>
              <p>Cloudflare sets it; you can set a lower one.</p>
            </div>
            <div className="fs-body">
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="q">
                    Your cap <span className="opt">· optional</span>
                  </label>
                  <input
                    className="input"
                    id="q"
                    inputMode="numeric"
                    placeholder={quotaHint}
                    value={f.dailyQuota}
                    onChange={(e) => set("dailyQuota", e.target.value)}
                    aria-invalid={bad.dailyQuota ? true : undefined}
                  />
                  {err("dailyQuota")}
                </div>
                <div className="field">
                  <label className="label" htmlFor="fq">
                    If Cloudflare doesn’t answer
                  </label>
                  <input
                    className="input"
                    id="fq"
                    inputMode="numeric"
                    value={f.fallbackQuota}
                    onChange={(e) => set("fallbackQuota", e.target.value)}
                    aria-invalid={bad.fallbackQuota ? true : undefined}
                  />
                  {err("fallbackQuota")}
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor="tr">
                  Held for transactional mail
                </label>
                <div className="input-group">
                  <input
                    className="input"
                    id="tr"
                    inputMode="decimal"
                    value={f.reserve}
                    onChange={(e) => set("reserve", e.target.value)}
                    aria-invalid={bad.reserve ? true : undefined}
                  />
                  <span className="addon">% of the quota</span>
                </div>
                {err("reserve")}
              </div>
            </div>
          </section>
          <section className="form-section">
            <div className="fs-head">
              <h2>Pace per mailbox provider</h2>
              <p>Sends a minute, so no provider sees a burst.</p>
            </div>
            <div className="fs-body">
              <table className="rtable">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th className="r">This minute</th>
                    <th className="r">Cap</th>
                  </tr>
                </thead>
                <tbody>
                  {PROVIDERS.map((p) => (
                    <tr key={p}>
                      <td className="is-head">{PROVIDER_LABEL[p]}</td>
                      <td className="r" data-label="This minute">
                        {g ? fmtInt(g.providerThisMinute[p]) : "—"}
                      </td>
                      <td className="r" data-label="Per minute cap">
                        <input
                          className="input"
                          style={{ width: 80, height: 32, textAlign: "right" }}
                          inputMode="numeric"
                          value={f.pace[p]}
                          aria-label={`${PROVIDER_LABEL[p]} per minute`}
                          aria-invalid={bad[`pace.${p}`] ? true : undefined}
                          onChange={(e) => set("pace", { ...f.pace, [p]: e.target.value })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="form-section">
            <div className="fs-head">
              <h2>Warm-up for new domains</h2>
              <p>Starts small and grows each day while the rates stay low.</p>
            </div>
            <div className="fs-body">
              <label className="switch">
                <input type="checkbox" checked={f.warmOn} onChange={(e) => set("warmOn", e.target.checked)} />
                Warm up new sending domains
              </label>
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="ws">
                    First day
                  </label>
                  <input
                    className="input"
                    id="ws"
                    inputMode="numeric"
                    value={f.warmStart}
                    onChange={(e) => set("warmStart", e.target.value)}
                    disabled={!f.warmOn}
                  />
                  {err("warmStart")}
                </div>
                <div className="field">
                  <label className="label" htmlFor="wf">
                    Growth each day
                  </label>
                  <div className="input-group">
                    <input
                      className="input"
                      id="wf"
                      inputMode="decimal"
                      value={f.warmFactor}
                      onChange={(e) => set("warmFactor", e.target.value)}
                      disabled={!f.warmOn}
                    />
                    <span className="addon">×</span>
                  </div>
                  {err("warmFactor")}
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="wb">
                    Hold growth above bounce
                  </label>
                  <div className="input-group">
                    <input
                      className="input"
                      id="wb"
                      inputMode="decimal"
                      value={f.warmBounce}
                      onChange={(e) => set("warmBounce", e.target.value)}
                      disabled={!f.warmOn}
                    />
                    <span className="addon">%</span>
                  </div>
                  {err("warmBounce")}
                </div>
                <div className="field">
                  <label className="label" htmlFor="wc">
                    Hold growth above complaints
                  </label>
                  <div className="input-group">
                    <input
                      className="input"
                      id="wc"
                      inputMode="decimal"
                      value={f.warmComplaint}
                      onChange={(e) => set("warmComplaint", e.target.value)}
                      disabled={!f.warmOn}
                    />
                    <span className="addon">%</span>
                  </div>
                  {err("warmComplaint")}
                </div>
              </div>
              <span className="hint">
                Established, so not warmed:{" "}
                {s.establishedDomains.length
                  ? s.establishedDomains.map((d, i) => (
                      <span key={d}>
                        {i ? ", " : ""}
                        <span className="mono">{d}</span>
                      </span>
                    ))
                  : "none"}
              </span>
            </div>
          </section>
          <section className="form-section">
            <div className="fs-head">
              <h2>Automatic pause</h2>
              <p>Stops a campaign before Cloudflare’s lines are near.</p>
            </div>
            <div className="fs-body">
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="pb">
                    Pause above bounce rate
                  </label>
                  <div className="input-group">
                    <input
                      className="input"
                      id="pb"
                      inputMode="decimal"
                      value={f.pauseBounce}
                      onChange={(e) => set("pauseBounce", e.target.value)}
                    />
                    <span className="addon">%</span>
                  </div>
                  {err("pauseBounce") ?? (
                    <span className="hint">Over the last {fmtInt(s.pause.minOutcomes)} outcomes</span>
                  )}
                </div>
                <div className="field">
                  <label className="label" htmlFor="pc">
                    Pause above complaint rate
                  </label>
                  <div className="input-group">
                    <input
                      className="input"
                      id="pc"
                      inputMode="decimal"
                      value={f.pauseComplaint}
                      onChange={(e) => set("pauseComplaint", e.target.value)}
                    />
                    <span className="addon">%</span>
                  </div>
                  {err("pauseComplaint") ?? (
                    <span className="hint">Once there are {fmtInt(s.pause.minComplaints)} complaints</span>
                  )}
                </div>
              </div>
              <span className="hint">
                Cloudflare puts the account at risk at a 5% bounce rate and a 0.2% complaint rate.
              </span>
            </div>
          </section>
        </div>
      </div>
      {save.isError ? <ApiRefusal error={save.error} /> : null}
      <SaveBar
        line={
          blocked
            ? "Fix the highlighted fields to save"
            : changed.length
              ? unsavedLine(changed)
              : "Changes apply to the next send; nothing in flight restarts."
        }
        tone={blocked ? "error" : "muted"}
      >
        {changed.length ? (
          <button className="btn btn-ghost" type="button" onClick={() => setF(initial)}>
            Discard
          </button>
        ) : null}
        <button
          className="btn btn-primary"
          type="button"
          aria-disabled={blocked || !changed.length || save.isPending ? true : undefined}
          onClick={() => !blocked && changed.length && !save.isPending && save.mutate()}
          data-endpoint="PUT /v1/settings/sending"
        >
          {save.isPending ? "Saving…" : "Save sending settings"}
        </button>
      </SaveBar>
    </>
  )
}

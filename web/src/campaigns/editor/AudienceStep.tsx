/**
 * Step 2, audience (design: campaign-audience.html, -exclude-error, -days-error, -complex; GAPS-audience A7.3).
 * Who it goes to (a segment within a topic, or everyone on a topic), who's left out (up to 10 segments, never
 * the campaign's own, and anyone mailed by another campaign in the last 1–90 days), and the live count from
 * `POST /v1/campaigns/{id}/audience/preview`: its buckets in the API's order, adding up to the match.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { allTopicsQuery, segmentsQuery } from "../../audience/kit/queries.ts"
import { FieldError } from "../../audience/kit/ui.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError } from "../../ui/Panel.tsx"
import { fmtDayKey, MAX_EXCLUDED_SEGMENTS, parseRecentDays, previewBuckets } from "../logic.ts"
import { forecastQuery, previewQuery } from "../queries.ts"
import { AppLink } from "../ui.tsx"
import { useEditor } from "./EditorContext.tsx"
import { EditorFrame } from "./EditorFrame.tsx"
import { useFocusParam } from "./focus.ts"

export function AudienceStep({ focus }: { focus?: string | undefined }) {
  const ed = useEditor()
  const c = ed.draft
  const segments = useQuery(segmentsQuery)
  const topics = useQuery(allTopicsQuery)
  const ro = !ed.editable
  const [mode, setMode] = useState<"segment" | "topic">(c.segmentId || !c.topicId ? "segment" : "topic")
  useFocusParam(
    focus === "exclude"
      ? "ex-seg-l"
      : focus === "recentlySentDays"
        ? "ex-days"
        : focus
          ? `a-${focus === "topicId" ? "top" : "seg"}`
          : undefined,
  )

  const field =
    ed.error?.status === 400 && typeof ed.error.body.field === "string" ? ed.error.body.field : null
  const segErr = field === "exclude.segmentIds" ? ed.error?.message : null
  const daysErrServer = field === "exclude.recentlySentDays" ? ed.error?.message : null
  const complexErr = field === "exclude" ? ed.error?.message : null
  const audErr =
    field === "segmentId" || field === "topicId" || field === "audience" ? ed.error?.message : null

  const exclude = c.exclude ?? { segmentIds: [], recentlySentDays: null }
  const setExclude = (patch: Partial<typeof exclude>) => {
    const next = { ...exclude, ...patch }
    ed.set({ exclude: next.segmentIds.length === 0 && next.recentlySentDays === null ? null : next })
  }
  const [daysText, setDaysText] = useState(
    exclude.recentlySentDays === null ? "" : String(exclude.recentlySentDays),
  )
  const parsed = parseRecentDays(daysText)
  const daysErr = "error" in parsed ? parsed.error : daysErrServer

  const liveTopics = (topics.data ?? []).filter((t) => !t.archived || t.id === c.topicId)
  const topic = topics.data?.find((t) => t.id === c.topicId)

  return (
    <EditorFrame step="audience">
      <div className="editor cmp-editor">
        <div className="stack">
          <section
            className="panel"
            data-endpoint="PATCH /v1/campaigns/:id {segmentId, topicId, exclude: {segmentIds, recentlySentDays}}"
            data-od-id="panel-audience-picker"
            aria-labelledby="h-audience-picker"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-audience-picker">
                Audience
              </h2>
            </header>
            <div className="panel-body">
              <div className="stack stack-16">
                <fieldset className="stack stack-8" style={{ border: 0, margin: 0, padding: 0 }}>
                  <legend className="label" style={{ marginBottom: 8 }}>
                    Send to
                  </legend>
                  <div className="choices">
                    {(
                      [
                        [
                          "segment",
                          "A segment, within a topic",
                          "Rules pick who; the topic makes sure they agreed to this kind of mail.",
                        ],
                        ["topic", "Everyone on a topic", "Every subscriber of one topic."],
                      ] as const
                    ).map(([m, title, sub]) => (
                      <label key={m} className={`choice${mode === m ? " is-selected" : ""}`}>
                        <input
                          type="radio"
                          name="aud"
                          className="sr-only"
                          checked={mode === m}
                          disabled={ro}
                          onChange={() => {
                            setMode(m)
                            if (m === "topic") ed.set({ segmentId: null })
                          }}
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
                <div className="fgrid">
                  {mode === "segment" ? (
                    <div className="field">
                      <label className="label" htmlFor="a-seg">
                        Segment
                      </label>
                      <select
                        className="select"
                        id="a-seg"
                        data-endpoint="GET /v1/segments"
                        value={c.segmentId ?? ""}
                        disabled={ro}
                        onChange={(e) => {
                          const id = e.target.value || null
                          ed.set({
                            segmentId: id,
                            ...(id && exclude.segmentIds.includes(id)
                              ? {
                                  exclude: {
                                    ...exclude,
                                    segmentIds: exclude.segmentIds.filter((s) => s !== id),
                                  },
                                }
                              : {}),
                          })
                        }}
                      >
                        <option value="">Choose a segment</option>
                        {(segments.data ?? []).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} · {s.count === null ? "counting" : fmtInt(s.count)}
                          </option>
                        ))}
                      </select>
                      {c.segmentId ? (
                        <AppLink className="link-quiet" href={`/audience/segments/${c.segmentId}`}>
                          Open in the segment builder
                          <Icon name="chevron-right" />
                        </AppLink>
                      ) : (
                        <AppLink className="link-quiet" href="/audience/segments">
                          Build a segment
                          <Icon name="chevron-right" />
                        </AppLink>
                      )}
                    </div>
                  ) : null}
                  <div className="field">
                    <label className="label" htmlFor="a-top">
                      Topic
                    </label>
                    <select
                      className="select"
                      id="a-top"
                      data-endpoint="GET /v1/topics"
                      value={c.topicId ?? ""}
                      disabled={ro}
                      onChange={(e) => ed.set({ topicId: e.target.value || null })}
                    >
                      <option value="">
                        {mode === "segment" ? "No topic (anyone subscribed)" : "Choose a topic"}
                      </option>
                      {liveTopics.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {fmtInt(t.subscribers)}
                        </option>
                      ))}
                    </select>
                    <span className="hint">
                      {topic
                        ? topic.doubleOptIn
                          ? "Double opt-in: only confirmed subscribers receive it."
                          : "Only people subscribed to this topic receive it."
                        : "Without a topic, everyone the segment matches who is subscribed receives it."}
                    </span>
                  </div>
                </div>
                {audErr ? <FieldError id="aud-err">{audErr}</FieldError> : null}
                <div className="divider" />
                <fieldset
                  className="stack stack-12"
                  style={{ border: 0, margin: 0, padding: 0 }}
                  data-od-id="exclusions"
                >
                  <legend className="label" style={{ marginBottom: 8 }}>
                    Leave out{" "}
                    <span className="opt">
                      <code className="mono">exclude</code>
                    </span>
                  </legend>
                  {complexErr ? (
                    <div className="callout callout-error" role="alert" data-od-id="exclude-complex">
                      <Icon name="x-circle" />
                      <span>
                        <b>Not saved.</b> “{complexErr}” <code className="mono">exclude</code>
                      </span>
                    </div>
                  ) : null}
                  <ExcludePicker
                    selected={exclude.segmentIds}
                    own={c.segmentId}
                    readOnly={ro}
                    error={segErr ?? null}
                    onChange={(ids) => setExclude({ segmentIds: ids })}
                  />
                  <div className="field">
                    <label className="label" htmlFor="ex-days">
                      Skip anyone mailed in the last{" "}
                      <span className="opt">
                        1–90 days · <code className="mono">recentlySentDays</code>
                      </span>
                    </label>
                    <div className="input-group" style={{ maxWidth: 200 }}>
                      <input
                        className="input"
                        id="ex-days"
                        value={daysText}
                        inputMode="numeric"
                        readOnly={ro}
                        placeholder="Off"
                        onChange={(e) => {
                          setDaysText(e.target.value)
                          const p = parseRecentDays(e.target.value)
                          if ("value" in p) setExclude({ recentlySentDays: p.value })
                        }}
                        {...(daysErr ? { "aria-invalid": true, "aria-describedby": "ex-days-err" } : {})}
                      />
                      <span className="addon">days</span>
                    </div>
                    {daysErr ? (
                      <FieldError id="ex-days-err">
                        {daysErr} <code className="mono">exclude.recentlySentDays</code>
                      </FieldError>
                    ) : null}
                    <span className="hint">
                      By another campaign: this one’s own sends don’t count. Keeps one person from getting two
                      campaigns in a few days.
                    </span>
                  </div>
                </fieldset>
              </div>
            </div>
          </section>
        </div>
        <div className="side">
          <WhoGetsIt topicName={topic?.name ?? null} />
          <QuotaPanel />
        </div>
      </div>
    </EditorFrame>
  )
}

function ExcludePicker({
  selected,
  own,
  readOnly,
  error,
  onChange,
}: {
  selected: string[]
  own: string | null
  readOnly: boolean
  error: string | null
  onChange: (ids: string[]) => void
}) {
  const segments = useQuery(segmentsQuery)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", off)
    document.addEventListener("keydown", esc)
    return () => {
      document.removeEventListener("mousedown", off)
      document.removeEventListener("keydown", esc)
    }
  }, [open])
  const all = segments.data ?? []
  const name = (id: string) => all.find((s) => s.id === id)?.name ?? id
  const ownName = own ? name(own) : null
  const full = selected.length >= MAX_EXCLUDED_SEGMENTS
  return (
    <div className="field">
      <span className="label" id="ex-seg-l" tabIndex={-1}>
        Exclude these segments{" "}
        <span className="opt">
          up to {MAX_EXCLUDED_SEGMENTS} · {selected.length} picked
        </span>
      </span>
      <div className="fchip-anchor ex-picker" ref={box}>
        {/* biome-ignore lint/a11y/useSemanticElements: a group of removable chips, as the design's .vchips */}
        <span
          className="vchips"
          role="group"
          aria-labelledby="ex-seg-l"
          {...(error ? { "aria-describedby": "ex-seg-err" } : {})}
        >
          {selected.map((id) => (
            <span key={id} className="vchip">
              {name(id)}
              {readOnly ? null : (
                <button
                  type="button"
                  aria-label={`Remove ${name(id)}`}
                  onClick={() => onChange(selected.filter((s) => s !== id))}
                >
                  <Icon name="x" />
                </button>
              )}
            </span>
          ))}
          {selected.length === 0 ? (
            <span className="vchip-empty muted t-small">Nobody left out by segment</span>
          ) : null}
          {readOnly ? null : (
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls="ex-menu"
              onClick={() => setOpen((o) => !o)}
            >
              <Icon name="plus" />
              Add
            </button>
          )}
        </span>
        {open ? (
          <div className="menu chip-menu" id="ex-menu" role="menu" aria-label="Segments to exclude">
            <div className="menu-label">Exclude · up to {MAX_EXCLUDED_SEGMENTS}</div>
            {all.length === 0 ? <div className="menu-item is-disabled">No segments yet</div> : null}
            {all.map((s) => {
              const isOwn = s.id === own
              const checked = selected.includes(s.id)
              const disabled = isOwn || (!checked && full)
              return (
                <label key={s.id} className={`menu-item${disabled ? " is-disabled" : ""}`}>
                  <span className="check">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) =>
                        onChange(e.target.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id))
                      }
                    />
                  </span>
                  <span className="grow">
                    {s.name}
                    {isOwn ? (
                      <span className="hint" style={{ display: "block" }}>
                        This campaign is sent to it, so it can’t also be left out.
                      </span>
                    ) : !checked && full ? (
                      <span className="hint" style={{ display: "block" }}>
                        {MAX_EXCLUDED_SEGMENTS} is the most a campaign can leave out.
                      </span>
                    ) : null}
                  </span>
                  <span className="kind">{s.count === null ? "…" : fmtInt(s.count)}</span>
                </label>
              )
            })}
          </div>
        ) : null}
      </div>
      {error ? (
        <FieldError id="ex-seg-err">
          {error} <code className="mono">exclude.segmentIds</code>
        </FieldError>
      ) : null}
      <span className="hint">
        Anyone in these is left out, counted once under the first one they’re in.
        {ownName
          ? ` The campaign’s own segment, ${ownName}, can’t be picked: it would leave out everyone.`
          : ""}
      </span>
    </div>
  )
}

function WhoGetsIt({ topicName }: { topicName: string | null }) {
  const ed = useEditor()
  const version = num(ed.server.updatedAt)
  const pending = ed.state === "dirty" || ed.state === "saving"
  const q = useQuery({ ...previewQuery(ed.id, version), placeholderData: keepPreviousData })
  const p = q.data && "matching" in q.data ? q.data : null
  const sum = p
    ? previewBuckets(p, { topicName, recentlySentDays: ed.server.exclude?.recentlySentDays })
    : null
  const status = sum?.buckets.filter((b) => b.group === "status") ?? []
  const excl = sum?.buckets.filter((b) => b.group === "exclusion") ?? []
  const counting = pending || q.isFetching
  return (
    <section
      className="panel"
      data-endpoint={`POST /v1/campaigns/${ed.id}/audience/preview → matching, sendable, excluded{…, bySegment, recentlySent}`}
      data-od-id="panel-audience-preview"
      aria-labelledby="h-audience-preview"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-audience-preview">
          Who gets it
        </h2>
        <div className="cluster">
          <span className="panel-meta">{counting ? "Counting…" : "Live"}</span>
        </div>
      </header>
      <div className="panel-body">
        {q.isPending ? (
          <div className="stack stack-8" aria-hidden="true">
            <span className="sk sk-title" />
            <span className="sk sk-text" />
            <span className="sk sk-text" />
          </div>
        ) : q.isError && !p ? (
          <PanelError error={q.error} onRetry={() => q.refetch()} what="The count didn’t load" />
        ) : p && sum ? (
          <div className="stack stack-12">
            <div
              className={`livecount${counting ? " is-counting" : ""}${sum.sendable === 0 ? " is-zero" : ""}`}
              role="status"
              aria-live="polite"
            >
              <span className="lc-n">{fmtInt(sum.sendable)}</span>
              <span className="lc-l">will receive it</span>
              <span className="lc-meta">
                <Icon name={counting ? "refresh" : "check"} />
                {pending
                  ? "Counts again once your change saves"
                  : counting
                    ? "Counting…"
                    : "Counted just now"}
              </span>
            </div>
            <div className="lc-split ex-sum" data-od-id="excluded-breakdown">
              <div className="row is-total">
                <span>{topicName ? "Match the segment and topic" : "Match the audience"}</span>
                <b>{fmtInt(sum.matching)}</b>
              </div>
              <div className="ex-group">Their status</div>
              {status.map((b) => (
                <div key={b.key} className={`row ex-status${b.count === 0 ? " is-zero" : ""}`}>
                  <span>{b.label}</span>
                  <b>−{fmtInt(b.count)}</b>
                </div>
              ))}
              {excl.length ? (
                <>
                  <div className="ex-group">
                    Your exclusions · each person once, under the first they match
                  </div>
                  {excl.map((b) => (
                    <div
                      key={b.key}
                      className={`row ${b.key === "recentlySent" ? "ex-recent" : "ex-seg"}${b.count === 0 ? " is-zero" : ""}`}
                    >
                      <span>{b.label}</span>
                      <b>−{fmtInt(b.count)}</b>
                    </div>
                  ))}
                </>
              ) : null}
              <div className="divider" />
              <div className="row">
                <span>Left out</span>
                <b>−{fmtInt(sum.leftOut)}</b>
              </div>
              <div className="row is-total">
                <span>Will receive it</span>
                <b>{fmtInt(sum.sendable)}</b>
              </div>
            </div>
            <p className="ex-check mono" data-od-id="adds-up">
              {fmtInt(sum.sendable)} + {fmtInt(sum.leftOut)} = {fmtInt(sum.sendable + sum.leftOut)}{" "}
              {sum.addsUp ? (
                <Icon name="check" />
              ) : (
                <span className="t-small" style={{ fontFamily: "var(--font-sans)" }}>
                  (the API counted {fmtInt(sum.matching)} matching)
                </span>
              )}
            </p>
            {sum.matching > 0 ? (
              <div
                className="splitbar"
                role="img"
                aria-label={`${fmtInt(sum.sendable)} sendable of ${fmtInt(sum.matching)} matching`}
              >
                <span style={{ flex: sum.sendable, ["--c" as string]: "var(--data-good)" }} />
                <span style={{ flex: num(p.excluded.blocked) ?? 0, ["--c" as string]: "var(--data-bad)" }} />
                <span
                  style={{
                    flex: status.filter((b) => b.key !== "blocked").reduce((s, b) => s + b.count, 0),
                    ["--c" as string]: "var(--data-neutral)",
                  }}
                />
                <span
                  style={{
                    flex: excl.reduce((s, b) => s + b.count, 0),
                    ["--c" as string]: "var(--data-warn)",
                  }}
                />
              </div>
            ) : null}
            <div className="legend">
              <span>
                <i className="swatch-good" />
                Will receive it
              </span>
              <span>
                <i className="sw" style={{ ["--c" as string]: "var(--data-bad)" }} />
                Blocked
              </span>
              <span>
                <i className="swatch-neutral" />
                Status
              </span>
              <span>
                <i className="sw" style={{ ["--c" as string]: "var(--data-warn)" }} />
                Your exclusions
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function QuotaPanel() {
  const ed = useEditor()
  const preview = useQuery(previewQuery(ed.id, num(ed.server.updatedAt)))
  const sendable = preview.data && "sendable" in preview.data ? (num(preview.data.sendable) ?? 0) : null
  const f = useQuery({
    ...forecastQuery(sendable ?? 0, null, ed.id),
    enabled: sendable !== null && sendable > 0,
  })
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/usage/forecast?recipients=${sendable ?? ""}&campaignId=${ed.id}`}
      data-od-id="panel-audience-cost"
      aria-labelledby="h-audience-cost"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-audience-cost">
          At today’s quota
        </h2>
      </header>
      <div className="panel-body">
        <div className="stack stack-8">
          {sendable === 0 ? (
            <p className="hint">Nobody to send to yet, so there’s nothing to forecast.</p>
          ) : !f.data ? (
            f.isError ? (
              <PanelError error={f.error} onRetry={() => f.refetch()} what="The forecast didn’t load" />
            ) : (
              <span className="sk sk-text" />
            )
          ) : f.data.possible ? (
            <p className="eta-line">
              <b>{fmtInt(f.data.recipients)}</b> recipients finish by{" "}
              <b>{fmtDayKey(f.data.finishesBy?.slice(0, 10))}</b>
              {num(f.data.additionalDays)
                ? `, ${fmtInt(f.data.additionalDays)} days after the first`
                : ", in a day"}
              .
            </p>
          ) : (
            <div className="callout callout-warn">
              <Icon name="warn" />
              <span>
                <b>Can’t forecast yet.</b> {f.data.reason}
              </span>
            </div>
          )}
          <Link className="link-quiet" to="/campaigns/$campaignId/schedule" params={{ campaignId: ed.id }}>
            See the schedule
            <Icon name="chevron-right" />
          </Link>
        </div>
      </div>
    </section>
  )
}

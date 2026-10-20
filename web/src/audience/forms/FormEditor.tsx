/**
 * The form editor (design: form-editor.html and its -turnstile-on, -pick, -legacy, -invalid, -iframe and
 * -stats-new states; GAPS-audience A4.1–A4.6). One draft of the form, saved with `PATCH /v1/forms/{id}`;
 * each 400 is marked on the field its `field` names (a field definition's row for `fieldDefs[i]…`).
 * Turnstile reads `turnstile.configured`, stats come from `/stats?range=`, and the snippets are the API's own
 * (`GET /v1/forms/{id}/embed`), shown verbatim. The preview mirrors the hosted page.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type DragEvent, type ReactNode, useId, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { meQuery } from "../../auth/session.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, RequestId } from "../../ui/Panel.tsx"
import { errorField, fmtDay } from "../kit/format.ts"
import { allTopicsQuery, type Topic } from "../kit/queries.ts"
import { BackLink, CopyButton, FieldError, SampleMarker, useCan } from "../kit/ui.tsx"
import { ValueChips } from "../segments/ValueChips.tsx"
import {
  addDef,
  bars,
  countingSince,
  defIndex,
  FIELD_DEF_TYPES,
  type FieldDef,
  type FieldDefType,
  type FormDraft,
  formBody,
  isLegacy,
  moveDef,
  resolveDefs,
  STATS_SINCE,
  TURNSTILE_UNCHECKED,
  TYPE_LABEL,
  turnstileState,
  updateDef,
  validateDraft,
  validateKey,
} from "./logic.ts"
import { brandQuery, type Form, formEmbedQuery, formQuery, formStatsQuery, type Range } from "./queries.ts"
import "./forms.css"

export function FormEditor({ id }: { id: string }) {
  const q = useQuery(formQuery(id))
  if (q.isPending)
    return (
      <div className="au-form" aria-busy="true">
        <BackLink to="/audience/forms">Forms</BackLink>
        <div className="obj-head">
          <div className="oh-main">
            <span className="sk sk-title" style={{ width: 320 }} />
            <span className="sk sk-text" style={{ width: 220 }} />
          </div>
        </div>
        <div className="editor">
          <section className="panel">
            <div className="panel-body stack stack-12">
              {[80, 70, 60].map((w) => (
                <span key={w} className="sk sk-text" style={{ width: `${w}%`, height: 36 }} />
              ))}
            </div>
          </section>
        </div>
      </div>
    )
  if (q.isError)
    return (
      <div className="au-form">
        <BackLink to="/audience/forms">Forms</BackLink>
        <PanelError error={q.error} onRetry={() => q.refetch()} what="This form didn’t load" />
      </div>
    )
  return <Editor key={`${q.data.id}`} form={q.data} />
}

const draftOf = (f: Form): FormDraft => ({
  name: f.name,
  description: f.description ?? "",
  redirectUrl: f.redirectUrl ?? "",
  topicIds: [...f.topicIds],
  topicChoice: f.topicChoice,
  fieldDefs: resolveDefs(f),
  turnstileSiteKey: f.turnstileSiteKey ?? "",
})

function Editor({ form }: { form: Form }) {
  const qc = useQueryClient()
  const write = useCan("contacts.write", "edit forms")
  const topics = useQuery(allTopicsQuery)
  const embed = useQuery(formEmbedQuery(form.id))
  const stats30 = useQuery(formStatsQuery(form.id, "30d"))
  const [saved, setSaved] = useState<FormDraft>(() => draftOf(form))
  const [d, setD] = useState<FormDraft>(() => draftOf(form))
  const [tried, setTried] = useState(false)
  const local = validateDraft(d)
  const dirty = JSON.stringify(d) !== JSON.stringify(saved)

  const save = useMutation({
    mutationFn: () =>
      unwrap(api.PATCH("/v1/forms/{id}", { params: { path: { id: form.id } }, body: formBody(d) })),
    onSuccess: (f) => {
      if (f && "id" in f) {
        qc.setQueryData(formQuery(form.id).queryKey, f)
        setSaved(d)
      }
      qc.invalidateQueries({ queryKey: ["forms"], exact: true })
      qc.invalidateQueries({ queryKey: formEmbedQuery(form.id).queryKey })
      qc.invalidateQueries({ queryKey: ["contact-fields"] })
    },
  })
  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      unwrap(api.PATCH("/v1/forms/{id}", { params: { path: { id: form.id } }, body: { archived } })),
    onSuccess: (f) => {
      if (f && "id" in f) qc.setQueryData(formQuery(form.id).queryKey, f)
      qc.invalidateQueries({ queryKey: ["forms"] })
    },
  })

  const current = (qc.getQueryData(formQuery(form.id).queryKey) as Form | undefined) ?? form
  // The error to mark: the local check once a save was tried, else the API's 400.
  const apiErr = save.error instanceof ApiError && save.error.status === 400 ? save.error : null
  const problem =
    tried && local ? local : apiErr ? { field: errorField(apiErr) ?? "", message: apiErr.message } : null
  const errOn = (field: string) => (problem?.field === field ? problem.message : null)
  const badRow = defIndex(problem?.field)
  const ts = turnstileState(current.turnstile)
  const set = (patch: Partial<FormDraft>) => setD((x) => ({ ...x, ...patch }))
  const submit = () => {
    setTried(true)
    if (!validateDraft(d)) save.mutate()
  }
  const saveBlock = !write.allowed
    ? { reason: "You can’t edit forms", who: write.who }
    : !dirty
      ? { reason: "Nothing to save", who: "Change something on the form first." }
      : null
  const pageUrl = embed.data?.pageUrl

  return (
    <div className="au-form">
      <BackLink to="/audience/forms">Forms</BackLink>
      <div className="obj-head" data-od-id="object-head">
        <div className="oh-main">
          <h1 data-od-id="page-title">{d.name.trim() || current.name}</h1>
          <div className="oh-sub">
            <code className="mono">/f/{current.id}</code>
            <span className={`pill ${current.archived ? "pill-neutral" : "pill-pass"}`}>
              <span className="dot" />
              {current.archived ? "Archived" : "Live"}
            </span>
            {stats30.data ? <span>{fmtInt(stats30.data.submissions)} submissions in 30 days</span> : null}
            {ts !== "off" ? (
              <span className={`pill ${ts === "verified" ? "pill-pass" : "pill-warn"}`}>
                <span className="dot" />
                {ts === "verified" ? "Turnstile verified" : "Turnstile not checked"}
              </span>
            ) : null}
            {dirty ? (
              <span className="savestate">
                <Icon name="circle-dash" />
                Unsaved changes
              </span>
            ) : null}
          </div>
        </div>
        <div className="oh-actions">
          <SampleMarker />
          {pageUrl && !current.archived ? (
            <a className="btn btn-secondary btn-sm" href={pageUrl} target="_blank" rel="noreferrer">
              <Icon name="external" />
              Open hosted page
            </a>
          ) : null}
          <Gated allowed={write.allowed} reason="You can’t archive forms" who={write.who} side="right">
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => archive.mutate(!current.archived)}
              disabled={archive.isPending}
              data-endpoint={`PATCH /v1/forms/${current.id} {archived}`}
            >
              {current.archived ? "Restore" : "Archive"}
            </button>
          </Gated>
          <Gated allowed={!saveBlock} reason={saveBlock?.reason} who={saveBlock?.who} side="right">
            <button
              className={`btn btn-primary btn-sm${save.isPending ? " is-loading" : ""}`}
              type="button"
              onClick={submit}
              data-endpoint={`PATCH /v1/forms/${current.id}`}
            >
              {save.isPending ? <span className="spinner" aria-hidden="true" /> : null}
              Save form
            </button>
          </Gated>
        </div>
      </div>
      {current.archived ? (
        <div className="callout callout-info" role="status" style={{ marginBottom: 16 }}>
          <Icon name="info" />
          <span>
            <b>Archived.</b> Its page answers “not found” and the snippet’s posts are refused. Restore it to
            take sign-ups again.
          </span>
        </div>
      ) : null}
      {ts === "unchecked" ? (
        <div
          className="callout callout-warn"
          role="status"
          style={{ marginBottom: 16 }}
          data-od-id="turnstile-banner"
        >
          <Icon name="warn" />
          <span>
            <b>{TURNSTILE_UNCHECKED}</b>{" "}
            <a className="link" href="#panel-turnstile">
              See Bot protection
            </a>
            .
          </span>
        </div>
      ) : null}
      {archive.isError ? <ErrorLine error={archive.error} what="The form wasn’t changed." /> : null}
      <div className="editor">
        <div className="stack">
          <Section
            id="form-settings"
            title="The form"
            endpoint={`GET/PATCH /v1/forms/${current.id} {name, description, redirectUrl}`}
          >
            {problem ? (
              <SaveError
                problem={problem}
                error={apiErr}
                where={badRow !== null ? d.fieldDefs[badRow]?.label || d.fieldDefs[badRow]?.key : undefined}
              />
            ) : save.isError ? (
              <ErrorLine error={save.error} what="Not saved." />
            ) : null}
            {save.isSuccess && !dirty ? (
              <div className="callout callout-ok" role="status" style={{ marginBottom: 16 }}>
                <Icon name="check-circle" />
                <span>Saved. The hosted page and the snippet use it from now on.</span>
              </div>
            ) : null}
            <div className="stack stack-24">
              <TextField
                id="fm-name"
                label={
                  <>
                    Heading{" "}
                    <span className="opt">
                      the form’s <code className="mono">name</code>, 1–100 characters
                    </span>
                  </>
                }
                value={d.name}
                max={100}
                error={errOn("name")}
                onChange={(v) => set({ name: v })}
              />
              <div className="field">
                <label className="label" htmlFor="fm-desc">
                  Description <span className="opt">optional, up to 500 characters</span>
                </label>
                <textarea
                  className="textarea"
                  id="fm-desc"
                  rows={2}
                  maxLength={500}
                  value={d.description}
                  onChange={(e) => set({ description: e.target.value })}
                  {...(errOn("description")
                    ? { "aria-invalid": true, "aria-describedby": "fm-desc-err" }
                    : {})}
                />
                {errOn("description") ? (
                  <FieldError id="fm-desc-err">{errOn("description")}</FieldError>
                ) : null}
              </div>
              <TextField
                id="fm-redirect"
                mono
                label={
                  <>
                    After they sign up, go to <span className="opt">optional, https</span>
                  </>
                }
                value={d.redirectUrl}
                placeholder="https://example.com/thanks"
                hint="Leave it empty for Mailyard’s own result page."
                error={errOn("redirectUrl")}
                onChange={(v) => set({ redirectUrl: v })}
              />
            </div>
          </Section>
          <TopicsSection
            d={d}
            set={set}
            topics={topics.data ?? []}
            error={errOn("topicIds") ?? errOn("topics") ?? errOn("topicChoice")}
          />
          <FieldsSection
            defs={d.fieldDefs}
            legacy={isLegacy(current)}
            badRow={badRow}
            problem={problem}
            onChange={(fieldDefs) => set({ fieldDefs })}
          />
          <TurnstileSection
            form={current}
            value={d.turnstileSiteKey}
            error={errOn("turnstileSiteKey")}
            onChange={(v) => set({ turnstileSiteKey: v })}
          />
          <StatsSection id={current.id} />
          <EmbedSection id={current.id} dirty={dirty} />
        </div>
        <div className="side">
          <Preview d={d} form={current} topics={topics.data ?? []} pageUrl={pageUrl} />
        </div>
      </div>
    </div>
  )
}

function SaveError({
  problem,
  error,
  where,
}: {
  problem: { field: string; message: string }
  error: ApiError | null
  where?: string | undefined
}) {
  if (!error)
    return (
      <div className="callout callout-error" role="alert" style={{ marginBottom: 16 }}>
        <Icon name="x-circle" />
        <span>
          <b>Not saved.</b> {problem.message}
          {where ? ` It’s “${where}” in Fields, marked below.` : ""}
        </span>
      </div>
    )
  return (
    <div className="callout callout-error" role="alert" style={{ marginBottom: 16 }}>
      <Icon name="x-circle" />
      <div className="stack stack-4">
        <span>
          <b>Not saved.</b> <code className="mono">PATCH /v1/forms</code> answered{" "}
          <b>400 {error.body._tag ?? "InvalidRequest"}</b>: {error.message}
          {where ? ` It’s “${where}” in Fields, marked below.` : ""}
        </span>
        {error.requestId ? <RequestId id={error.requestId} /> : null}
      </div>
    </div>
  )
}

function ErrorLine({ error, what }: { error: unknown; what: string }) {
  const e = error instanceof ApiError ? error : null
  return (
    <div className="callout callout-error" role="alert" style={{ marginBottom: 16 }}>
      <Icon name="x-circle" />
      <div className="stack stack-4">
        <span>
          <b>{what}</b> {e ? e.message : "Mailyard couldn’t be reached. Your changes are still here."}
        </span>
        {e?.requestId ? <RequestId id={e.requestId} /> : null}
      </div>
    </div>
  )
}

function Section({
  id,
  title,
  endpoint,
  meta,
  children,
}: {
  id: string
  title: string
  endpoint: string
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      className="panel"
      id={`panel-${id}`}
      data-endpoint={endpoint}
      data-od-id={`panel-${id}`}
      aria-labelledby={`h-${id}`}
    >
      <header className="panel-head">
        <h2 className="panel-title" id={`h-${id}`}>
          {title}
        </h2>
        <div className="cluster">{meta}</div>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  mono,
  max,
  placeholder,
}: {
  id: string
  label: ReactNode
  value: string
  onChange: (v: string) => void
  error: string | null
  hint?: string
  mono?: boolean
  max?: number
  placeholder?: string
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        className={`input${mono ? " mono" : ""}`}
        id={id}
        value={value}
        maxLength={max}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        {...(error ? { "aria-invalid": true } : {})}
      />
      {hint ? (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? <FieldError id={`${id}-err`}>{error}</FieldError> : null}
    </div>
  )
}

function TopicsSection({
  d,
  set,
  topics,
  error,
}: {
  d: FormDraft
  set: (p: Partial<FormDraft>) => void
  topics: Topic[]
  error: string | null
}) {
  const toggle = (id: string, on: boolean) =>
    set({ topicIds: on ? [...d.topicIds, id] : d.topicIds.filter((x) => x !== id) })
  return (
    <Section id="form-topics" title="Topics" endpoint="PATCH /v1/forms/:id {topicIds, topicChoice}">
      <div className="stack stack-12">
        {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg switch is a labelled button group */}
        <div className="seg" role="group" aria-label="How topics work" data-seg data-od-id="topic-choice">
          <button
            type="button"
            aria-pressed={d.topicChoice === "all"}
            onClick={() => set({ topicChoice: "all" })}
          >
            Subscribe them to all
          </button>
          <button
            type="button"
            aria-pressed={d.topicChoice === "pick"}
            onClick={() => set({ topicChoice: "pick" })}
          >
            Visitors pick
          </button>
        </div>
        <fieldset className="stack stack-8" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="label" style={{ marginBottom: 8 }}>
            The form’s topics{" "}
            <span className="opt">
              at least one · <code className="mono">topicIds</code>
            </span>
          </legend>
          {topics.map((t) => {
            const on = d.topicIds.includes(t.id)
            return (
              <label key={t.id} className="check">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={t.archived && !on}
                  onChange={(e) => toggle(t.id, e.target.checked)}
                />
                <span>
                  {t.name}
                  {t.doubleOptIn ? " · double opt-in: they confirm by email first" : ""}
                  {t.archived ? " · archived" : ""}
                </span>
              </label>
            )
          })}
        </fieldset>
        {error ? <FieldError id="fm-topics-err">{error}</FieldError> : null}
        <p className="hint">
          {d.topicChoice === "all" ? (
            <>
              Visitors join every topic ticked here; the page lists them as “You’ll get all of these”.{" "}
              <code className="mono">topicChoice: all</code>
            </>
          ) : (
            <>
              Visitors tick which of these to join, and must pick at least one (“Choose at least one list to
              join.”). With one topic it starts ticked. <code className="mono">topicChoice: pick</code>
            </>
          )}
        </p>
      </div>
    </Section>
  )
}

export function FieldsSection({
  defs,
  legacy,
  badRow,
  problem,
  onChange,
}: {
  defs: FieldDef[]
  legacy: boolean
  badRow: number | null
  problem: { field: string; message: string } | null
  onChange: (defs: FieldDef[]) => void
}) {
  const [key, setKey] = useState("")
  const [keyErr, setKeyErr] = useState<string | null>(null)
  const drag = useRef<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const ids = useId()
  const add = () => {
    const err = validateKey(key, defs)
    setKeyErr(err)
    if (!err) {
      onChange(addDef(defs, key))
      setKey("")
    }
  }
  const onDrop = (e: DragEvent, i: number) => {
    e.preventDefault()
    if (drag.current !== null) onChange(moveDef(defs, drag.current, i))
    drag.current = null
    setOver(null)
  }
  return (
    <Section
      id="form-fields"
      title="Fields"
      endpoint="PATCH /v1/forms/:id {fieldDefs}"
      meta={<span className="panel-meta">{defs.length} custom</span>}
    >
      <div className="stack stack-12">
        {legacy ? (
          <div className="callout callout-info" data-od-id="legacy-fields">
            <Icon name="info" />
            <span>
              <b>Made before field definitions.</b> This form only lists plain{" "}
              <code className="mono">fields</code>, so they’re shown and asked as optional text. Set a label,
              type or required and save: they’re stored as <code className="mono">fieldDefs</code>, which
              replace <code className="mono">fields</code>.
            </span>
          </div>
        ) : null}
        <ul className="fd-list" data-od-id="field-defs">
          <li className="fd-row is-fixed">
            <span className="fd-grip" aria-hidden="true">
              <Icon name="lock" />
            </span>
            <div className="fd-main">
              <div className="fd-line">
                <code className="mono fd-key">email</code>
                <span className="muted">Email · always on, required</span>
              </div>
            </div>
          </li>
          <li className="fd-row is-fixed">
            <span className="fd-grip" aria-hidden="true">
              <Icon name="lock" />
            </span>
            <div className="fd-main">
              <div className="fd-line">
                <code className="mono fd-key">name</code>
                <span className="muted">Name · always on, optional</span>
              </div>
            </div>
          </li>
          {defs.map((f, i) => {
            const bad = badRow === i
            const optErr = bad ? problem?.message : null
            return (
              <li
                key={f.key}
                className={`fd-row${bad ? " is-error" : ""}${over === i ? " is-drop" : ""}`}
                data-path={`fieldDefs[${i}]`}
                draggable
                onDragStart={(e) => {
                  drag.current = i
                  e.dataTransfer.effectAllowed = "move"
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(i)
                }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => onDrop(e, i)}
                onDragEnd={() => setOver(null)}
              >
                <span className="fd-grip" aria-hidden="true">
                  <Icon name="grip" />
                </span>
                <div className="fd-main">
                  <div className="fd-line">
                    <code className="mono fd-key">{f.key}</code>
                    <input
                      className="input"
                      value={f.label}
                      maxLength={100}
                      aria-label={`Label for ${f.key}`}
                      onChange={(e) => onChange(updateDef(defs, i, { label: e.target.value }))}
                    />
                    <select
                      className="select"
                      aria-label={`Type of ${f.key}`}
                      value={f.type}
                      onChange={(e) => onChange(updateDef(defs, i, { type: e.target.value as FieldDefType }))}
                    >
                      {FIELD_DEF_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                    <label className="switch fd-req">
                      <input
                        type="checkbox"
                        checked={f.required}
                        aria-label={`${f.key} required`}
                        onChange={(e) => onChange(updateDef(defs, i, { required: e.target.checked }))}
                      />{" "}
                      Required
                    </label>
                  </div>
                  {f.type === "select" ? (
                    <div className={`fd-opts${bad ? " is-error" : ""}`}>
                      <span className="label">
                        Options <span className="opt">1–50</span>
                      </span>
                      <ValueChips
                        label="Options"
                        placeholder="Add an option"
                        values={f.options ?? []}
                        invalid={bad}
                        describedBy={bad ? `${ids}-opt-err-${i}` : undefined}
                        onChange={(v) => onChange(updateDef(defs, i, { options: v.map(String) }))}
                      />
                      {optErr ? (
                        <span className="field-error" role="alert" id={`${ids}-opt-err-${i}`}>
                          <Icon name="x-circle" />
                          {optErr} <code className="mono">{problem?.field}</code>
                        </span>
                      ) : null}
                    </div>
                  ) : bad && optErr ? (
                    <span className="field-error" role="alert">
                      <Icon name="x-circle" />
                      {optErr} <code className="mono">{problem?.field}</code>
                    </span>
                  ) : null}
                </div>
                <span className="fd-move">
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`Move ${f.key} up`}
                    disabled={i === 0}
                    onClick={() => onChange(moveDef(defs, i, i - 1))}
                  >
                    <Icon name="chevron-down" className="flip" />
                  </button>
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`Move ${f.key} down`}
                    disabled={i === defs.length - 1}
                    onClick={() => onChange(moveDef(defs, i, i + 1))}
                  >
                    <Icon name="chevron-down" />
                  </button>
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`Remove ${f.key}`}
                    onClick={() => onChange(defs.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
        <form
          className="input-group"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input
            className="input mono"
            placeholder="Add a field by its key, e.g. country"
            aria-label="New field key"
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setKeyErr(null)
            }}
            {...(keyErr ? { "aria-invalid": true, "aria-describedby": "fd-key-err" } : {})}
          />
          <button
            className="btn btn-secondary btn-sm"
            type="submit"
            style={{ border: 0, borderLeft: "1px solid var(--my-border)", borderRadius: 0, height: "auto" }}
          >
            Add
          </button>
        </form>
        {keyErr ? <FieldError id="fd-key-err">{keyErr}</FieldError> : null}
        <span className="hint">
          Drag, or use the arrows, to reorder: the page asks in this order. Up to 30 fields; a choice list
          takes 1 to 50 options. Values are saved to the contact’s fields, which register in Fields.
        </span>
      </div>
    </Section>
  )
}

function TurnstileSection({
  form,
  value,
  error,
  onChange,
}: {
  form: Form
  value: string
  error: string | null
  onChange: (v: string) => void
}) {
  const host = useQuery(meQuery).data?.workspace.host ?? "your mail domain"
  const on = value.trim() !== ""
  return (
    <Section
      id="turnstile"
      title="Bot protection"
      endpoint="GET /v1/forms/:id → turnstile {enabled, siteKey, configured} · PATCH {turnstileSiteKey}"
    >
      <div className="stack stack-16">
        {on && !form.turnstile.configured ? (
          <div className="callout callout-warn" role="status" data-od-id="turnstile-unconfigured">
            <Icon name="warn" />
            <span>
              <b>{TURNSTILE_UNCHECKED}</b> <code className="mono">turnstile.configured</code> is false: the
              deploy has no secret, so visitors see the check and every submission goes through unchecked. The
              hidden honeypot (<code className="mono">_hp</code>) still drops simple bots. Whoever runs this
              deployment sets it with <code className="mono">wrangler secret put TURNSTILE_SECRET</code>; this
              badge turns green on the next load.
            </span>
          </div>
        ) : on && form.turnstile.configured ? (
          <div className="ts-status is-on" data-od-id="turnstile-status">
            <Icon name="shield" />
            <span>
              <b>Verified.</b> This deploy has <code className="mono">TURNSTILE_SECRET</code>, so every
              submission’s token is checked before anything is written; a missing or rejected token is
              refused.
            </span>
          </div>
        ) : null}
        <div className="spread">
          <span className="label">Turnstile on this form</span>
          <span className={`pill ${on ? "pill-pass" : "pill-neutral"}`}>
            <span className="dot" />
            {on ? "Enabled" : "Off"}
          </span>
        </div>
        <TextField
          id="ts-key"
          mono
          label={
            <>
              Site key{" "}
              <span className="opt">
                <code className="mono">turnstileSiteKey</code> · clear it to turn Turnstile off
              </span>
            </>
          }
          value={value}
          placeholder="0x4AAAAAAA…"
          hint={`From Cloudflare → Turnstile: add a widget for ${host} and any site you embed on. Its mode (managed, non-interactive or invisible) is set on that widget.`}
          error={error}
          onChange={onChange}
        />
        {value.trim() !== (form.turnstileSiteKey ?? "") ? (
          <p className="hint">Saved with the form; the hosted page and the snippet pick it up at once.</p>
        ) : null}
      </div>
    </Section>
  )
}

function StatsSection({ id }: { id: string }) {
  const [range, setRange] = useState<Range>("30d")
  const q = useQuery(formStatsQuery(id, range))
  const s = q.data
  const b = s ? bars(s.days) : []
  return (
    <Section
      id="form-stats"
      title="Submissions"
      endpoint={`GET /v1/forms/${id}/stats?range=${range}`}
      meta={
        // biome-ignore lint/a11y/useSemanticElements: the design's .seg switch is a labelled button group
        <div className="seg" role="group" aria-label="Range" data-seg>
          {(["7d", "30d", "90d"] as const).map((r) => (
            <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
      }
    >
      {q.isPending ? (
        <div className="stack stack-8" aria-hidden="true">
          <span className="sk sk-stat" />
          <span className="sk sk-bar" style={{ height: 120 }} />
        </div>
      ) : q.isError ? (
        <PanelError error={q.error} onRetry={() => q.refetch()} what="Submissions didn’t load" />
      ) : s ? (
        <div className="stack stack-12">
          <div className="fstats">
            <div>
              <span className="bs-l">Submissions</span>
              <b>{fmtInt(s.submissions)}</b>
            </div>
            <div>
              <span className="bs-l">
                <i className="sw" style={{ ["--c" as string]: "var(--data-good)" }} />
                Subscribed
              </span>
              <b>{fmtInt(s.subscribed)}</b>
            </div>
            <div>
              <span className="bs-l">
                <i className="sw" style={{ ["--c" as string]: "var(--data-warn)" }} />
                Awaiting confirmation
              </span>
              <b>{fmtInt(s.confirm)}</b>
            </div>
            <div>
              <span className="bs-l">
                <i className="sw" style={{ ["--c" as string]: "var(--data-bad)" }} />
                Refused
              </span>
              <b>{fmtInt(s.refused)}</b>
            </div>
          </div>
          <div className="fbars" data-od-id="form-stats-bars">
            {b.map((x) => (
              <div key={x.day} className="fbar" role="img" aria-label={x.label}>
                <span className="fb-stack" style={{ height: `${x.height}%` }}>
                  <span className="fb-seg is-ref" style={{ flex: x.ref }} />
                  <span className="fb-seg is-conf" style={{ flex: x.conf }} />
                  <span className="fb-seg is-sub" style={{ flex: x.sub }} />
                </span>
              </div>
            ))}
          </div>
          {b.length ? (
            <div className="spread hint">
              <span>{b[0]?.day}</span>
              <span>{b[b.length - 1]?.day}</span>
            </div>
          ) : null}
          {countingSince(s.days) ? (
            <div className="callout callout-info">
              <Icon name="info" />
              <span>
                <b>Counting since {fmtDay(Date.parse(`${STATS_SINCE}T00:00:00Z`), 0)}.</b> Submissions are
                counted from the day this Mailyard started recording form stats, so every earlier day reads 0.
                The bars fill in as people sign up.
              </span>
            </div>
          ) : (
            <p className="hint">
              Refused counts rate-limited tries, failed checks and invalid fields. Awaiting confirmation means
              a double opt-in topic sent its email and they haven’t clicked yet. Days are UTC.
            </p>
          )}
          {num(s.submissions) === 0 && !countingSince(s.days) ? (
            <p className="hint">No submissions in this range.</p>
          ) : null}
        </div>
      ) : null}
    </Section>
  )
}

type Tab = "html" | "iframe" | "link"

function EmbedSection({ id, dirty }: { id: string; dirty: boolean }) {
  const q = useQuery(formEmbedQuery(id))
  const [tab, setTab] = useState<Tab>("html")
  const ids = useId()
  const tabs: { id: Tab; label: string }[] = [
    { id: "html", label: "Script snippet" },
    { id: "iframe", label: "iframe" },
    { id: "link", label: "Link" },
  ]
  const text = q.data
    ? tab === "html"
      ? q.data.html
      : tab === "iframe"
        ? q.data.iframe
        : q.data.pageUrl
    : ""
  return (
    <Section
      id="embed"
      title="Share and embed"
      endpoint={`GET /v1/forms/${id}/embed → { pageUrl, html, iframe }`}
    >
      {q.isPending ? (
        <span className="sk sk-bar" style={{ height: 160 }} aria-hidden="true" />
      ) : q.isError ? (
        <PanelError error={q.error} onRetry={() => q.refetch()} what="The snippets didn’t load" />
      ) : (
        <div className="stack stack-12">
          {dirty ? <p className="hint">The snippets show the saved form; save to update them.</p> : null}
          <div className="codeblock">
            <div
              className="codeblock-tabs"
              role="tablist"
              aria-label="Embed as"
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
                const i = tabs.findIndex((t) => t.id === tab)
                const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]
                if (next) {
                  setTab(next.id)
                  document.getElementById(`${ids}-tab-${next.id}`)?.focus()
                }
              }}
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  id={`${ids}-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-controls={`${ids}-panel`}
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${tab}`}>
              <pre className={tab === "link" ? undefined : "snip-pre"}>{text}</pre>
              <CopyButton value={text} label={`Copy ${tab === "html" ? "snippet" : tab}`} />
            </div>
          </div>
          <ul className="role-list">
            <li>
              <Icon name="code" />
              <span>
                <b>Script snippet:</b> your page’s own form, posted with <code className="mono">fetch</code>{" "}
                so visitors stay; it renders every field and the topic choice. Unstyled: target{" "}
                <code className="mono">.mailyard-form</code>.
              </span>
            </li>
            <li>
              <Icon name="monitor" />
              <span>
                <b>iframe:</b> the hosted page in a frame, with no script on your site; the check, validation
                and result happen inside it. The page allows framing anywhere.
              </span>
            </li>
            <li>
              <Icon name="info" />
              <span>Without JavaScript the snippet posts normally and lands on the hosted result page.</span>
            </li>
          </ul>
        </div>
      )}
    </Section>
  )
}

function Preview({
  d,
  form,
  topics,
  pageUrl,
}: {
  d: FormDraft
  form: Form
  topics: Topic[]
  pageUrl: string | undefined
}) {
  const brand = useQuery(brandQuery)
  const me = useQuery(meQuery).data
  const name = brand.data?.name ?? me?.workspace.name ?? "Your brand"
  const site = brand.data?.siteUrl
  const chosen = d.topicIds.map((id) => topics.find((t) => t.id === id)).filter((t): t is Topic => Boolean(t))
  const turnstileOn = d.turnstileSiteKey.trim() !== ""
  return (
    <section
      className="panel"
      data-endpoint="GET /f/:formId (built, raw route, not in OpenAPI) · GET /v1/settings/brand"
      data-od-id="panel-preview"
      aria-labelledby="h-preview"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-preview">
          Preview
        </h2>
        <div className="cluster">
          <span className="panel-meta">As visitors see it</span>
        </div>
      </header>
      <div className="panel-body">
        <div className="pubframe" data-od-id="form-preview" inert>
          <div className="pf-bar">
            <Icon name="lock" />
            <span>{pageUrl ?? `/f/${form.id}`}</span>
          </div>
          <div className="pf-body">
            <div className="pubcard">
              <span className="pc-brand">
                <span className="pc-mark" aria-hidden="true">
                  {name.slice(0, 1).toUpperCase()}
                </span>
                {name}
              </span>
              <h3>{d.name.trim() || "Untitled form"}</h3>
              {d.description.trim() ? <p className="hint">{d.description.trim()}</p> : null}
              {d.topicChoice === "all" || chosen.length === 0 ? (
                <div className="stack stack-8">
                  <span className="label">You’ll get all of these</span>
                  <ul className="pv-topics">
                    {chosen.map((t) => (
                      <li key={t.id} className="pv-topic">
                        <b>{t.name}</b>
                        {t.description ? <span>{t.description}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <PvField id="pv-email" label="Email" type="email" required />
              <PvField id="pv-name" label="Name" type="text" required={false} />
              {d.fieldDefs.map((f) =>
                f.type === "checkbox" ? (
                  <label key={f.key} className="check pv-check">
                    <input type="checkbox" tabIndex={-1} />
                    <span>
                      {f.label || f.key}
                      {f.required ? null : <span className="opt"> (optional)</span>}
                    </span>
                  </label>
                ) : f.type === "select" ? (
                  <div key={f.key} className="field">
                    <label className="label" htmlFor={`pv-${f.key}`}>
                      {f.label || f.key}
                      {f.required ? null : <span className="opt"> (optional)</span>}
                    </label>
                    <select className="select" id={`pv-${f.key}`} tabIndex={-1}>
                      <option>Choose…</option>
                      {(f.options ?? []).map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <PvField
                    key={f.key}
                    id={`pv-${f.key}`}
                    label={f.label || f.key}
                    type={f.type === "text" ? "text" : f.type}
                    required={f.required}
                  />
                ),
              )}
              {d.topicChoice === "pick" && chosen.length ? (
                <fieldset className="pv-pick">
                  <legend className="label">Choose what you’d like</legend>
                  {chosen.map((t) => (
                    <label key={t.id} className="check pv-check">
                      <input type="checkbox" tabIndex={-1} defaultChecked={chosen.length === 1} />
                      <span>
                        <b>{t.name}</b>
                        {t.description ? <span className="hint">{t.description}</span> : null}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {turnstileOn ? (
                <div className="turnstile" role="img" aria-label="Turnstile check (preview)">
                  <span className="ts-box">
                    <Icon name="check" />
                  </span>
                  Success!
                  <span className="ts-name">
                    Cloudflare
                    <br />
                    Turnstile
                  </span>
                </div>
              ) : null}
              <button className="btn btn-primary btn-block" type="button" tabIndex={-1}>
                Sign up
              </button>
              <p className="hint">
                You can unsubscribe at any time from any email we send.{" "}
                {site ? (
                  <a className="link" href={site} tabIndex={-1}>
                    {name}
                  </a>
                ) : (
                  name
                )}
              </p>
            </div>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          The live page takes your brand’s colours, fonts and logo from Settings → Brand.
          {turnstileOn && !form.turnstile.configured
            ? " Turnstile renders here even though nothing checks it yet."
            : ""}
        </p>
      </div>
    </section>
  )
}

function PvField({
  id,
  label,
  type,
  required,
}: {
  id: string
  label: string
  type: string
  required: boolean
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
        {required ? null : <span className="opt"> (optional)</span>}
      </label>
      <input
        className="input"
        id={id}
        type={type}
        tabIndex={-1}
        {...(type === "number" ? { inputMode: "decimal" as const } : {})}
      />
    </div>
  )
}

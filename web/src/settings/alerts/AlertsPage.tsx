/**
 * Settings → Alerts (design: settings/integrations-alert-channel.html; HAL-3465, live): where alerts go besides
 * the bell. `GET`/`PUT /v1/settings/alerts { channels, defaultEmail }`; each channel is an email address or a
 * webhook endpoint (which gets `alert.raised`), with the kinds it takes (none picked = every kind) and the
 * lowest severity. The answer's `effective` says who gets critical mail when nothing else is set.
 *
 * PUT replaces the list, so the page edits a local copy and one sticky save bar says what's unsaved. A 400
 * `{ field: "channels[i].target" }` lands on that row's target.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type FormEvent, useEffect, useMemo, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { useMe } from "../../auth/session.ts"
import { BuiltPill, Empty } from "../../ops/kit.tsx"
import { isAdmin } from "../../ops/roles.ts"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton, RequestId } from "../../ui/Panel.tsx"
import { SectionHead } from "../integrations/common.tsx"
import { type Body, webhooksQuery } from "../integrations/queries.ts"
import { SaveBar } from "../ui.tsx"
import {
  ALERT_KINDS,
  type AlertKind,
  EMAIL,
  fieldTarget,
  kindsLabel,
  newRow,
  type Row,
  rowProblems,
  SEVERITIES,
  type Severity,
  toBody,
  toRows,
  unsavedLine,
} from "./logic.ts"
import "../integrations/integrations.css"
import "./alerts.css"

export type AlertSettings = Body<"/v1/settings/alerts">

export const alertSettingsQuery = {
  queryKey: ["settings", "alerts"],
  queryFn: () => unwrap(api.GET("/v1/settings/alerts")),
}

/** Owners and admins, or anyone whose permissions carry settings.write. */
export function useCanWriteSettings() {
  const me = useMe().data
  return isAdmin(me) || Boolean(me?.permissions.includes("settings.write"))
}

export function AlertsPage() {
  const q = useQuery(alertSettingsQuery)
  return (
    <>
      <SectionHead
        title="Alerts"
        sub="Where alerts go besides the bell, so someone hears when nobody has Mailyard open."
        actions={<BuiltPill issue="HAL-3465" />}
      />
      {q.isPending ? (
        <section className="panel">
          <div className="panel-body">
            <PanelSkeleton rows={5} />
          </div>
        </section>
      ) : q.isError ? (
        <section className="panel is-error" data-endpoint="GET /v1/settings/alerts">
          <div className="panel-body">
            <PanelError error={q.error} onRetry={() => q.refetch()} what="Alert settings didn’t load" />
          </div>
        </section>
      ) : (
        <Editor saved={q.data} />
      )}
    </>
  )
}

function Editor({ saved }: { saved: AlertSettings }) {
  const qc = useQueryClient()
  const canWrite = useCanWriteSettings()
  const hooks = useQuery(webhooksQuery)
  const [rows, setRows] = useState<Row[]>(() => toRows(saved.channels))
  const [defaultEmail, setDefaultEmail] = useState(saved.defaultEmail ?? "")
  const [tried, setTried] = useState(false)
  /** The API's refusal, by row index (or the default address), until that field is edited. */
  const [refused, setRefused] = useState<{
    rows: Map<number, string>
    defaultEmail: string | null
    other: ApiError | null
  }>({
    rows: new Map(),
    defaultEmail: null,
    other: null,
  })
  // A save (or another tab's) brings new server state: start from it.
  useEffect(() => {
    setRows(toRows(saved.channels))
    setDefaultEmail(saved.defaultEmail ?? "")
  }, [saved])

  const save = useMutation({
    mutationFn: () => unwrap(api.PUT("/v1/settings/alerts", { body: toBody(rows, defaultEmail) })),
    onSuccess: (r) => {
      qc.setQueryData(alertSettingsQuery.queryKey, r)
      setTried(false)
      setRefused({ rows: new Map(), defaultEmail: null, other: null })
      toast({
        title: "Alert channels saved",
        sub: r.channels.length
          ? `${r.channels.length} channel${r.channels.length === 1 ? "" : "s"}`
          : (r.effective.note ?? undefined),
      })
    },
    onError: (e) => {
      const at = e instanceof ApiError && e.status === 400 ? fieldTarget(e.body.field) : null
      if (at && "row" in at)
        setRefused({ rows: new Map([[at.row, e.message]]), defaultEmail: null, other: null })
      else if (at) setRefused({ rows: new Map(), defaultEmail: e.message, other: null })
      else setRefused({ rows: new Map(), defaultEmail: null, other: e instanceof ApiError ? e : null })
    },
  })

  const local = rowProblems(rows)
  const defaultBad =
    defaultEmail.trim() && !EMAIL.test(defaultEmail.trim())
      ? `${defaultEmail.trim()} isn’t an email address.`
      : null
  const line = unsavedLine(saved, rows, defaultEmail)
  const update = (i: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    if (refused.rows.has(i)) {
      const next = new Map(refused.rows)
      next.delete(i)
      setRefused({ ...refused, rows: next })
    }
  }
  const remove = (i: number) => {
    setRows((rs) => rs.filter((_, j) => j !== i))
    // Row indexes after the removed one shift down; a refusal pointed at the old list.
    setRefused({ rows: new Map(), defaultEmail: refused.defaultEmail, other: null })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!canWrite || !line || save.isPending || local.size || defaultBad) return
    save.mutate()
  }
  const endpoints = hooks.data?.webhooks ?? []

  return (
    <form
      className="stack"
      onSubmit={submit}
      noValidate
      data-endpoint="GET /v1/settings/alerts · PUT /v1/settings/alerts (built, HAL-3465)"
    >
      <section className="panel" aria-labelledby="h-critical">
        <header className="panel-head">
          <h2 className="panel-title" id="h-critical">
            Who hears about critical alerts
          </h2>
        </header>
        <div className="panel-body">
          <div className="stack stack-12">
            <div className="callout callout-info" role="status">
              <Icon name="info" />
              <span>
                {saved.effective.criticalEmail ? (
                  <>
                    Critical alerts go to <span className="mono">{saved.effective.criticalEmail}</span>
                    {saved.channels.length ? " as well as the channels below." : "."}
                  </>
                ) : (
                  <>No address gets critical alerts by email yet.</>
                )}
                {!saved.channels.length && saved.effective.note ? <> {saved.effective.note}</> : null}
              </span>
            </div>
            <div
              className={`field${defaultBad && tried ? " is-invalid" : refused.defaultEmail ? " is-invalid" : ""}`}
            >
              <label className="label" htmlFor="al-default">
                Default address <span className="opt">· optional</span>
              </label>
              <input
                className="input mono"
                id="al-default"
                type="email"
                inputMode="email"
                value={defaultEmail}
                placeholder="ops@yourdomain.com"
                aria-invalid={(defaultBad && tried) || refused.defaultEmail ? true : undefined}
                aria-describedby="al-default-hint"
                onChange={(e) => {
                  setDefaultEmail(e.target.value)
                  if (refused.defaultEmail) setRefused({ ...refused, defaultEmail: null })
                }}
              />
              <span
                className={(defaultBad && tried) || refused.defaultEmail ? "field-error" : "hint"}
                id="al-default-hint"
              >
                {refused.defaultEmail ??
                  (defaultBad && tried
                    ? defaultBad
                    : "Where critical alerts go when no channel takes them. Empty uses the workspace owner’s address.")}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="h-channels">
        <header className="panel-head">
          <h2 className="panel-title" id="h-channels">
            Channels
          </h2>
          <div className="cluster">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => setRows((rs) => [...rs, newRow("email")])}
            >
              <Icon name="plus" />
              Add email
            </button>
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => setRows((rs) => [...rs, newRow("webhook")])}
            >
              <Icon name="plus" />
              Add webhook
            </button>
          </div>
        </header>
        <div className="panel-body">
          {rows.length === 0 ? (
            <Empty icon="bell" title="Alerts show only in the app">
              {saved.effective.note ??
                "Add an email address or a webhook to hear about alerts when nobody has Mailyard open."}
            </Empty>
          ) : (
            <ol className="al-rows">
              {rows.map((r, i) => (
                <ChannelRow
                  key={r.key}
                  row={r}
                  index={i}
                  endpoints={endpoints}
                  hooksLoading={hooks.isPending}
                  error={refused.rows.get(i) ?? (tried ? local.get(i) : undefined)}
                  onChange={(p) => update(i, p)}
                  onRemove={() => remove(i)}
                />
              ))}
            </ol>
          )}
          <p className="hint" style={{ marginTop: 12 }}>
            Each alert is sent once, and again if it gets worse (warning to critical). Email comes from
            Mailyard’s own address, not one of your sending domains, so it arrives even if a domain is the
            problem. A webhook gets <span className="mono">alert.raised</span> whatever events it subscribes
            to.{" "}
            <Link className="link" to="/transactional/webhooks">
              Manage webhooks
            </Link>
          </p>
          {refused.other ? (
            <div className="callout callout-error" role="alert" style={{ marginTop: 12 }}>
              <Icon name="warn" />
              <span>
                <b>The channels weren’t saved.</b> {refused.other.message}
                {refused.other.requestId ? (
                  <>
                    {" "}
                    <RequestId id={refused.other.requestId} />
                  </>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <SaveBar
        line={
          refused.rows.size || refused.defaultEmail
            ? "The API refused a field; it’s marked above."
            : tried && (local.size || defaultBad)
              ? "Fix the marked fields to save."
              : (line ?? "Nothing to save.")
        }
        tone={
          refused.rows.size || refused.defaultEmail || (tried && (local.size || defaultBad))
            ? "error"
            : "muted"
        }
      >
        {line ? (
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              setRows(toRows(saved.channels))
              setDefaultEmail(saved.defaultEmail ?? "")
              setTried(false)
              setRefused({ rows: new Map(), defaultEmail: null, other: null })
            }}
          >
            Discard
          </button>
        ) : null}
        <Gated
          allowed={canWrite}
          reason="You can’t change alert channels"
          who="Owners and admins, or a key with the admin scope (settings.write), can."
          side="up"
        >
          <button className="btn btn-primary" type="submit" aria-disabled={!line || save.isPending}>
            {save.isPending ? "Saving…" : "Save channels"}
          </button>
        </Gated>
      </SaveBar>
    </form>
  )
}

type Endpoint = Body<"/v1/webhooks">["webhooks"][number]

function ChannelRow({
  row,
  index,
  endpoints,
  hooksLoading,
  error,
  onChange,
  onRemove,
}: {
  row: Row
  index: number
  endpoints: readonly Endpoint[]
  hooksLoading: boolean
  error: string | undefined
  onChange: (p: Partial<Row>) => void
  onRemove: () => void
}) {
  const id = `al-${row.key}`
  const known = row.kind !== "webhook" || !row.target || endpoints.some((e) => e.id === row.target)
  const chosen = endpoints.find((e) => e.id === row.target)
  const toggle = (k: AlertKind, on: boolean) =>
    onChange({ kinds: on ? [...row.kinds, k] : row.kinds.filter((x) => x !== k) })
  const label = useMemo(() => kindsLabel(row.kinds), [row.kinds])
  return (
    <li className="al-row" data-od-id={`alert-channel-${index}`}>
      <div className="al-row-head">
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Channel {index + 1}
          </legend>
          {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control inside a fieldset */}
          <div className="seg" role="group" aria-label={`Channel ${index + 1} kind`}>
            {(["email", "webhook"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={row.kind === k}
                onClick={() => row.kind !== k && onChange({ kind: k, target: "" })}
              >
                <Icon name={k === "email" ? "envelope" : "webhook"} />
                {k === "email" ? "Email" : "Webhook"}
              </button>
            ))}
          </div>
        </fieldset>
        <button
          className="btn btn-danger-ghost btn-sm"
          type="button"
          onClick={onRemove}
          aria-label={`Remove channel ${index + 1}`}
        >
          <Icon name="trash" />
          Remove
        </button>
      </div>
      <div className="field-row">
        <div className={`field${error ? " is-invalid" : ""}`}>
          <label className="label" htmlFor={`${id}-target`}>
            {row.kind === "email" ? "Email address" : "Webhook endpoint"}
          </label>
          {row.kind === "email" ? (
            <input
              className="input mono"
              id={`${id}-target`}
              type="email"
              inputMode="email"
              value={row.target}
              placeholder="founders@yourdomain.com"
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-target-hint`}
              onChange={(e) => onChange({ target: e.target.value })}
            />
          ) : (
            <select
              className="select"
              id={`${id}-target`}
              value={row.target}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-target-hint`}
              onChange={(e) => onChange({ target: e.target.value })}
            >
              <option value="">
                {hooksLoading
                  ? "Loading endpoints…"
                  : endpoints.length
                    ? "Choose an endpoint"
                    : "No endpoints yet"}
              </option>
              {known ? null : <option value={row.target}>{row.target} (not found)</option>}
              {endpoints.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.description ? `${e.description} · ${e.url}` : e.url}
                </option>
              ))}
            </select>
          )}
          <span className={error ? "field-error" : "hint"} id={`${id}-target-hint`}>
            {error ??
              (row.kind === "email" ? (
                "A short message from Mailyard’s own address."
              ) : chosen ? (
                <>
                  <span className="mono">{chosen.id}</span> gets <span className="mono">alert.raised</span>
                  {chosen.enabled ? "" : " (it’s disabled now, so nothing arrives)"}.
                </>
              ) : (
                "Gets the alert.raised event with the alert’s kind, severity and title."
              ))}
          </span>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-sev`}>
            Lowest severity
          </label>
          <select
            className="select"
            id={`${id}-sev`}
            value={row.minSeverity}
            onChange={(e) => onChange({ minSeverity: e.target.value as Severity })}
          >
            {SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <details className="tools-more al-kinds">
        <summary>
          Which alerts <span className="opt">· {label}</span>
        </summary>
        <label className={`pick${row.kinds.length === 0 ? " is-on" : ""}`} style={{ margin: "8px 0" }}>
          <input
            type="checkbox"
            style={{ width: 16, height: 16 }}
            checked={row.kinds.length === 0}
            onChange={(e) => e.target.checked && onChange({ kinds: [] })}
          />
          <span className="p-name">
            Every kind <code className="tag">*</code>
          </span>
          <span className="p-sub">Including kinds added later</span>
        </label>
        <div className="pick-grid al-kind-grid">
          {ALERT_KINDS.map((k) => {
            const on = row.kinds.includes(k)
            return (
              <label key={k} className={`pick${on ? " is-on" : ""}`}>
                <input
                  type="checkbox"
                  style={{ width: 16, height: 16 }}
                  checked={on}
                  onChange={(e) => toggle(k, e.target.checked)}
                />
                <span className="p-name mono">{k}</span>
              </label>
            )
          })}
        </div>
      </details>
    </li>
  )
}

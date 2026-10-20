/**
 * The builder's side panels, all in the inspector frame (HANDOFF §4 "Inspector": "the same frame holds the node
 * inspector, the dry run and the versions list"): the dry run (A8.3), versions and restore (A8.5), the issues
 * a publish was refused for (A8.4, 409 NotReady), the automation's settings, and the publish sheet.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../api/client.ts"
import { fmtDay } from "../audience/kit/format.ts"
import { allTopicsQuery, identitiesQuery, useKeyName } from "../audience/kit/queries.ts"
import { ApiErrorCallout, Sheet, StatusPill } from "../audience/kit/ui.tsx"
import { Gated } from "../auth/NoPermission.tsx"
import { fmtAgo, fmtInt, num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import {
  type Automation,
  type DryRun,
  describeNode,
  type GNode,
  type Issue,
  type Names,
  notReadyIssues,
  type Settings,
} from "./logic.ts"
import { contactPickQuery, versionsQuery } from "./queries.ts"
import { DryRunLog } from "./StepLog.tsx"

function Frame({
  icon,
  kind,
  title,
  sub,
  odId,
  endpoint,
  onClose,
  children,
  foot,
}: {
  icon: Parameters<typeof Icon>[0]["name"]
  kind: string
  title: ReactNode
  sub?: ReactNode
  odId: string
  endpoint: string
  onClose: () => void
  children: ReactNode
  foot?: ReactNode
}) {
  const id = useId()
  return (
    <aside className="inspector" aria-labelledby={id} data-od-id={odId} data-endpoint={endpoint}>
      <div className="ins-head">
        <span className="node-ic">
          <Icon name={icon} />
        </span>
        <div className="grow">
          <span className="node-kind">{kind}</span>
          <h2 className="t-h3" id={id}>
            {title}
          </h2>
          {sub ? <span className="kind mono">{sub}</span> : null}
        </div>
        <button className="icon-btn ins-close" type="button" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="ins-body">{children}</div>
      {foot ? <div className="ins-foot">{foot}</div> : null}
    </aside>
  )
}

// ---------------------------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------------------------

type Assume = "yes" | "no" | "happens" | "times-out"

export function DryRunPanel({
  a,
  names,
  dirty,
  onResult,
  onClose,
}: {
  a: Automation
  names: Names
  /** The draft has unsaved changes: a dry run of "draft" reads the saved one. */
  dirty: boolean
  onResult: (r: DryRun | null) => void
  onClose: () => void
}) {
  const ids = useId()
  const [q, setQ] = useState("")
  const contacts = useQuery(contactPickQuery(q))
  const versions = useQuery(versionsQuery(a.id))
  const [contactId, setContactId] = useState<string | "made-up" | null>(null)
  const [madeUp, setMadeUp] = useState({ email: "test@example.com", name: "" })
  const [version, setVersion] = useState<"draft" | number>("draft")
  const [assume, setAssume] = useState<Record<string, Assume | "">>({})
  const [triggerData, setTriggerData] = useState("")
  const [tdError, setTdError] = useState<string | null>(null)
  const run_last = useRef<string | null>(null)
  const waits = a.graph.nodes.filter((n) => n.type === "wait_event")
  const branches = a.graph.nodes.filter((n) => n.type === "branch")
  const list = contacts.data ?? []
  const lastRun = run_last.current
  const chosen =
    contactId ?? (lastRun && list.some((c) => c.id === lastRun) ? lastRun : null) ?? list[0]?.id ?? null

  const run = useMutation({
    mutationFn: () => {
      let td: Record<string, never> | undefined
      if (triggerData.trim()) td = JSON.parse(triggerData) as Record<string, never>
      const assumeBody = Object.fromEntries(Object.entries(assume).filter(([, v]) => v)) as Record<
        string,
        Assume
      >
      return unwrap(
        api.POST("/v1/automations/{id}/dry-run", {
          params: { path: { id: a.id } },
          body: {
            ...(chosen === "made-up"
              ? { contact: { email: madeUp.email, ...(madeUp.name ? { name: madeUp.name } : {}) } }
              : chosen
                ? { contactId: chosen }
                : {}),
            version,
            ...(Object.keys(assumeBody).length ? { assume: assumeBody } : {}),
            ...(td ? { triggerData: td } : {}),
          },
        }),
      )
    },
    onSuccess: (r) => {
      if (r && "path" in r) run_last.current = r.contact.id
      onResult(r && "path" in r ? r : null)
    },
    onError: () => onResult(null),
  })
  // The panel opens on a result, as the design does: the first contact, assuming waits time out.
  const started = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the first contact arrives
  useEffect(() => {
    if (started.current || !list.length) return
    started.current = true
    const init: Record<string, Assume> = {}
    for (const w of waits) init[w.id] = "times-out"
    setAssume(init)
    queueMicrotask(() => run.mutate())
  }, [list.length])

  const r = run.data && "path" in run.data ? run.data : null
  const person = r ? (list.find((c) => c.id === r.contact.id)?.name ?? r.contact.email) : null
  const first = person?.split(/\s+/)[0] ?? "this contact"
  const skipped = r?.path.filter((s) => s.outcome === "skipped") ?? []
  const versionLabel = version === "draft" ? `v${num(a.version) ?? ""} draft` : `v${version}`
  return (
    <Frame
      icon="play"
      kind={`Dry run · ${versionLabel}`}
      title={r ? `${person}’s path` : "Dry run"}
      sub={r?.contact.email}
      odId="dry-run"
      endpoint={`POST /v1/automations/${a.id}/dry-run {contactId, version, assume}`}
      onClose={onClose}
      foot={
        <>
          <span className="hint">
            {r
              ? `${r.path.length} steps · ${fmtInt(r.sends)} send${num(r.sends) === 1 ? "" : "s"} · ends by ${r.endedBy}`
              : "Nothing is sent and nobody is enrolled."}
          </span>
          <button
            className={`btn btn-secondary btn-sm${run.isPending ? " is-loading" : ""}`}
            type="button"
            onClick={() => {
              if (tdError) return
              run.mutate()
            }}
          >
            <Icon name="replay" />
            {r ? "Run again" : "Run"}
          </button>
        </>
      }
    >
      {dirty ? (
        <div className="callout callout-warn">
          <Icon name="warn" />
          <span>A dry run of the draft reads the saved draft. Save your changes to include them.</span>
        </div>
      ) : null}
      <div className="field">
        <label className="label" htmlFor={`${ids}-c`}>
          Test with
        </label>
        <input
          className="input"
          type="search"
          placeholder="Search contacts by email or name"
          aria-label="Search contacts"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="select"
          id={`${ids}-c`}
          value={chosen ?? ""}
          onChange={(e) => setContactId(e.target.value)}
        >
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ? `${c.name} · ${c.email}` : c.email}
            </option>
          ))}
          <option value="made-up">A made-up contact…</option>
        </select>
        {chosen === "made-up" ? (
          <div className="fgrid">
            <input
              className="input mono"
              aria-label="Made-up email"
              value={madeUp.email}
              onChange={(e) => setMadeUp({ ...madeUp, email: e.target.value })}
            />
            <input
              className="input"
              aria-label="Made-up name"
              placeholder="Name (optional)"
              value={madeUp.name}
              onChange={(e) => setMadeUp({ ...madeUp, name: e.target.value })}
            />
          </div>
        ) : null}
      </div>
      {waits.map((w) => (
        <div key={w.id} className="field">
          <label className="label" htmlFor={`${ids}-${w.id}`}>
            When it waits for {w.type === "wait_event" ? w.config.event : w.id}
          </label>
          <select
            className="select"
            id={`${ids}-${w.id}`}
            value={assume[w.id] ?? ""}
            onChange={(e) => setAssume({ ...assume, [w.id]: e.target.value as Assume | "" })}
          >
            <option value="times-out">Assume it times out</option>
            <option value="happens">Assume it happens</option>
            <option value="">Use events tracked in the dry run</option>
          </select>
          {assume[w.id] ? (
            <span className="hint">
              Sent as <span className="mono">{`assume: {"${w.id}": "${assume[w.id]}"}`}</span>.
            </span>
          ) : null}
        </div>
      ))}
      <details className="raw">
        <summary>
          More options: version{branches.length ? ", branches" : ""}
          {a.trigger?.kind === "event" ? ", event data" : ""}
        </summary>
        <div className="stack stack-12" style={{ paddingBottom: 12 }}>
          <div className="field">
            <label className="label" htmlFor={`${ids}-v`}>
              Version
            </label>
            <select
              className="select"
              id={`${ids}-v`}
              value={String(version)}
              onChange={(e) => setVersion(e.target.value === "draft" ? "draft" : Number(e.target.value))}
            >
              <option value="draft">Draft v{num(a.version)}</option>
              {(versions.data?.versions ?? []).map((v) => (
                <option key={String(v.version)} value={String(v.version)}>
                  v{num(v.version)} · {v.status}
                </option>
              ))}
            </select>
          </div>
          {branches.map((b) => (
            <div key={b.id} className="field">
              <label className="label" htmlFor={`${ids}-${b.id}`}>
                At “{describeNode(b, names).title}”
              </label>
              <select
                className="select"
                id={`${ids}-${b.id}`}
                value={assume[b.id] ?? ""}
                onChange={(e) => setAssume({ ...assume, [b.id]: e.target.value as Assume | "" })}
              >
                <option value="">Use the contact as they are now</option>
                <option value="yes">Assume yes</option>
                <option value="no">Assume no</option>
              </select>
            </div>
          ))}
          {a.trigger?.kind === "event" ? (
            <div className="field">
              <label className="label" htmlFor={`${ids}-td`}>
                Event data <span className="opt">JSON, optional · trigger.*</span>
              </label>
              <textarea
                className="textarea mono"
                id={`${ids}-td`}
                rows={3}
                style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                placeholder='{"plan": "free"}'
                value={triggerData}
                onChange={(e) => {
                  setTriggerData(e.target.value)
                  try {
                    if (e.target.value.trim()) {
                      const v = JSON.parse(e.target.value)
                      if (!v || typeof v !== "object" || Array.isArray(v))
                        throw new Error("Event data is a JSON object.")
                    }
                    setTdError(null)
                  } catch (err) {
                    setTdError(err instanceof Error ? err.message : "That isn’t JSON.")
                  }
                }}
                {...(tdError ? { "aria-invalid": true } : {})}
              />
              {tdError ? (
                <p className="field-error">
                  <Icon name="x-circle" />
                  <span>{tdError}</span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>
      {run.isPending && !r ? (
        <div className="stack stack-8" aria-hidden="true">
          <span className="sk sk-text" />
          <span className="sk sk-text" />
          <span className="sk sk-text" />
        </div>
      ) : null}
      {run.isError ? <ApiErrorCallout error={run.error} what="The dry run didn’t run." /> : null}
      {r ? (
        <>
          <DryRunLog path={r.path} graph={a.graph.nodes} names={names} contactId={r.contact.id} who={first} />
          {skipped.length ? (
            <div className="callout callout-warn">
              <Icon name="warn" />
              <span>
                <b>
                  {skipped.length} send{skipped.length === 1 ? " would be" : "s would be"} skipped.
                </b>{" "}
                {first} is missing a field the template{skipped.length === 1 ? "" : "s"} require. The run
                still goes on. Add the field, or give the template a fallback with{" "}
                <span className="mono">??</span>.
              </span>
            </div>
          ) : (
            <div className="callout callout-info">
              <Icon name="info" />
              <span>
                Nothing was sent and {first} wasn’t enrolled. Dry runs read the contact as they are now; the
                webhook isn’t called.
              </span>
            </div>
          )}
        </>
      ) : null}
    </Frame>
  )
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

export function VersionsPanel({
  a,
  canWrite,
  reason,
  who,
  onRestored,
  onClose,
}: {
  a: Automation
  canWrite: boolean
  reason: string
  who: string
  onRestored: (a: Automation) => void
  onClose: () => void
}) {
  const q = useQuery(versionsQuery(a.id))
  const keyName = useKeyName()
  const qc = useQueryClient()
  const restore = useMutation({
    mutationFn: (v: number) =>
      unwrap(
        api.POST("/v1/automations/{id}/versions/{version}/restore", {
          params: { path: { id: a.id, version: String(v) } },
        }),
      ),
    onSuccess: (res) => {
      if (res && "graph" in res) onRestored(res as Automation)
      qc.invalidateQueries({ queryKey: ["automations", a.id] })
    },
  })
  const d = q.data
  const old = (d?.versions ?? []).filter((v) => v.status === "finishing" && (num(v.activeRuns) ?? 0) > 0)
  const live = d?.versions.find((v) => v.status === "live")
  const draftNew =
    d && (num(d.draft.version) ?? 0) > Math.max(0, ...d.versions.map((v) => num(v.version) ?? 0))
  return (
    <Frame
      icon="history"
      kind="Versions"
      title={a.name}
      odId="versions"
      endpoint={`GET /v1/automations/${a.id}/versions`}
      onClose={onClose}
    >
      {q.isPending ? (
        <div className="stack stack-8" aria-hidden="true">
          <span className="sk sk-text" />
          <span className="sk sk-text" />
        </div>
      ) : q.isError ? (
        <ApiErrorCallout error={q.error} what="Versions didn’t load." />
      ) : d ? (
        <>
          {old.map((v) => (
            <div key={String(v.version)} className="callout callout-warn" role="status">
              <Icon name="warn" />
              <span>
                <b>
                  {fmtInt(v.activeRuns)} contact{num(v.activeRuns) === 1 ? " is" : "s are"} still on v
                  {num(v.version)}.
                </b>{" "}
                They finish on v{num(v.version)}, the version they entered
                {live ? `, so they won’t get v${num(live.version)}’s changes` : ""}. v{num(v.version)} retires
                itself when the last one exits.
              </span>
            </div>
          ))}
          <ul className="vlist">
            {draftNew ? (
              <li className="vrow">
                <span className="v-n">v{num(d.draft.version)}</span>
                <span className="v-main">
                  <span className="v-title">
                    Unpublished draft <StatusPill status="draft" />
                  </span>
                  <span className="v-sub">
                    {d.draft.updatedAt ? `Edited ${fmtAgo(d.draft.updatedAt)}` : "Not edited yet"}
                    {d.draft.updatedBy ? ` with ${keyName(d.draft.updatedBy)}` : ""}
                  </span>
                </span>
              </li>
            ) : null}
            {d.versions.map((v) => {
              const n = num(v.version) ?? 0
              const active = num(v.activeRuns) ?? 0
              return (
                <li key={n} className={`vrow${v.status === "live" ? " is-live" : ""}`}>
                  <span className="v-n">v{n}</span>
                  <span className="v-main">
                    <span className="v-title">
                      {v.note ?? "No note"} <StatusPill status={v.status} />
                    </span>
                    <span className="v-sub">
                      Published {fmtDay(v.publishedAt)} with {keyName(v.publishedBy)}
                    </span>
                  </span>
                  {active > 0 ? (
                    <Link
                      className="btn btn-ghost btn-sm"
                      to="/automations/$automationId/runs"
                      params={{ automationId: a.id }}
                      search={{ version: String(n) }}
                    >
                      {fmtInt(active)} run{active === 1 ? "" : "s"}
                    </Link>
                  ) : (
                    <Gated allowed={canWrite} reason={reason} who={who} side="right">
                      <button
                        className={`btn btn-ghost btn-sm${restore.isPending && restore.variables === n ? " is-loading" : ""}`}
                        type="button"
                        data-endpoint={`POST /v1/automations/${a.id}/versions/${n}/restore`}
                        onClick={() => restore.mutate(n)}
                      >
                        Restore
                      </button>
                    </Gated>
                  )}
                </li>
              )
            })}
          </ul>
          {restore.isError ? (
            <ApiErrorCallout error={restore.error} what="The version wasn’t restored." />
          ) : null}
          {restore.isSuccess ? (
            <div className="callout callout-ok" role="status">
              <Icon name="check-circle" />
              <span>v{restore.variables} is in the draft now. Publish it to make it live.</span>
            </div>
          ) : null}
          <p className="hint">
            Publishing makes a new version. Running contacts always finish on the version they started;
            nothing is migrated mid-run. Restore copies an old version into the draft.
          </p>
        </>
      ) : null}
    </Frame>
  )
}

// ---------------------------------------------------------------------------------------------
// Issues (409 NotReady)
// ---------------------------------------------------------------------------------------------

export function IssuesPanel({
  a,
  issues,
  refusal,
  names,
  onGoto,
  onClose,
}: {
  a: Automation
  issues: Issue[]
  /** The publish refusal's raw body, when this list came from a 409. */
  refusal: unknown
  names: Names
  onGoto: (nodeId: string) => void
  onClose: () => void
}) {
  return (
    <Frame
      icon="warn"
      kind="Can’t publish yet"
      title={
        issues.length ? `${issues.length} thing${issues.length === 1 ? "" : "s"} to fix` : "Nothing to fix"
      }
      sub={`${a.id} · draft v${num(a.version)}`}
      odId="issues-panel"
      endpoint={`POST /v1/automations/${a.id}/publish → 409 NotReady {message, issues[{nodeId, code, message}]}`}
      onClose={onClose}
    >
      <IssueList a={a} issues={issues} refusal={refusal} names={names} onGoto={onGoto} />
      <p className="hint">
        The same list comes back on every <span className="mono">GET</span> as{" "}
        <span className="mono">issues</span>, so it’s here before you press Publish.
      </p>
    </Frame>
  )
}

export function IssueList({
  a,
  issues,
  refusal,
  names,
  onGoto,
}: {
  a: Automation
  issues: Issue[]
  refusal: unknown
  names: Names
  onGoto?: (nodeId: string) => void
}) {
  const byId = new Map(a.graph.nodes.map((n) => [n.id, n]))
  const msg =
    refusal && typeof refusal === "object" && "message" in refusal
      ? String((refusal as { message: unknown }).message)
      : null
  return (
    <div className="stack stack-12">
      {msg ? (
        <div className="callout callout-error" role="alert" data-od-id="publish-409">
          <Icon name="x-circle" />
          <span>
            <b>Publish was refused.</b> <span className="mono">POST /v1/automations/{a.id}/publish</span>{" "}
            answered <b>409 NotReady</b>: {msg} Nothing went live.
          </span>
        </div>
      ) : null}
      {issues.length === 0 ? (
        <div className="callout callout-ok">
          <Icon name="check-circle" />
          <span>No issues: publishing won’t be refused.</span>
        </div>
      ) : (
        <ol className="issue-list">
          {issues.map((i) => {
            const n = i.nodeId ? byId.get(i.nodeId) : undefined
            return (
              <li key={`${i.nodeId}-${i.code}-${i.message}`} className="issue-row">
                <span className="issue-code mono">{i.code}</span>
                <span className="issue-msg">{i.message}</span>
                {i.nodeId ? (
                  <span className="issue-node">
                    <span className="mono">{i.nodeId}</span>
                    {n ? ` · ${describeNode(n, names).title}` : ""}
                  </span>
                ) : null}
                {i.nodeId && onGoto ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    data-goto-node={i.nodeId}
                    data-od-id={`goto-${i.nodeId}`}
                    onClick={() => onGoto(i.nodeId as string)}
                  >
                    Go to step
                    <Icon name="chevron-right" />
                  </button>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
      {refusal ? (
        <details className="raw">
          <summary>The 409 response</summary>
          <div className="codeblock">
            <pre>{JSON.stringify(refusal, null, 2)}</pre>
          </div>
        </details>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export function SettingsPanel({
  name,
  settings,
  editable,
  onName,
  onChange,
  onClose,
}: {
  name: string
  settings: Settings
  editable: boolean
  onName: (n: string) => void
  onChange: (s: Settings) => void
  onClose: () => void
}) {
  const id = useId()
  const identities = useQuery(identitiesQuery).data ?? []
  const topics = (useQuery(allTopicsQuery).data ?? []).filter((t) => !t.archived)
  const [stops, setStops] = useState(settings.stopEvents.join(", "))
  return (
    <Frame
      icon="settings"
      kind="Automation"
      title="Settings"
      odId="settings"
      endpoint="PATCH /v1/automations/{id} {name, settings}"
      onClose={onClose}
    >
      <div className="field">
        <label className="label" htmlFor={`${id}-n`}>
          Name
        </label>
        <input
          className="input"
          id={`${id}-n`}
          value={name}
          maxLength={100}
          readOnly={!editable}
          onChange={(e) => onName(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-f`}>
          From
        </label>
        <select
          className="select mono"
          id={`${id}-f`}
          value={settings.fromAddress ?? ""}
          disabled={!editable}
          onChange={(e) => onChange({ ...settings, fromAddress: e.target.value || null })}
        >
          <option value="">Not set</option>
          {settings.fromAddress && !identities.some((i) => settings.fromAddress?.includes(i.address)) ? (
            <option value={settings.fromAddress}>{settings.fromAddress}</option>
          ) : null}
          {identities.map((i) => {
            const v = i.displayName ? `${i.displayName} <${i.address}>` : i.address
            return (
              <option key={i.address} value={v}>
                {v}
              </option>
            )
          })}
        </select>
        <span className="hint">Who the mail comes from, unless a send step says otherwise.</span>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-t`}>
          Unsubscribe topic
        </label>
        <select
          className="select"
          id={`${id}-t`}
          value={settings.topicId ?? ""}
          disabled={!editable}
          onChange={(e) => onChange({ ...settings, topicId: e.target.value || null })}
        >
          <option value="">Not set</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="hint">The topic whose unsubscribe link sends carry.</span>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }} disabled={!editable}>
        <legend className="label">Can a contact go through again?</legend>
        <label className="check">
          <input
            type="radio"
            name={`${id}-re`}
            checked={settings.reentry.mode === "never"}
            onChange={() => onChange({ ...settings, reentry: { mode: "never" } })}
          />
          <span>Never</span>
        </label>
        <label className="check">
          <input
            type="radio"
            name={`${id}-re`}
            checked={settings.reentry.mode === "after"}
            onChange={() => onChange({ ...settings, reentry: { mode: "after", days: 30 } })}
          />
          <span>
            Once{" "}
            <input
              className="input input-num"
              type="number"
              min={1}
              max={3650}
              aria-label="Days before re-entry"
              style={{ width: 90, display: "inline-block" }}
              value={settings.reentry.mode === "after" ? settings.reentry.days : 30}
              onChange={(e) =>
                onChange({
                  ...settings,
                  reentry: {
                    mode: "after",
                    days: Math.max(1, Math.min(3650, Math.round(Number(e.target.value) || 1))),
                  },
                })
              }
            />{" "}
            days have passed since they entered
          </span>
        </label>
      </fieldset>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={settings.cadence !== null}
            disabled={!editable}
            onChange={(e) =>
              onChange({ ...settings, cadence: e.target.checked ? { max: 3, days: 7 } : null })
            }
          />
          <span>Cap automation mail to one contact</span>
        </label>
        {settings.cadence ? (
          <div className="fgrid">
            <input
              className="input input-num"
              type="number"
              min={1}
              max={100}
              aria-label="At most this many sends"
              readOnly={!editable}
              value={settings.cadence.max}
              onChange={(e) =>
                onChange({
                  ...settings,
                  cadence: {
                    max: Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1))),
                    days: settings.cadence?.days ?? 7,
                  },
                })
              }
            />
            <input
              className="input input-num"
              type="number"
              min={1}
              max={3650}
              aria-label="In this many days"
              readOnly={!editable}
              value={settings.cadence.days}
              onChange={(e) =>
                onChange({
                  ...settings,
                  cadence: {
                    max: settings.cadence?.max ?? 3,
                    days: Math.max(1, Math.min(3650, Math.round(Number(e.target.value) || 1))),
                  },
                })
              }
            />
          </div>
        ) : null}
        <span className="hint">
          Counted across every automation. A send over the cap is skipped and the run goes on.
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-s`}>
          Stop when <span className="opt">events, comma-separated, up to 20</span>
        </label>
        <input
          className="input mono"
          id={`${id}-s`}
          value={stops}
          readOnly={!editable}
          placeholder="account_deleted"
          onChange={(e) => {
            setStops(e.target.value)
            onChange({
              ...settings,
              stopEvents: e.target.value
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean)
                .slice(0, 20),
            })
          }}
        />
        <span className="hint">Any of these ends a run at once. Unsubscribing always ends it.</span>
      </div>
    </Frame>
  )
}

// ---------------------------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------------------------

export type Published = { version: number; runsByVersion: { version: number; active: number }[] }

export function PublishSheet({
  a,
  dirty,
  save,
  onClose,
  onPublished,
  onRefused,
}: {
  a: Automation
  dirty: boolean
  /** Saves the draft first when it has unsaved changes. */
  save: () => Promise<unknown>
  onClose: () => void
  onPublished: (p: Published) => void
  onRefused: (issues: Issue[], body: unknown) => void
}) {
  const id = useId()
  const versions = useQuery(versionsQuery(a.id))
  const [note, setNote] = useState("")
  const qc = useQueryClient()
  const v = num(a.version) ?? 1
  const running = (versions.data?.versions ?? []).filter((x) => (num(x.activeRuns) ?? 0) > 0)
  const pub = useMutation({
    mutationFn: async () => {
      if (dirty) await save()
      return unwrap(
        api.POST("/v1/automations/{id}/publish", {
          params: { path: { id: a.id } },
          body: { note: note.trim() || null },
        }),
      )
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["automations"] })
      if (r && "version" in r)
        onPublished({
          version: num(r.version) ?? v,
          runsByVersion: r.runsByVersion.map((x) => ({
            version: num(x.version) ?? 0,
            active: num(x.active) ?? 0,
          })),
        })
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        const issues = notReadyIssues(e.body)
        if (issues) onRefused(issues, e.body)
      }
    },
  })
  return (
    <Sheet
      title={`Publish v${v}?`}
      sub={
        a.issues.length
          ? `${a.issues.length} issue${a.issues.length === 1 ? "" : "s"} on the draft`
          : undefined
      }
      onClose={onClose}
      odId="publish-sheet"
      endpoint={`POST /v1/automations/${a.id}/publish {note} → {version, runsByVersion}`}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Keep editing
          </button>
          <button
            className={`btn btn-primary${pub.isPending ? " is-loading" : ""}`}
            type="button"
            onClick={() => pub.mutate()}
          >
            {pub.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            {dirty ? `Save and publish v${v}` : `Publish v${v}`}
          </button>
        </>
      }
    >
      <ul className="role-list">
        <li>
          <Icon name="check" />
          Contacts who enter from now on follow v{v}.
        </li>
        {running.length ? (
          <li>
            <Icon name="check" />
            {running
              .map((x) => `the ${fmtInt(x.activeRuns)} running v${num(x.version)}`)
              .join(" and ")
              .replace(/^./, (c) => c.toUpperCase())}{" "}
            finish on their version.
          </li>
        ) : null}
        <li>
          <Icon name={a.issues.length ? "warn" : "check"} />
          {a.issues.length ? (
            <span>
              The draft’s <span className="mono">issues</span> list has {a.issues.length}; publishing will be
              refused until they’re fixed.
            </span>
          ) : (
            <span>
              No issues: the draft’s <span className="mono">issues</span> list is empty, so publishing won’t
              be refused.
            </span>
          )}
        </li>
      </ul>
      <div className="field">
        <label className="label" htmlFor={id}>
          What changed <span className="opt">for the version history</span>
        </label>
        <input
          className="input"
          id={id}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {pub.isError &&
      !(pub.error instanceof ApiError && pub.error.status === 409 && notReadyIssues(pub.error.body)) ? (
        <ApiErrorCallout error={pub.error} what="It wasn’t published." />
      ) : null}
    </Sheet>
  )
}

export type { GNode }

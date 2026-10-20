/**
 * The segment builder (design: segment-builder.html, segment-builder-sql.html, segment-counting.html,
 * segment-zero.html, segment-preview-error.html; GAPS-audience A3.1–A3.6). The rule tree is the API's
 * `SegmentRule`; every change re-counts through `POST /v1/segments/preview` (debounced, the last good count
 * kept while it re-counts). A bad rule, found locally with the API's own message or named by a 400's `field`
 * path, is outlined and holds Save. Saving is `POST /v1/segments` or `PATCH /v1/segments/{id}`.
 */
import {
  keepPreviousData,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, RequestId } from "../../ui/Panel.tsx"
import { errorField, fieldError, fmtAgoShort, initialsOf } from "../kit/format.ts"
import type { Json } from "../kit/queries.ts"
import { allTopicsQuery, fieldLabel, fieldsQuery } from "../kit/queries.ts"
import { ApiErrorCallout, BackLink, FieldError, SampleMarker, Sheet, useCan } from "../kit/ui.tsx"
import { DeleteBlockedSheet, DeleteConfirmSheet, usedByHref } from "./DeleteBlocked.tsx"
import {
  EXCLUDED_LABEL,
  emptyTree,
  firstField,
  forContact,
  type Group,
  isGroup,
  type Names,
  numberParams,
  parsePath,
  type Rule,
  tokenizeSql,
  validate,
  withoutLast,
} from "./logic.ts"
import {
  assistantQuery,
  campaignNamesQuery,
  type Preview,
  previewQuery,
  type SegmentFull,
  segmentQuery,
} from "./queries.ts"

type AssistantSettings = Json<"/v1/settings/assistant", "get">

import { RuleSentence } from "./RuleSentence.tsx"
import { RuleTree, type TreeCtx } from "./RuleTree.tsx"
import "./segments.css"

type Props = {
  id: string | null
  sql: boolean
  onSql: (on: boolean) => void
  onSaved: (id: string) => void
  onDeleted: () => void
}

export function SegmentBuilder(props: Props) {
  const q = useQuery({ ...segmentQuery(props.id ?? ""), enabled: props.id !== null })
  if (props.id === null) return <Editor {...props} segment={null} />
  if (q.isPending) return <BuilderSkeleton />
  if (q.isError)
    return (
      <>
        <BackLink to="/audience/segments">Segments</BackLink>
        <PanelError error={q.error} onRetry={() => q.refetch()} what="This segment didn’t load" />
      </>
    )
  // Remount when another segment loads, so the editor's draft starts from it.
  return <Editor key={q.data.id} {...props} segment={q.data} />
}

function BuilderSkeleton() {
  return (
    <div className="au-seg" aria-busy="true">
      <BackLink to="/audience/segments">Segments</BackLink>
      <div className="obj-head">
        <div className="oh-main">
          <span className="sk sk-title" style={{ width: 320 }} />
          <span className="sk sk-text" style={{ width: 180 }} />
        </div>
      </div>
      <div className="builder">
        <section className="panel">
          <div className="panel-body stack stack-8">
            {[90, 80, 70, 60].map((w) => (
              <span key={w} className="sk sk-text" style={{ width: `${w}%`, height: 36 }} />
            ))}
          </div>
        </section>
        <div className="side">
          <section className="panel">
            <div className="panel-body stack stack-8">
              <span className="sk sk-stat" />
              <span className="sk sk-text" />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

const asGroup = (r: Rule | undefined): Group =>
  r && isGroup(r) ? r : r ? { type: "all", rules: [r] } : emptyTree()

function Editor({ segment, sql, onSql, onSaved, onDeleted }: Props & { segment: SegmentFull | null }) {
  const qc = useQueryClient()
  const write = useCan("contacts.write", "build and save segments")
  const topics = useQuery(allTopicsQuery)
  const campaigns = useQuery(campaignNamesQuery)
  const fields = useQuery(fieldsQuery)
  const initial = useRef({ name: segment?.name ?? "", tree: asGroup(segment?.filter) })
  const [name, setName] = useState(initial.current.name)
  const [tree, setTree] = useState<Group>(initial.current.tree)
  const [testing, setTesting] = useState(false)
  const [blocked, setBlocked] = useState<ApiError | null>(null)
  const [confirming, setConfirming] = useState(false)
  const debounced = useDebounced(tree, 400)
  const local = validate(tree)
  const debouncedLocal = validate(debounced)

  const preview = useQuery({
    ...previewQuery(debounced),
    enabled: !debouncedLocal,
    placeholderData: keepPreviousData,
  })
  const lastGood = useRef<Preview | null>(null)
  if (preview.data && !preview.isPlaceholderData && !preview.isError) lastGood.current = preview.data
  const shown = preview.isError ? null : (preview.data ?? null)
  const counting = (preview.isFetching || tree !== debounced) && !local
  const zero = shown && num(shown.count) === 0 && !preview.isPlaceholderData
  const relaxed = zero ? withoutLast(debounced) : null
  const without = useQuery({ ...previewQuery(relaxed ?? emptyTree()), enabled: Boolean(relaxed) })

  const save = useMutation({
    mutationFn: () =>
      segment
        ? unwrap(
            api.PATCH("/v1/segments/{id}", {
              params: { path: { id: segment.id } },
              body: { name: name.trim(), filter: tree },
            }),
          )
        : unwrap(api.POST("/v1/segments", { body: { name: name.trim(), filter: tree } })),
    onSuccess: (s) => {
      if (!s || !("id" in s)) return
      initial.current = { name: name.trim(), tree }
      qc.setQueryData(segmentQuery(s.id).queryKey, s)
      qc.invalidateQueries({ queryKey: ["segments"], exact: true })
      qc.invalidateQueries({ queryKey: ["contact-fields"] })
      if (!segment) onSaved(s.id)
    },
  })
  const del = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE("/v1/segments/{id}", { params: { path: { id: segment?.id ?? "" } } })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["segments"] })
      onDeleted()
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        setConfirming(false)
        setBlocked(e)
        if (segment) qc.invalidateQueries({ queryKey: segmentQuery(segment.id).queryKey })
      }
    },
  })

  // A 400 from the preview or the save names the rule by path; local checks name it the same way.
  const serverPath = [preview.error, save.error]
    .map((e) => ({ e, f: errorField(e) }))
    .find((x) => x.f && parsePath(x.f))
  const problem =
    local ??
    (serverPath ? { path: serverPath.f as string, message: (serverPath.e as ApiError).message } : null)
  const nameErr = fieldError(save.error, "name")
  const dirty =
    name.trim() !== initial.current.name || JSON.stringify(tree) !== JSON.stringify(initial.current.tree)

  const topicName = (id: string) => topics.data?.find((t) => t.id === id)?.name
  const campaignName = (id: string) => campaigns.data?.find((c) => c.id === id)?.name
  const fieldName = (k: string) =>
    fieldLabel(
      fields.data?.find((f) => f.key === k),
      k,
    )
  const names: Names = { topic: topicName, campaign: campaignName, field: fieldName }
  const ctx: TreeCtx = {
    topics: topics.data ?? [],
    campaigns: campaigns.data ?? [],
    fields: (fields.data ?? []).map((f) => ({ key: f.key, label: f.label, type: f.type })),
    error: problem,
  }
  const usedBy = segment?.usedBy ?? []
  const saveBlock = !write.allowed
    ? { reason: "You can’t save segments", who: write.who }
    : problem
      ? {
          reason: "Fix the outlined rule first",
          who: "The API refuses a tree it can’t count, so saving would fail the same way.",
        }
      : !name.trim()
        ? {
            reason: "Give the segment a name",
            who: "It’s what campaigns and automations show when they pick it.",
          }
        : segment && !dirty
          ? { reason: "Nothing to save", who: "Change a rule or the name first." }
          : null
  const assistant = useQuery(assistantQuery)

  return (
    <div className="au-seg">
      <BackLink to="/audience/segments">Segments</BackLink>
      <div className="obj-head" data-od-id="object-head">
        <div className="oh-main">
          <h1 data-od-id="page-title">
            {segment ? name.trim() || segment.name : name.trim() || "New segment"}
          </h1>
          <div className="oh-sub">
            {segment ? <span className="mono">{segment.id}</span> : <span>Not saved yet</span>}
            {usedBy.length ? (
              <span className="cluster cluster-8">
                Used by{" "}
                <span className="used-by">
                  {usedBy.map((u) => (
                    <Link key={`${u.type}-${u.id}`} className="ttag used-chip" to={usedByHref(u)}>
                      <Icon name={u.type === "campaign" ? "campaigns" : "automations"} />
                      {u.name}
                    </Link>
                  ))}
                </span>
              </span>
            ) : segment ? (
              <span>Not used yet</span>
            ) : null}
            <span className="savestate" role="status">
              <Icon name={dirty ? "circle-dash" : "check"} />
              {save.isPending
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : segment?.updatedAt
                    ? `Saved ${fmtAgoShort(segment.updatedAt)}`
                    : "Saved"}
            </span>
          </div>
        </div>
        <div className="oh-actions">
          <SampleMarker />
          <button
            className="btn btn-secondary btn-sm edit-only"
            type="button"
            onClick={() => setTesting(true)}
            disabled={Boolean(local)}
          >
            Test against a contact
          </button>
          {segment ? (
            <Gated
              allowed={write.allowed && usedBy.length === 0}
              reason={write.allowed ? "In use, so it can’t be deleted" : "You can’t delete segments"}
              who={
                write.allowed
                  ? `Used by ${usedBy.map((u) => u.name).join(", ")}. Point them at another segment first.`
                  : write.who
              }
              side="right"
            >
              <button
                className="btn btn-ghost btn-sm edit-only"
                type="button"
                onClick={() => setConfirming(true)}
                data-endpoint={`DELETE /v1/segments/${segment.id}`}
              >
                <Icon name="trash" />
                Delete
              </button>
            </Gated>
          ) : null}
          <Gated allowed={!saveBlock} reason={saveBlock?.reason} who={saveBlock?.who} side="right">
            <button
              className={`btn btn-primary btn-sm edit-only${save.isPending ? " is-loading" : ""}`}
              type="button"
              onClick={() => save.mutate()}
              data-od-id="save-segment"
              data-endpoint={segment ? `PATCH /v1/segments/${segment.id}` : "POST /v1/segments"}
            >
              {save.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" />}
              Save segment
            </button>
          </Gated>
        </div>
      </div>
      <div
        className="ro-note phone-only"
        role="note"
        data-od-id="phone-read-only"
        style={{ marginBottom: 16 }}
      >
        <Icon name="monitor" />
        <span>
          <b>Read-only on a phone.</b> The segment builder needs a wider screen to edit. Everything here is
          current; open it on a tablet or computer to change it.
        </span>
      </div>
      {save.isError && !problem && !nameErr ? (
        <div style={{ marginBottom: 16 }}>
          <ApiErrorCallout error={save.error} what="The segment wasn’t saved." />
        </div>
      ) : null}
      <div className="builder">
        <div className="stack">
          <section
            className="panel"
            data-endpoint="POST /v1/segments/preview · filter: SegmentRule"
            data-od-id="panel-rules"
            aria-labelledby="h-rules"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-rules">
                Rules
              </h2>
              <div className="cluster">
                <span className="panel-meta">Every change re-counts</span>
              </div>
            </header>
            <div className="panel-body">
              <div className="stack">
                <div className="field edit-only">
                  <label className="label" htmlFor="seg-name">
                    Name
                  </label>
                  <input
                    className="input"
                    id="seg-name"
                    value={name}
                    maxLength={100}
                    placeholder="Engaged course buyers, West Africa"
                    onChange={(e) => setName(e.target.value)}
                    {...(nameErr ? { "aria-invalid": true, "aria-describedby": "seg-name-err" } : {})}
                  />
                  {nameErr ? <FieldError id="seg-name-err">{nameErr}</FieldError> : null}
                </div>
                <NlEntry assistant={assistant} tree={tree} onRules={setTree} />
                <div className="edit-only">
                  <RuleTree root={tree} onChange={setTree} ctx={ctx} />
                </div>
                <div className="phone-only">
                  <RuleSentence rule={tree} names={names} />
                </div>
              </div>
            </div>
          </section>
          <SqlPanel on={sql} onToggle={onSql} data={lastGood.current} />
        </div>
        <div className="side">
          <LiveCount
            shown={shown}
            lastGood={lastGood.current}
            counting={counting}
            error={
              local ? { message: local.message, path: local.path } : preview.isError ? preview.error : null
            }
            without={relaxed ? num(without.data?.count) : null}
          />
          <SamplePanel data={problem ? null : shown} field={firstField(tree)} fieldName={fieldName} />
        </div>
      </div>
      {testing ? <TestSheet tree={tree} onClose={() => setTesting(false)} /> : null}
      {confirming && segment ? (
        <DeleteConfirmSheet
          name={segment.name}
          busy={del.isPending}
          error={del.isError && !blocked ? del.error : null}
          onConfirm={() => del.mutate()}
          onClose={() => setConfirming(false)}
        />
      ) : null}
      {blocked && segment ? (
        <DeleteBlockedSheet
          name={segment.name}
          error={blocked}
          usedBy={usedBy}
          onClose={() => setBlocked(null)}
        />
      ) : null}
    </div>
  )
}

/** What `POST /v1/segments/from-text` refusing with `AssistantRefused` means, in words a person can act on. */
const REFUSED: Record<string, string> = {
  off: "AI is off for this Mailyard. An owner can turn it on in Settings → AI.",
  disabled: "Turning a sentence into rules is switched off. An owner can turn it on in Settings → AI.",
  cap: "This Mailyard has used today’s AI calls for segments. They reset at midnight UTC; build the rules below meanwhile.",
  no_answer: "The model didn’t come back with rules. Try putting it another way, or build the rules below.",
  invalid:
    "The model’s rules didn’t check out, so nothing changed. Try putting it another way, or build the rules below.",
}

/**
 * "Describe it": a sentence becomes a rule tree through `POST /v1/segments/from-text`, checked by the segment
 * code before it comes back. The rules replace the tree below for review; nothing is saved until Save.
 * Offered when the assistant is configured and segments are turned on (`GET /v1/settings/assistant`). If that
 * can't be read, the box still works and the API's own refusal says why.
 */
function NlEntry({
  assistant,
  tree,
  onRules,
}: {
  assistant: UseQueryResult<AssistantSettings>
  tree: Group
  onRules: (g: Group) => void
}) {
  const [text, setText] = useState("")
  const compile = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/segments/from-text", { body: { text: text.trim() } })),
    onSuccess: (b) => onRules(asGroup(b.rule)),
  })
  const a = assistant.data
  const off = a ? (!a.available ? REFUSED.off : !a.segments ? REFUSED.disabled : null) : null
  const usable = !off && !assistant.isPending
  const refused =
    compile.error instanceof ApiError && compile.error.status === 409 && compile.error.reason
      ? (REFUSED[compile.error.reason] ?? null)
      : null
  const done = compile.data
  const count = done ? num(done.count) : null
  return (
    <div className="field edit-only" data-od-id="nl-entry">
      <span className="spread">
        <label className="label" htmlFor="nl">
          Describe it <span className="opt">optional</span>
        </label>
        {a?.model && usable ? <span className="hint mono">{a.model}</span> : null}
      </span>
      <form
        className="input-group"
        onSubmit={(e) => {
          e.preventDefault()
          if (usable && text.trim() && !compile.isPending) compile.mutate()
        }}
      >
        <input
          className="input"
          id="nl"
          placeholder="e.g. active learners in West Africa who opened October’s update"
          disabled={!usable}
          value={text}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="btn btn-secondary btn-sm"
          type="submit"
          disabled={!usable || !text.trim() || compile.isPending}
          style={{ border: 0, borderLeft: "1px solid var(--my-border)", borderRadius: 0, height: "auto" }}
        >
          {compile.isPending ? "Writing…" : "Write rules"}
        </button>
      </form>
      <span className="hint" aria-live="polite">
        {off
          ? off
          : done
            ? `${done.explanation ? `${done.explanation} ` : ""}${
                count !== null
                  ? `${fmtInt(count)} ${count === 1 ? "contact matches" : "contacts match"} now. `
                  : ""
              }Review the rules below; nothing is saved until you save.`
            : `The rules land below for review, replacing the ${tree.rules.length ? "current ones" : "empty tree"}; nothing is saved.`}
      </span>
      {refused ? (
        <p className="hint" role="alert" style={{ color: "var(--red-900)" }}>
          {refused}
          {compile.error instanceof ApiError && compile.error.requestId ? (
            <span className="mono"> · {compile.error.requestId}</span>
          ) : null}
        </p>
      ) : compile.isError ? (
        <ApiErrorCallout error={compile.error} what="That couldn’t be turned into rules." />
      ) : null}
    </div>
  )
}

function LiveCount({
  shown,
  lastGood,
  counting,
  error,
  without,
}: {
  shown: Preview | null
  lastGood: Preview | null
  counting: boolean
  error: unknown
  without: number | null
}) {
  const local =
    error && typeof error === "object" && "path" in error
      ? (error as { message: string; path: string })
      : null
  const apiErr = !local && error instanceof ApiError ? error : null
  const data = shown ?? (counting ? lastGood : null)
  const excludedTotal = data ? Object.values(data.excluded).reduce<number>((n, v) => n + (num(v) ?? 0), 0) : 0
  return (
    <section
      className="panel"
      data-endpoint="POST /v1/segments/preview → count, sendable, excluded, tookMs"
      data-od-id="panel-live-count"
      aria-labelledby="h-live-count"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-live-count">
          Live count
        </h2>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          {local || (apiErr && apiErr.status === 400) ? (
            <div className="callout callout-error" role="alert" data-od-id="preview-400">
              <Icon name="x-circle" />
              <span>
                <b>The rules can’t be counted yet.</b> {local ? local.message : apiErr?.message} It’s the
                outlined rule
                {local || errorField(apiErr) ? (
                  <>
                    {" "}
                    (<code className="mono">{local ? local.path : errorField(apiErr)}</code>)
                  </>
                ) : null}
                .
                {lastGood
                  ? ` The last good count was ${fmtInt(lastGood.sendable)} of ${fmtInt(lastGood.count)}.`
                  : ""}
              </span>
            </div>
          ) : apiErr || (error && !data) ? (
            <div className="callout callout-error" role="alert">
              <Icon name="x-circle" />
              <div className="stack stack-4">
                <span>
                  <b>The count didn’t load.</b>{" "}
                  {apiErr ? apiErr.message : "Mailyard couldn’t be reached. The rules are unchanged."}
                </span>
                {apiErr?.requestId ? <RequestId id={apiErr.requestId} /> : null}
              </div>
            </div>
          ) : data ? (
            <>
              <div
                className={`livecount${counting ? " is-counting" : ""}${num(data.count) === 0 ? " is-zero" : ""}`}
                role="status"
                aria-live="polite"
                data-od-id="preview-sendable"
              >
                <span className="lc-n">{fmtInt(data.sendable)}</span>
                <span className="lc-l">can receive mail</span>
                <span className="lc-match">
                  of <b>{fmtInt(data.count)}</b> who match the rules
                  {num(data.count) === 0 ? " · nobody yet" : ""}
                </span>
                <span className="lc-meta">
                  {counting ? (
                    <>
                      <span className="spinner" aria-hidden="true" style={{ width: 12, height: 12 }} />
                      Re-counting after your change…
                    </>
                  ) : (
                    <>
                      <Icon name="clock" />
                      Counted just now · <span className="mono">{fmtInt(data.tookMs)} ms</span>
                    </>
                  )}
                </span>
              </div>
              {num(data.count) === 0 && !counting ? (
                <div className="callout callout-warn">
                  <Icon name="warn" />
                  <span>
                    <b>No contacts match.</b>{" "}
                    {without !== null && without > 0
                      ? `The last rule removed everyone. Loosen it, or remove it to get back to ${fmtInt(without)}.`
                      : "Loosen a rule, or switch a group from all to any."}
                  </span>
                </div>
              ) : (
                <div className="stack stack-8" data-od-id="preview-excluded">
                  <span className="label">Matched but won’t receive · {fmtInt(excludedTotal)}</span>
                  <ul className="ex-list">
                    {(Object.keys(EXCLUDED_LABEL) as (keyof typeof EXCLUDED_LABEL)[]).map((k) => (
                      <li key={k} className="ex-row">
                        <span>{EXCLUDED_LABEL[k]}</span>
                        <b className="num">{fmtInt(data.excluded[k])}</b>
                      </li>
                    ))}
                  </ul>
                  <p className="hint">
                    Sendable means status subscribed. Campaigns and automations skip the rest, so they’re
                    counted here, not hidden.
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="livecount is-counting" role="status" aria-live="polite">
              <span className="sk sk-stat" />
              <span className="lc-meta">
                <span className="spinner" aria-hidden="true" style={{ width: 12, height: 12 }} />
                Counting…
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function SamplePanel({
  data,
  field,
  fieldName,
}: {
  data: Preview | null
  field: string | null
  fieldName: (k: string) => string
}) {
  return (
    <section
      className="panel"
      data-endpoint="POST /v1/segments/preview → sample"
      data-od-id="panel-sample"
      aria-labelledby="h-sample"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-sample">
          Sample{data ? ` of ${data.sample.length}` : ""}
        </h2>
        <div className="cluster">
          <span className="panel-meta">Random, refreshed with the count</span>
        </div>
      </header>
      <div className="panel-body">
        {!data ? (
          <p className="hint">The sample comes back with the count once the rules are valid.</p>
        ) : data.sample.length === 0 ? (
          <p className="hint">Nobody to show: no contact matches.</p>
        ) : (
          <div className="sample-list">
            <ul className="list">
              {data.sample.map((c) => {
                const v =
                  field && field !== "email" && field !== "name"
                    ? (c.fields as Record<string, unknown>)[field]
                    : undefined
                return (
                  <li key={c.id} className="list-row">
                    <span className="avatar" aria-hidden="true">
                      {initialsOf(c.name, c.email)}
                    </span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <Link className="row-title" to={`/audience/contacts/${c.id}` as string}>
                        {c.name ?? c.email}
                      </Link>
                      <span className="row-sub mono">{c.email}</span>
                    </span>
                    {v !== undefined && v !== null && v !== "" ? (
                      <span className="ttag" title={field ? fieldName(field) : undefined}>
                        {String(v)}
                      </span>
                    ) : c.status !== "subscribed" ? (
                      <span className="ttag is-pending">{c.status}</span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

function SqlPanel({
  on,
  onToggle,
  data,
}: {
  on: boolean
  onToggle: (on: boolean) => void
  data: Preview | null
}) {
  const sql = data ? numberParams(data.sql) : ""
  return (
    <section
      className="panel"
      data-endpoint="POST /v1/segments/preview → sql, params"
      data-od-id="panel-sql"
      aria-labelledby="h-sql"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-sql">
          Compiled SQL
        </h2>
        <div className="cluster">
          <span className="panel-meta">For developers</span>
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          <label className="switch">
            <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} /> Show the SQL
            Mailyard runs
          </label>
          {on ? (
            data ? (
              <div className="stack stack-8">
                <pre className="sql" data-od-id="compiled-sql">
                  {tokenizeSql(sql).map((t, i) =>
                    t.t === "txt" ? (
                      t.s
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                      <span key={i} className={t.t}>
                        {t.s}
                      </span>
                    ),
                  )}
                </pre>
                {data.params.length ? (
                  <div className="params">
                    {data.params.map((p, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: params are positional
                      <code key={i} className="mono">
                        ?{i + 1} = {typeof p === "string" ? p : JSON.stringify(p)}
                      </code>
                    ))}
                  </div>
                ) : null}
                <p className="hint">
                  Read-only. It’s what D1 runs for the count; text in an <span className="mono">in</span> list
                  compares with <span className="mono">COLLATE NOCASE</span>. Edit the rules, not the SQL.
                </p>
              </div>
            ) : (
              <p className="hint">The SQL comes back with the first count.</p>
            )
          ) : null}
        </div>
      </div>
    </section>
  )
}

function TestSheet({ tree, onClose }: { tree: Group; onClose: () => void }) {
  const [email, setEmail] = useState("")
  const test = useMutation({
    mutationFn: (addr: string) =>
      unwrap(api.POST("/v1/segments/preview", { body: { filter: forContact(tree, addr) } })),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) test.mutate(email.trim())
  }
  const r = test.data
  const hit = r ? r.sample[0] : undefined
  return (
    <Sheet
      title="Test against a contact"
      sub="Counts these rules for one address, with what’s on screen now, saved or not."
      onClose={onClose}
      endpoint="POST /v1/segments/preview {filter: all[rules, email = …]}"
      footer={
        <button className="btn btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <form className="field" onSubmit={submit}>
        <label className="label" htmlFor="seg-test">
          Email address
        </label>
        <div className="input-group">
          <input
            className="input mono"
            id="seg-test"
            type="email"
            value={email}
            placeholder="ada.okafor@gmail.com"
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            className="btn btn-secondary btn-sm"
            type="submit"
            disabled={test.isPending}
            style={{ border: 0, borderLeft: "1px solid var(--my-border)", borderRadius: 0, height: "auto" }}
          >
            {test.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            Test
          </button>
        </div>
      </form>
      {r ? (
        num(r.count) && hit ? (
          <div
            className={`callout ${hit.status === "subscribed" ? "callout-ok" : "callout-warn"}`}
            role="status"
          >
            <Icon name={hit.status === "subscribed" ? "check-circle" : "warn"} />
            <span>
              <b>{hit.name ?? hit.email} matches.</b>{" "}
              {hit.status === "subscribed"
                ? "They’d get mail sent to this segment."
                : `They match, but their status is ${hit.status}, so campaigns and automations skip them.`}{" "}
              <Link className="link" to={`/audience/contacts/${hit.id}` as string}>
                Open the contact
              </Link>
            </span>
          </div>
        ) : (
          <div className="callout callout-info" role="status">
            <Icon name="info" />
            <span>
              <b>{test.variables} doesn’t match.</b> Either a rule leaves them out, or there’s no contact with
              that address.
            </span>
          </div>
        )
      ) : null}
      {test.isError ? <ApiErrorCallout error={test.error} what="The test didn’t run." /> : null}
    </Sheet>
  )
}

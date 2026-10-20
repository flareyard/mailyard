/**
 * Audience → Topics (design: topics.html, topics-7d.html, topics-90d.html, topics-edit.html, topics-empty.html,
 * topics-loading.html, topics-error.html; GAPS-audience A2.1). `GET /v1/topics` for the topics and their
 * settings, `GET /v1/topics/stats?range=` for joined, left and the rates. `?range=` is in the URL; `?edit=top_…`
 * and `?new=1` open the sheet that PATCHes or POSTs a topic (`contacts.write`).
 */
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { meQuery } from "../../auth/session.ts"
import { fmtInt } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { AudienceHead } from "../AudienceHead.tsx"
import "./topics.css"
import { fieldError } from "../kit/format.ts"
import { allTopicsQuery, arr, identitiesQuery, type Json, type Topic } from "../kit/queries.ts"
import { ApiErrorCallout, FieldError, Sheet, SkeletonRows, useCan } from "../kit/ui.tsx"
import {
  growthText,
  NOT_ENOUGH,
  RANGE_DAYS,
  RANGES,
  type Range,
  signed,
  type TopicDraft,
  topicBody,
  unsubText,
  validateTopic,
} from "./logic.ts"

type Stats = Json<"/v1/topics/stats", "get">

export const topicStatsQuery = (range: Range) => ({
  queryKey: ["topics", "stats", range] as const,
  queryFn: () => unwrap(api.GET("/v1/topics/stats", { params: { query: { range } } })),
  staleTime: 60_000,
})

type Props = {
  range: Range
  edit: string | undefined
  isNew: boolean
  onRange: (r: Range) => void
  onEdit: (id: string | undefined) => void
  onNew: (open: boolean) => void
}

export function TopicsPage({ range, edit, isNew, onRange, onEdit, onNew }: Props) {
  const topics = useQuery(allTopicsQuery)
  const stats = useQuery(topicStatsQuery(range))
  const write = useCan("contacts.write", "create and edit topics")
  const editing = edit ? topics.data?.find((t) => t.id === edit) : undefined
  // The panel waits on both reads; either failing shows the error, with its own retry.
  const both = {
    ...topics,
    isPending: topics.isPending || stats.isPending,
    isError: topics.isError || stats.isError,
    error: topics.error ?? stats.error,
    refetch: () => Promise.all([topics.refetch(), stats.refetch()]).then(() => topics),
  } as unknown as UseQueryResult<Topic[]>
  const days = RANGE_DAYS[range]

  return (
    <>
      <AudienceHead
        current="topics"
        sub="Topics are what people subscribe to. Each one appears on the preference page with its description."
        actions={
          <>
            {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg control is a styled group of links */}
            <div className="seg" role="group" aria-label="Range" data-seg data-od-id="topic-range">
              {RANGES.map((r) => (
                <button
                  key={r}
                  className="seg-link"
                  type="button"
                  aria-pressed={r === range}
                  onClick={() => onRange(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            <Gated allowed={write.allowed} reason="You can’t create topics" who={write.who} side="right">
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={() => onNew(true)}
                data-endpoint="POST /v1/topics"
                data-od-id="new-topic"
              >
                <Icon name="plus" />
                New topic
              </button>
            </Gated>
          </>
        }
      />
      <Panel
        id="topics"
        title="Topics"
        endpoint={`GET /v1/topics · GET /v1/topics/stats?range=${range}`}
        query={both}
        meta={`Joined, left and rates over ${days} days`}
        skeleton={<SkeletonRows rows={5} cols={7} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <div className="empty" data-od-id="empty-state">
            <span className="empty-icon">
              <Icon name="tag" />
            </span>
            <h3>No topics yet</h3>
            <p>
              A topic is a list people choose to be on, like “Product updates” or “Weekly digest”. Campaigns
              go to topics or segments.
            </p>
            <Gated allowed={write.allowed} reason="You can’t create topics" who={write.who}>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => onNew(true)}>
                <Icon name="plus" />
                Create a topic
              </button>
            </Gated>
          </div>
        }
      >
        {(list) => <TopicsTable topics={list} stats={stats.data} days={days} onEdit={onEdit} />}
      </Panel>
      {(editing || isNew) && write.allowed ? (
        <TopicSheet
          topic={isNew ? undefined : editing}
          onClose={() => (isNew ? onNew(false) : onEdit(undefined))}
          onCreated={(id) => onEdit(id)}
        />
      ) : null}
    </>
  )
}

function TopicsTable({
  topics,
  stats,
  days,
  onEdit,
}: {
  topics: Topic[]
  stats: Stats | undefined
  days: number
  onEdit: (id: string) => void
}) {
  const byId = new Map((stats?.topics ?? []).map((s) => [s.topicId, s]))
  const min = stats?.minimumSubscribers
  // Active topics first, then archived; each by subscribers.
  const sorted = [...topics].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || Number(b.subscribers) - Number(a.subscribers),
  )
  return (
    <>
      <div className="table-wrap desk-only au-topics">
        <table className="table dt" data-od-id="topics-table">
          <thead>
            <tr>
              <th>Topic</th>
              <th className="r">Subscribers</th>
              <th className="r">Joined, {days} d</th>
              <th className="r">Left, {days} d</th>
              <th className="r">Growth</th>
              <th className="r">Unsubscribe rate</th>
              <th>Double opt-in</th>
              <th>Default sender</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => {
              const s = byId.get(t.id)
              const g = s ? growthText(s) : null
              const u = s ? unsubText(s) : null
              return (
                <tr key={t.id}>
                  <td>
                    <button
                      className="cell-link"
                      type="button"
                      onClick={() => onEdit(t.id)}
                      style={{
                        background: "none",
                        border: 0,
                        padding: 0,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      {t.name}
                    </button>
                    <span className="cell-sub">
                      {t.description ?? "No description: the preference page shows only the name"}
                    </span>
                  </td>
                  <td className="r">
                    <b>{fmtInt(s?.subscribers ?? t.subscribers)}</b>
                    {s ? <span className="cell-sub">{fmtInt(s.subscribersAtStart)} at the start</span> : null}
                  </td>
                  <td className="r">{s ? signed(s.joined, "+") : "—"}</td>
                  <td className="r">{s ? signed(s.left, "−") : "—"}</td>
                  <td className="r">
                    {s?.insufficientData ? (
                      <span className="not-enough">{NOT_ENOUGH(min)}</span>
                    ) : (
                      <b>{g ?? "—"}</b>
                    )}
                  </td>
                  <td className="r">
                    {s?.insufficientData ? (
                      <span className="not-enough">{NOT_ENOUGH(min)}</span>
                    ) : (
                      <b>{u ?? "—"}</b>
                    )}
                  </td>
                  <td>
                    {t.doubleOptIn ? (
                      <span className="pill pill-neutral">
                        <span className="dot" />
                        On
                      </span>
                    ) : (
                      <span className="muted">Off</span>
                    )}
                  </td>
                  <td>
                    {t.sender ? (
                      <span className="mono">{t.sender}</span>
                    ) : (
                      <span className="muted">Campaign’s own</span>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${t.archived ? "pill-neutral" : "pill-pass"}`}>
                      <span className="dot" />
                      {t.archived ? "Archived" : "Active"}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="phone-only">
        <ul className="list">
          {sorted.map((t) => {
            const s = byId.get(t.id)
            const g = s ? growthText(s) : null
            return (
              <li key={t.id} className="list-row">
                <span className="grow" style={{ minWidth: 0 }}>
                  <button
                    className="row-title"
                    type="button"
                    onClick={() => onEdit(t.id)}
                    style={{
                      background: "none",
                      border: 0,
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                      minHeight: 44,
                    }}
                  >
                    {t.name}
                  </button>
                  <span className="row-sub" style={{ whiteSpace: "normal" }}>
                    {fmtInt(s?.subscribers ?? t.subscribers)} subscribers
                    {s ? ` · ${signed(s.joined, "+")} / ${signed(s.left, "−")} in ${days} d` : ""}
                    {s?.insufficientData ? ` · ${NOT_ENOUGH(min)}` : g ? ` · ${g} growth` : ""}
                  </span>
                </span>
                <span className={`pill ${t.archived ? "pill-neutral" : "pill-pass"}`}>
                  <span className="dot" />
                  {t.archived ? "Archived" : "Active"}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        Rates are over the subscribers at the start of the range, so a new topic reads high. Under{" "}
        {fmtInt(min ?? 100)} at the start there’s not enough to say, and the rate stays blank rather than a
        misleading percentage.
      </p>
    </>
  )
}

function TopicSheet({
  topic,
  onClose,
  onCreated,
}: {
  topic: Topic | undefined
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  const identities = useQuery(identitiesQuery)
  const host = useQuery(meQuery).data?.workspace.host ?? "your mail domain"
  const [d, setD] = useState<TopicDraft>({
    name: topic?.name ?? "",
    description: topic?.description ?? "",
    sender: topic?.sender ?? "",
    doubleOptIn: topic?.doubleOptIn ?? false,
  })
  const [tried, setTried] = useState(false)
  const local = validateTopic(d)
  const done = () => {
    qc.invalidateQueries({ queryKey: ["topics"] })
  }
  const save = useMutation({
    mutationFn: () =>
      topic
        ? unwrap(api.PATCH("/v1/topics/{id}", { params: { path: { id: topic.id } }, body: topicBody(d) }))
        : unwrap(api.POST("/v1/topics", { body: topicBody(d) })),
    onSuccess: (t) => {
      done()
      if (!topic && t && "id" in t) onCreated(t.id)
      else onClose()
    },
  })
  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      unwrap(api.PATCH("/v1/topics/{id}", { params: { path: { id: topic?.id ?? "" } }, body: { archived } })),
    onSuccess: () => {
      done()
      onClose()
    },
  })
  const nameErr = (tried && local?.field === "name" ? local.message : null) ?? fieldError(save.error, "name")
  const descErr =
    (tried && local?.field === "description" ? local.message : null) ?? fieldError(save.error, "description")
  const senderErr = fieldError(save.error, "sender")
  const addresses = arr<{ address: string }>(identities.data).map((i) => i.address)
  if (d.sender && !addresses.includes(d.sender)) addresses.unshift(d.sender)
  const submit = () => {
    setTried(true)
    if (!local) save.mutate()
  }
  return (
    <Sheet
      wide
      title={topic ? "Edit topic" : "New topic"}
      sub={
        topic ? (
          <>
            <span className="mono">{topic.id}</span> · {fmtInt(topic.subscribers)} subscribers
          </>
        ) : (
          "People subscribe to topics on forms and the preference page; campaigns go to them."
        )
      }
      onClose={onClose}
      odId="topic-sheet"
      endpoint={topic ? `PATCH /v1/topics/${topic.id}` : "POST /v1/topics"}
      footer={
        <div className="spread" style={{ width: "100%", flexWrap: "wrap", gap: 8 }}>
          {topic ? (
            <button
              className="btn btn-danger-ghost"
              type="button"
              onClick={() => archive.mutate(!topic.archived)}
              disabled={archive.isPending}
              data-endpoint={`PATCH /v1/topics/${topic.id} {archived:${!topic.archived}}`}
            >
              {topic.archived ? "Restore topic" : "Archive topic"}
            </button>
          ) : (
            <span />
          )}
          <span className="cluster">
            <button className="btn btn-ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className={`btn btn-primary${save.isPending ? " is-loading" : ""}`}
              type="button"
              onClick={submit}
              disabled={save.isPending}
            >
              {save.isPending ? <span className="spinner" aria-hidden="true" /> : null}
              {topic ? "Save topic" : "Create topic"}
            </button>
          </span>
        </div>
      }
    >
      {topic?.archived ? (
        <div className="callout callout-info" role="note">
          <Icon name="info" />
          <span>
            Archived: it’s off the preference page and forms, and campaigns can’t pick it. Subscribers stay as
            they are.
          </span>
        </div>
      ) : null}
      <div className="field">
        <label className="label" htmlFor="tp-name">
          Name
        </label>
        <input
          className="input"
          id="tp-name"
          value={d.name}
          maxLength={100}
          onChange={(e) => setD({ ...d, name: e.target.value })}
          {...(nameErr ? { "aria-invalid": true, "aria-describedby": "tp-name-err" } : {})}
        />
        {nameErr ? <FieldError id="tp-name-err">{nameErr}</FieldError> : null}
      </div>
      <div className="field">
        <label className="label" htmlFor="tp-desc">
          Public description
        </label>
        <textarea
          className="textarea"
          id="tp-desc"
          rows={2}
          value={d.description}
          maxLength={500}
          onChange={(e) => setD({ ...d, description: e.target.value })}
          aria-describedby={descErr ? "tp-desc-err" : "tp-desc-hint"}
          {...(descErr ? { "aria-invalid": true } : {})}
        />
        <span className="hint" id="tp-desc-hint">
          Shown on the preference page and signup forms. Say what they’ll get and how often.
        </span>
        {descErr ? <FieldError id="tp-desc-err">{descErr}</FieldError> : null}
      </div>
      <div className="fgrid">
        <div className="field">
          <label className="label" htmlFor="tp-sender">
            Default sender <span className="opt">optional</span>
          </label>
          <select
            className="select"
            id="tp-sender"
            value={d.sender}
            onChange={(e) => setD({ ...d, sender: e.target.value })}
            {...(senderErr ? { "aria-invalid": true, "aria-describedby": "tp-sender-err" } : {})}
          >
            {addresses.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
            <option value="">None: each campaign picks</option>
          </select>
          {senderErr ? <FieldError id="tp-sender-err">{senderErr}</FieldError> : null}
        </div>
        <div className="field">
          <span className="label">Double opt-in</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={d.doubleOptIn}
              onChange={(e) => setD({ ...d, doubleOptIn: e.target.checked })}
            />{" "}
            {d.doubleOptIn
              ? "On: new subscribers confirm by email first"
              : "Off: new subscribers join at once"}
          </label>
          <span className="hint">
            Applies to forms and API sign-ups from now on, not to people already subscribed.
          </span>
        </div>
      </div>
      <div className="stack stack-8">
        <span className="label">On the preference page</span>
        <div className="pubframe">
          <div className="pf-bar">
            <Icon name="lock" />
            <span>{host}/p/…</span>
          </div>
          <div className="pf-body" style={{ padding: 16 }}>
            <div className="pubcard" style={{ gap: 10, padding: 16 }}>
              <div className="consent" style={{ padding: 0, border: 0 }}>
                <span className="c-name">{d.name.trim() || "Topic name"}</span>
                <label className="switch">
                  <input type="checkbox" defaultChecked aria-label="Preview toggle" tabIndex={-1} />
                </label>
                <span className="c-how">
                  {d.description.trim() || "No description: only the name shows."}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      {save.isError && !nameErr && !descErr && !senderErr ? (
        <ApiErrorCallout error={save.error} what="The topic wasn’t saved." />
      ) : null}
      {archive.isError ? <ApiErrorCallout error={archive.error} what="The topic wasn’t changed." /> : null}
      {topic ? (
        <p className="hint">
          See who’s on it in{" "}
          <Link className="link" to="/audience/contacts" search={{ topicId: topic.id } as never}>
            Contacts
          </Link>
          .
        </p>
      ) : null}
    </Sheet>
  )
}

/**
 * Bulk actions on contacts (design: contacts-selected, contacts-bulk-all, -bulk-result, -bulk-queued,
 * -bulk-running, -bulk-done, -bulk-failed; GAPS-audience A1.8). `POST /v1/contacts/bulk { ids | filter, action }`
 * answers a union: `mode: "sync"` (up to 1,000) shows the result inline; `mode: "async"` shows the job, polled at
 * `GET /v1/contacts/bulk/{id}` every 5 s until it's done or failed. Select-all always sends the filter, since
 * ids cap at 1,000. Only the first 100 skip reasons are kept; the panel says how many more there were.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useId, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fmtAgo, fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { plural } from "../kit/format.ts"
import type { Topic } from "../kit/queries.ts"
import { ApiErrorCallout, Sheet } from "../kit/ui.tsx"
import {
  type BulkAction,
  type BulkTarget,
  bulkBody,
  bulkDoing,
  bulkDoneTitle,
  type ContactsSearch,
  MAX_BULK_IDS,
  readAction,
  viewFilter,
} from "./logic.ts"
import { type BulkAnswer, bulkJobQuery } from "./queries.ts"

export type BulkKind = "addTopic" | "removeTopic" | "unsubscribe" | "delete"

export function BulkBar({
  count,
  all,
  total,
  onAll,
  onPage,
  onAction,
}: {
  count: number
  all: boolean
  total: number | null
  onAll: () => void
  onPage: () => void
  onAction: (k: BulkKind) => void
}) {
  return (
    <section
      className={`bulkbar${all ? " is-all" : ""}`}
      aria-label="Bulk actions"
      data-endpoint="POST /v1/contacts/bulk {ids | filter, action}"
      data-od-id="bulk-bar"
    >
      {all ? (
        <span>
          <b>All {fmtInt(total)}</b> matching this view
        </span>
      ) : (
        <span>
          <b>{fmtInt(count)}</b> selected
        </span>
      )}
      <span className="bulk-all grow">
        ·{" "}
        {all ? (
          <button type="button" className="link" onClick={onPage} style={{ color: "inherit", minHeight: 32 }}>
            Only this page
          </button>
        ) : total !== null && total > count ? (
          <button
            type="button"
            className="link"
            onClick={onAll}
            data-od-id="select-all-matching"
            style={{ color: "inherit", minHeight: 32 }}
          >
            Select all {fmtInt(total)} contacts
          </button>
        ) : (
          "every contact on this page"
        )}
      </span>
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => onAction("addTopic")}>
        <Icon name="tag" />
        Add to topic
      </button>
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => onAction("removeTopic")}>
        Remove from topic
      </button>
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => onAction("unsubscribe")}>
        Unsubscribe
      </button>
      <span className="bb-sep" aria-hidden="true" />
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => onAction("delete")}>
        <Icon name="trash" />
        Delete
      </button>
    </section>
  )
}

export type BulkOutcome =
  | {
      mode: "sync"
      action: BulkAction
      of: number
      updated: number
      skipped: number
      errors: { id: string; message: string }[]
    }
  | { mode: "async"; jobId: string }

export function BulkSheet({
  kind,
  target,
  count,
  topics,
  search,
  onDone,
  onClose,
}: {
  kind: BulkKind
  target: BulkTarget
  count: number
  topics: Topic[]
  search: ContactsSearch
  onDone: (o: BulkOutcome) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const id = useId()
  const live = topics.filter((t) => !t.archived)
  const [topicId, setTopicId] = useState(live[0]?.id ?? "")
  const action: BulkAction =
    kind === "addTopic"
      ? { action: "addTopic", topicId }
      : kind === "removeTopic"
        ? { action: "removeTopic", topicId }
        : kind === "unsubscribe"
          ? { action: "setStatus", status: "unsubscribed" }
          : { action: "delete" }
  const body = bulkBody(target, action)
  const run = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/contacts/bulk", { body: body as never })) as Promise<BulkAnswer>,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["contacts"] })
      if (r && "job" in r && r.mode === "async") onDone({ mode: "async", jobId: r.job.id })
      else if (r && "updated" in r)
        onDone({
          mode: "sync",
          action,
          of: count,
          updated: num(r.updated) ?? 0,
          skipped: num(r.skipped) ?? 0,
          errors: r.errors,
        })
    },
  })
  const n = plural(count, "contact")
  const topic = topics.find((t) => t.id === topicId)
  const title =
    kind === "addTopic"
      ? `Add ${n} to a topic`
      : kind === "removeTopic"
        ? `Remove ${n} from a topic`
        : kind === "unsubscribe"
          ? `Unsubscribe ${n}?`
          : `Delete ${n}?`
  const verb =
    kind === "addTopic"
      ? `Add ${n}`
      : kind === "removeTopic"
        ? `Remove ${n}`
        : kind === "unsubscribe"
          ? `Unsubscribe ${n}`
          : `Delete ${n}`
  const filterText = JSON.stringify(viewFilter(search))
  return (
    <Sheet
      title={title}
      sub={
        target.kind === "filter" ? (
          <>
            Everyone matching{" "}
            <span className="mono">{filterText === "{}" ? "every contact" : filterText}</span>, across every
            page.
          </>
        ) : (
          "The contacts ticked on this page."
        )
      }
      onClose={onClose}
      odId="bulk-sheet"
      endpoint="POST /v1/contacts/bulk {ids | filter, action}"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${kind === "delete" ? "btn-danger" : "btn-primary"}${run.isPending ? " is-loading" : ""}`}
            type="button"
            data-od-id="start-bulk"
            disabled={run.isPending || ((kind === "addTopic" || kind === "removeTopic") && !topicId)}
            onClick={() => run.mutate()}
          >
            {run.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            {verb}
          </button>
        </>
      }
    >
      {kind === "addTopic" || kind === "removeTopic" ? (
        live.length ? (
          <div className="field">
            <label className="label" htmlFor={`${id}-t`}>
              Topic
            </label>
            <select
              className="select"
              id={`${id}-t`}
              value={topicId}
              onChange={(e) => setTopicId(e.target.value)}
            >
              {live.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.doubleOptIn ? " · double opt-in" : ""}
                </option>
              ))}
            </select>
            {kind === "addTopic" && topic?.doubleOptIn ? (
              <span className="hint">
                Double opt-in: Mailyard emails each new subscriber a confirmation first.
              </span>
            ) : null}
          </div>
        ) : (
          <div className="callout callout-info">
            <Icon name="info" />
            <span>
              No topics yet. <Link to="/audience/topics">Create one</Link> first.
            </span>
          </div>
        )
      ) : null}
      <ul className="role-list">
        {count > MAX_BULK_IDS || target.kind === "filter" ? (
          <li>
            <Icon name="info" />
            {count > MAX_BULK_IDS
              ? "More than 1,000 match, so this runs as a background job, 500 contacts at a time. You can leave this page; the job keeps going and its progress stays here."
              : "Up to 1,000 contacts the answer comes straight back, with the reason for each one skipped."}
          </li>
        ) : null}
        {target.kind === "filter" ? (
          <li>
            <Icon name="info" />
            The filter is read again on each page, so a contact the action moves out of the filter isn’t met
            twice.
          </li>
        ) : null}
        {kind === "addTopic" ? (
          <li>
            <Icon name="info" />
            Bounced, complained and suppressed contacts are skipped with their reason: mail to them wouldn’t
            arrive.
          </li>
        ) : null}
        {kind === "delete" ? (
          <li>
            <Icon name="warn" />
            Deleting removes the contacts and their topics for good. Their suppressions stay, so a re-import
            can’t mail someone who bounced or complained.
          </li>
        ) : null}
        {kind === "unsubscribe" ? (
          <li>
            <Icon name="info" />
            They stop getting campaigns; transactional mail still reaches them.
          </li>
        ) : null}
      </ul>
      <div className="urlline">
        <Icon name="code" />
        <code className="mono" style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>
          {JSON.stringify(body)}
        </code>
      </div>
      {run.isError ? <ApiErrorCallout error={run.error} what="Nothing was changed." /> : null}
    </Sheet>
  )
}

export function BulkResult({
  outcome,
  topics,
  onDismiss,
}: {
  outcome: Extract<BulkOutcome, { mode: "sync" }>
  topics: Topic[]
  onDismiss: () => void
}) {
  const topic =
    "topicId" in outcome.action
      ? topics.find((t) => t.id === (outcome.action as { topicId: string }).topicId)?.name
      : undefined
  return (
    <div
      className="bulk-result"
      role="status"
      data-od-id="bulk-result"
      data-endpoint="POST /v1/contacts/bulk → mode: sync"
    >
      <div className="spread">
        <span className="cluster">
          <Icon name="check-circle" />
          <b>{bulkDoneTitle(outcome.action, outcome.updated, outcome.of, topic)}</b>
          {outcome.skipped ? <span className="muted">· {fmtInt(outcome.skipped)} skipped</span> : null}
        </span>
        <button className="icon-btn" type="button" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="x" />
        </button>
      </div>
      <p className="hint">
        Up to 1,000 contacts the answer comes straight back: updated, skipped and the reason for each skip.
      </p>
      <SkipList errors={outcome.errors} total={outcome.skipped} kept={outcome.errors.length} />
    </div>
  )
}

function SkipList({
  errors,
  total,
  kept,
}: {
  errors: { id: string; message: string }[]
  total: number
  kept: number
}) {
  const [all, setAll] = useState(false)
  if (!errors.length) return null
  const shown = all ? errors : errors.slice(0, 6)
  return (
    <div className="stack stack-8">
      <span className="label">Skipped, with the reason</span>
      <ul className="list bulk-errs">
        {shown.map((e) => (
          <li key={e.id} className="list-row">
            <span className="grow" style={{ minWidth: 0 }}>
              <Link
                className="row-title mono"
                to="/audience/contacts/$contactId"
                params={{ contactId: e.id }}
              >
                {e.id}
              </Link>
              <span className="row-sub" style={{ whiteSpace: "normal" }}>
                {e.message}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">
        Showing {fmtInt(shown.length)} of {total > kept ? `the ${fmtInt(kept)} the job kept` : fmtInt(total)}.
        {total > kept
          ? ` It keeps the first ${fmtInt(kept)} reasons only, so ${fmtInt(total - kept)} more skipped contacts aren’t listed; filter the list by status to find them.`
          : ""}
        {errors.length > 6 ? (
          <>
            {" "}
            <button type="button" className="link" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${fmtInt(errors.length)}`}
            </button>
          </>
        ) : null}
      </p>
    </div>
  )
}

export function BulkJob({ id, topics, onDismiss }: { id: string; topics: Topic[]; onDismiss: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({
    ...bulkJobQuery(id),
    refetchInterval: (query) => {
      const s = query.state.data?.status
      if (s === "done" || s === "failed") return false
      return 5000
    },
  })
  const job = q.data
  const status = job?.status
  useEffect(() => {
    if (status === "done" || status === "failed") qc.invalidateQueries({ queryKey: ["contacts", "list"] })
  }, [status, qc])
  if (!job)
    return (
      <section className="bulk-job is-queued" aria-busy={q.isPending} data-od-id="bulk-job">
        {q.isError ? (
          <ApiErrorCallout error={q.error} what="The bulk job didn’t load." />
        ) : (
          <div className="stack stack-8" aria-hidden="true">
            <span className="sk sk-title" />
            <span className="sk sk-bar" />
          </div>
        )}
      </section>
    )
  const action = readAction(job.action)
  const topic = action && "topicId" in action ? topics.find((t) => t.id === action.topicId)?.name : undefined
  const total = num(job.total) ?? 0
  const processed = num(job.processed) ?? 0
  const updated = num(job.updated) ?? 0
  const skipped = num(job.skipped) ?? 0
  const pct = total > 0 ? Math.min(100, (processed / total) * 100) : job.status === "done" ? 100 : 0
  const title =
    job.status === "queued"
      ? "Waiting to start"
      : job.status === "running"
        ? `${bulkDoing(action, topic)}: ${fmtInt(processed)} of ${fmtInt(total)}`
        : job.status === "done"
          ? action
            ? bulkDoneTitle(action, updated, total, topic)
            : `Done: ${fmtInt(updated)} of ${fmtInt(total)}`
          : `Stopped after ${fmtInt(processed)} of ${fmtInt(total)}`
  const pill =
    job.status === "queued"
      ? ["pill-neutral", "Queued"]
      : job.status === "running"
        ? ["pill-info", "Running"]
        : job.status === "done"
          ? ["pill-pass", "Done"]
          : ["pill-fail", "Failed"]
  return (
    <section
      className={`bulk-job is-${job.status}`}
      aria-labelledby={`bj-${job.id}`}
      data-od-id="bulk-job"
      data-endpoint={`GET /v1/contacts/bulk/${job.id}`}
    >
      <div className="spread">
        <span className="cluster">
          <Icon
            name={job.status === "failed" ? "x-circle" : job.status === "done" ? "check-circle" : "clock"}
          />
          <h2 className="t-h3" id={`bj-${job.id}`}>
            {title}
          </h2>
          <span className={`pill ${pill[0]}`}>
            <span className="dot" />
            {pill[1]}
          </span>
        </span>
        <span className="cluster">
          <code className="mono muted">{job.id}</code>
        </span>
      </div>
      <div
        className={`progress${job.status === "failed" ? " is-paused" : ""}`}
        role="progressbar"
        aria-valuenow={processed}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Processed"
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="bulk-stats">
        <div>
          <span className="bs-l">Processed</span>
          <b>{fmtInt(processed)}</b>
        </div>
        <div>
          <span className="bs-l">Updated</span>
          <b>{fmtInt(updated)}</b>
        </div>
        <div>
          <span className="bs-l">Skipped</span>
          <b>{fmtInt(skipped)}</b>
        </div>
        <div>
          <span className="bs-l">Matched at the start</span>
          <b>{fmtInt(total)}</b>
        </div>
      </div>
      {job.status === "queued" ? (
        <p className="hint">The job is queued; it starts within a minute. Nothing has changed yet.</p>
      ) : job.status === "running" ? (
        <p className="hint" role="status">
          Checking every 5 s. You can leave this page; the job keeps going.
        </p>
      ) : job.status === "done" ? (
        <p className="hint">
          Finished {fmtAgo(job.finishedAt)}. The filter is read again on each page, so the processed count can
          differ from the count at the start.
        </p>
      ) : (
        <>
          <div className="callout callout-error" role="alert">
            <Icon name="x-circle" />
            <span>
              The job’s <code className="mono">error</code>: <b>{job.error ?? "The bulk action failed."}</b>
            </span>
          </div>
          <p className="hint">
            Contacts already processed keep the change; nothing is rolled back. Run it again: the filter skips
            nobody twice, since the ones already changed stay changed.
          </p>
        </>
      )}
      <SkipList errors={job.errors} total={skipped} kept={job.errors.length} />
      <div className="cluster">
        {job.status === "done" || job.status === "failed" ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
    </section>
  )
}

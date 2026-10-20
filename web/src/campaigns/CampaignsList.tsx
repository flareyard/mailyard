/**
 * Campaigns (design: campaigns.html, -empty, -loading, -error, -viewer; GAPS-audience A7.1–A7.2). The tabs read
 * `GET /v1/campaigns/counts`; the rows read `GET /v1/campaigns?status=&cursor=`, each with its `summary` counts,
 * "—" while the summary is null. The status tab is the URL. New campaign and Duplicate are `POST /v1/campaigns`.
 */
import "./campaigns.css"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { fieldError } from "../audience/kit/format.ts"
import { allTopicsQuery, identitiesQuery, segmentsQuery } from "../audience/kit/queries.ts"
import {
  ApiErrorCallout,
  EmptyState,
  FieldError,
  PageHead,
  Sheet,
  SkeletonRows,
  StatusPill,
  useCan,
} from "../audience/kit/ui.tsx"
import { Gated } from "../auth/NoPermission.tsx"
import { fmtInt } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { PanelError } from "../ui/Panel.tsx"
import {
  audienceLine,
  campaignHref,
  LIST_TABS,
  recipientsLine,
  sendTimeLabel,
  sentPct,
  statusSub,
} from "./logic.ts"
import { type CampaignListItem, countsQuery, type ListStatus, listQuery } from "./queries.ts"
import { AppLink } from "./ui.tsx"

const EMPTY_TAB: Record<string, string> = {
  active: "Nothing is scheduled, sending or paused.",
  draft: "No drafts.",
  scheduled: "Nothing is scheduled.",
  sending: "Nothing is sending right now.",
  paused: "Nothing is paused.",
  sent: "Nothing has been sent yet.",
  cancelled: "No cancelled campaigns.",
}

export function CampaignsList({
  status,
  cursor,
}: {
  status: ListStatus | undefined
  cursor: string | undefined
}) {
  const counts = useQuery(countsQuery)
  const list = useQuery(listQuery(status, cursor))
  const segments = useQuery(segmentsQuery)
  const topics = useQuery(allTopicsQuery)
  const write = useCan("campaigns.write", "run campaigns")
  const [creating, setCreating] = useState(false)
  const segName = (id: string | null) => segments.data?.find((s) => s.id === id)?.name
  const topicName = (id: string | null) => topics.data?.find((t) => t.id === id)?.name
  const viewer = write.me?.role === "viewer" || !write.allowed

  const newButton = (
    <Gated
      allowed={write.allowed}
      reason={write.me?.role === "viewer" ? "Viewers can’t create campaigns" : "You can’t create campaigns"}
      who={
        write.me?.role === "viewer"
          ? "Owners, admins and senders run campaigns. Viewers read reports."
          : write.who
      }
      side="right"
    >
      <button
        className="btn btn-primary btn-sm"
        type="button"
        data-od-id="new-campaign"
        data-endpoint="POST /v1/campaigns"
        onClick={() => setCreating(true)}
      >
        <Icon name="plus" />
        New campaign
      </button>
    </Gated>
  )

  return (
    <>
      <PageHead
        title="Campaigns"
        sub="Broadcasts to a segment or topic: drafts, what’s scheduled, what’s going out and how sent ones did."
        actions={newButton}
      />
      <nav
        className="au-tabs"
        aria-label="Filter by status"
        data-od-id="status-tabs"
        data-endpoint="GET /v1/campaigns/counts"
      >
        {LIST_TABS.map((t) => (
          <AppLink
            key={t.label}
            className="au-tab"
            href={t.status ? `/campaigns?status=${t.status}` : "/campaigns"}
            aria-current={t.status === status ? "page" : undefined}
          >
            {t.label}
            {counts.data ? <span className="au-n">{fmtInt(counts.data[t.count])}</span> : null}
          </AppLink>
        ))}
      </nav>
      {viewer && write.me?.role === "viewer" ? (
        <div className="callout callout-info" style={{ marginBottom: 12 }}>
          <Icon name="info" />
          <span>
            <b>Read-only.</b> Viewers can open every report. Creating, editing, sending and pausing campaigns
            is for owners, admins and senders.
          </span>
        </div>
      ) : null}
      <section
        className={`panel${list.isError ? " is-error" : ""}`}
        data-endpoint="GET /v1/campaigns?status=&cursor= · summary"
        data-od-id="panel-campaigns"
        aria-labelledby="h-campaigns"
        aria-busy={list.isPending}
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-campaigns">
            Campaigns
          </h2>
        </header>
        <div className="panel-body">
          {list.isPending ? (
            <SkeletonRows rows={7} cols={6} />
          ) : list.isError ? (
            <PanelError error={list.error} onRetry={() => list.refetch()} what="Campaigns didn’t load" />
          ) : list.data.campaigns.length === 0 ? (
            status ? (
              <EmptyState icon="campaigns" title={EMPTY_TAB[status] ?? "Nothing here."}>
                <Link className="link" to="/campaigns" search={{}}>
                  See every campaign
                </Link>
              </EmptyState>
            ) : (
              <EmptyState
                icon="campaigns"
                title="No campaigns yet"
                action={
                  write.allowed ? (
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      onClick={() => setCreating(true)}
                    >
                      <Icon name="plus" />
                      Create one
                    </button>
                  ) : undefined
                }
              >
                A campaign is one email to a segment or topic, checked before it goes and paced to your daily
                quota.
              </EmptyState>
            )
          ) : (
            <>
              <div className="table-wrap desk-only">
                <table className="table dt" data-od-id="campaigns-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Status</th>
                      <th>Audience</th>
                      <th>Send time</th>
                      <th className="r">Sent</th>
                      <th className="r">Delivered</th>
                      <th className="r">Opened</th>
                      <th className="r">Clicked</th>
                      <th className="r">Bounced</th>
                      <th className="r">Unsubscribed</th>
                      <th className="r">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.campaigns.map((c) => (
                      <Row
                        key={c.id}
                        c={c}
                        audience={audienceLine(c, {
                          segment: segName(c.segmentId),
                          topic: topicName(c.topicId),
                        })}
                        canWrite={write.allowed}
                        who={
                          write.me?.role === "viewer"
                            ? "Owners, admins and senders run campaigns. Viewers read reports."
                            : write.who
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="list phone-only" aria-label="Campaigns">
                {list.data.campaigns.map((c) => (
                  <li key={c.id}>
                    <Link className="mrow" to={campaignHref(c.id, c.status)}>
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="m-name">{c.name}</span>
                        <span className="m-mail cmp-m-sub">
                          {statusSub(c) ?? sendTimeLabel(c)}
                          {c.summary ? ` · ${fmtInt(c.summary.sent)} sent` : ""}
                        </span>
                      </span>
                      <StatusPill status={c.status} />
                    </Link>
                  </li>
                ))}
              </ul>
              {list.data.nextCursor ? (
                <div className="dt-foot">
                  <span>{fmtInt(list.data.campaigns.length)} shown</span>
                  <Link
                    className="btn btn-secondary btn-sm"
                    to="/campaigns"
                    search={{ ...(status ? { status } : {}), cursor: list.data.nextCursor }}
                  >
                    Next page
                    <Icon name="chevron-right" />
                  </Link>
                </div>
              ) : null}
              <p className="hint" style={{ marginTop: 12 }}>
                Counts from each campaign’s <code className="mono">summary</code>, which stays “—” until it
                starts. Opened includes machine opens from Apple Mail Privacy Protection; each report shows
                them apart, with rates once a campaign has 100 sends.
              </p>
            </>
          )}
        </div>
      </section>
      {creating ? <NewCampaignSheet onClose={() => setCreating(false)} /> : null}
    </>
  )
}

function Row({
  c,
  audience,
  canWrite,
  who,
}: {
  c: CampaignListItem
  audience: string
  canWrite: boolean
  who: string
}) {
  const s = c.summary
  const sub = statusSub(c)
  const showBar = c.status === "sending" || c.status === "paused"
  const pct = sentPct(s?.sent, c.audienceSize)
  return (
    <tr>
      <td>
        <Link className="cell-link" to={campaignHref(c.id, c.status)}>
          {c.name}
        </Link>
        <span className="cell-sub">
          {c.subject}
          {c.subjectB ? " · A/B" : ""}
        </span>
      </td>
      <td>
        <StatusPill status={c.status} />
        {sub ? <span className="cell-sub">{sub}</span> : null}
        {showBar ? (
          <div
            className={`progress${c.status === "paused" ? " is-paused" : ""}`}
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemax={100}
            aria-label="Sent"
            style={{ marginTop: 6, minWidth: 96 }}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
        ) : null}
      </td>
      <td>
        {audience}
        <span className="cell-sub">{recipientsLine(c.audienceSize)}</span>
      </td>
      <td>{c.status === "draft" ? <span className="muted">Not scheduled</span> : sendTimeLabel(c)}</td>
      {s ? (
        <>
          <td className="r">{fmtInt(s.sent)}</td>
          <td className="r">{fmtInt(s.delivered)}</td>
          <td className="r">{fmtInt(s.opened)}</td>
          <td className="r">{fmtInt(s.clicked)}</td>
          <td className="r">{fmtInt(s.bounced)}</td>
          <td className="r">{fmtInt(s.unsubscribed)}</td>
        </>
      ) : (
        <td className="r muted" colSpan={6} title="summary is null until the campaign starts">
          —
        </td>
      )}
      <td className="r">
        <DuplicateButton c={c} canWrite={canWrite} who={who} />
      </td>
    </tr>
  )
}

/** The copy fields a duplicate carries: everything about the email and its audience, none of its history. */
export function copyOf(c: CampaignListItem) {
  return {
    name: `Copy of ${c.name}`.slice(0, 200),
    fromAddress: c.fromAddress,
    subject: c.subject,
    segmentId: c.segmentId,
    topicId: c.topicId,
    templateId: c.templateId,
    bodyHtml: c.bodyHtml,
    bodyText: c.bodyText,
    bodyBlocks: c.bodyBlocks,
    replyTo: c.replyTo,
    subjectB: c.subjectB,
    preheader: c.preheader,
    ab: c.ab,
    trackOpens: c.trackOpens,
    trackClicks: c.trackClicks,
    timezone: c.timezone,
    exclude: c.exclude,
  }
}

function DuplicateButton({ c, canWrite, who }: { c: CampaignListItem; canWrite: boolean; who: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const dup = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/campaigns", { body: copyOf(c) })),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["campaigns"] })
      if (res && "id" in res)
        void navigate({ to: "/campaigns/$campaignId/content", params: { campaignId: res.id } })
    },
  })
  return (
    <span className="cluster" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
      {dup.isError ? (
        <span className="t-small" role="alert" style={{ color: "var(--red-900)" }}>
          Not copied
        </span>
      ) : null}
      <Gated allowed={canWrite} reason="You can’t duplicate campaigns" who={who} side="right">
        <button
          className={`btn btn-ghost btn-sm${dup.isPending ? " is-loading" : ""}`}
          type="button"
          data-endpoint={`POST /v1/campaigns (copy of ${c.id})`}
          data-od-id={`dup-${c.id}`}
          onClick={() => dup.mutate()}
          title={dup.isError && dup.error instanceof Error ? dup.error.message : undefined}
        >
          {dup.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="copy" />}
          Duplicate
        </button>
      </Gated>
    </span>
  )
}

function NewCampaignSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const identities = useQuery(identitiesQuery)
  const [name, setName] = useState("")
  const [subject, setSubject] = useState("")
  const [from, setFrom] = useState<string | null>(null)
  const ids = identities.data ?? []
  const fromValue =
    from ??
    (ids[0] ? (ids[0].displayName ? `${ids[0].displayName} <${ids[0].address}>` : ids[0].address) : "")
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/campaigns", {
          body: { name: name.trim(), subject: subject.trim(), fromAddress: fromValue },
        }),
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["campaigns"] })
      if (res && "id" in res) {
        onClose()
        void navigate({ to: "/campaigns/$campaignId/content", params: { campaignId: res.id } })
      }
    },
  })
  const nameErr =
    fieldError(create.error, "name") ?? (create.isError && !name.trim() ? "Give it a name." : null)
  const subjErr = fieldError(create.error, "subject")
  const fromErr = fieldError(create.error, "fromAddress")
  const other = create.isError && !nameErr && !subjErr && !fromErr
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !subject.trim() || !fromValue) return
    create.mutate()
  }
  return (
    <Sheet
      title="New campaign"
      sub="A draft to write, aim and check. Nothing sends until you schedule it."
      onClose={onClose}
      endpoint="POST /v1/campaigns"
      odId="new-campaign-sheet"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn btn-primary${create.isPending ? " is-loading" : ""}`}
            type="submit"
            form="new-campaign-form"
            disabled={create.isPending || !name.trim() || !subject.trim() || !fromValue}
          >
            {create.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            Create the draft
          </button>
        </>
      }
    >
      <form id="new-campaign-form" className="stack stack-16" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor="nc-name">
            Name <span className="opt">only you see it</span>
          </label>
          <input
            className="input"
            id="nc-name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            placeholder="November live sessions"
            {...(nameErr ? { "aria-invalid": true, "aria-describedby": "nc-name-err" } : {})}
          />
          {nameErr ? <FieldError id="nc-name-err">{nameErr}</FieldError> : null}
        </div>
        <div className="field">
          <label className="label" htmlFor="nc-from">
            From
          </label>
          {identities.isPending ? (
            <span className="sk sk-text" style={{ height: 36 }} />
          ) : ids.length ? (
            <select
              className="select mono"
              id="nc-from"
              value={fromValue}
              onChange={(e) => setFrom(e.target.value)}
              {...(fromErr ? { "aria-invalid": true, "aria-describedby": "nc-from-err" } : {})}
            >
              {ids.map((i) => {
                const v = i.displayName ? `${i.displayName} <${i.address}>` : i.address
                return (
                  <option key={`${i.mailboxId}-${i.address}`} value={v}>
                    {v}
                  </option>
                )
              })}
            </select>
          ) : (
            <input
              className="input mono"
              id="nc-from"
              value={from ?? ""}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="Coursified <news@news.coursified.app>"
            />
          )}
          {fromErr ? <FieldError id="nc-from-err">{fromErr}</FieldError> : null}
          <span className="hint">An address on a sending domain. You can change it in the editor.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="nc-subj">
            Subject
          </label>
          <input
            className="input"
            id="nc-subj"
            value={subject}
            maxLength={998}
            onChange={(e) => setSubject(e.target.value)}
            {...(subjErr ? { "aria-invalid": true, "aria-describedby": "nc-subj-err" } : {})}
          />
          {subjErr ? <FieldError id="nc-subj-err">{subjErr}</FieldError> : null}
        </div>
        {other ? <ApiErrorCallout error={create.error} what="The draft wasn’t created." /> : null}
      </form>
    </Sheet>
  )
}

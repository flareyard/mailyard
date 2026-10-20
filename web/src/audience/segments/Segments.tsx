/**
 * Audience → Segments (design: segments.html, segments-delete-blocked.html, segments-empty.html,
 * segments-loading.html, segments-error.html; GAPS-audience A3.3). `GET /v1/segments` with each segment's
 * count and `usedBy`. Duplicate is `POST /v1/segments` with the same rules; Delete is disabled while anything
 * uses the segment, and a 409 `in-use` from a stale list opens the sheet that says who.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { AudienceHead } from "../AudienceHead.tsx"
import { fmtAgoShort } from "../kit/format.ts"
import { allTopicsQuery, fieldLabel, fieldsQuery, type Segment, segmentsQuery } from "../kit/queries.ts"
import { ApiErrorCallout, SkeletonRows, useCan } from "../kit/ui.tsx"
import { DeleteBlockedSheet, DeleteConfirmSheet, usedByHref } from "./DeleteBlocked.tsx"
import { type Names, ruleSummary } from "./logic.ts"
import { campaignNamesQuery } from "./queries.ts"

export function SegmentsPage() {
  const q = useQuery(segmentsQuery)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const write = useCan("contacts.write", "build and delete segments")
  const topics = useQuery(allTopicsQuery)
  const campaigns = useQuery(campaignNamesQuery)
  const fields = useQuery(fieldsQuery)
  const names: Names = {
    topic: (id) => topics.data?.find((t) => t.id === id)?.name,
    campaign: (id) => campaigns.data?.find((c) => c.id === id)?.name,
    field: (k) =>
      fieldLabel(
        fields.data?.find((f) => f.key === k),
        k,
      ),
  }
  const [deleting, setDeleting] = useState<Segment | null>(null)
  const [blocked, setBlocked] = useState<{ seg: Segment; error: ApiError } | null>(null)

  const duplicate = useMutation({
    mutationFn: (s: Segment) =>
      unwrap(
        api.POST("/v1/segments", { body: { name: `${s.name} (copy)`.slice(0, 100), filter: s.filter } }),
      ),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["segments"] })
      if (s && "id" in s) navigate({ to: `/audience/segments/${s.id}` as string })
    },
  })
  const del = useMutation({
    mutationFn: (s: Segment) => unwrap(api.DELETE("/v1/segments/{id}", { params: { path: { id: s.id } } })),
    onSuccess: () => {
      setDeleting(null)
      qc.invalidateQueries({ queryKey: ["segments"] })
    },
    onError: (e, s) => {
      if (e instanceof ApiError && e.status === 409) {
        setDeleting(null)
        setBlocked({ seg: s, error: e })
        qc.invalidateQueries({ queryKey: ["segments"] })
      }
    },
  })

  const newButton = (label: string, icon: "plus" | "filter" = "plus") => (
    <Gated allowed={write.allowed} reason="You can’t build segments" who={write.who} side="right">
      <Link className="btn btn-primary btn-sm" to="/audience/segments/new" data-od-id="new-segment">
        <Icon name={icon} />
        {label}
      </Link>
    </Gated>
  )

  // After a refused delete the list refetches; the sheet lists the users the fresh list knows about.
  const fresh = blocked ? q.data?.find((s) => s.id === blocked.seg.id) : undefined

  return (
    <>
      <AudienceHead
        current="segments"
        sub="Saved rules over fields, topics, status, events and email activity. Counts stay live."
        actions={newButton("New segment")}
      />
      <Panel
        id="segments"
        title="Segments"
        endpoint="GET /v1/segments · usedBy"
        query={q}
        meta={q.data?.length ? `${q.data.length} saved` : undefined}
        skeleton={<SkeletonRows rows={5} cols={5} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <div className="empty" data-od-id="empty-state">
            <span className="empty-icon">
              <Icon name="filter" />
            </span>
            <h3>No segments yet</h3>
            <p>
              A segment is a saved rule, like “active learners in Lagos who opened October’s update”.
              Campaigns and automations target segments.
            </p>
            {newButton("Build a segment", "filter")}
          </div>
        }
      >
        {(list) => (
          <>
            <div className="table-wrap desk-only">
              <table className="table dt" data-od-id="segments-table">
                <thead>
                  <tr>
                    <th>Segment</th>
                    <th className="r">Matches</th>
                    <th>Used by</th>
                    <th className="r">Counted</th>
                    <th className="r">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link className="cell-link" to={`/audience/segments/${s.id}` as string}>
                          {s.name}
                        </Link>
                        <span className="cell-sub">{ruleSummary(s.filter, names)}</span>
                      </td>
                      <td className="r">
                        {num(s.count) === null ? (
                          <span className="pill pill-neutral">
                            <span className="spinner" aria-hidden="true" style={{ width: 10, height: 10 }} />
                            Counting
                          </span>
                        ) : (
                          <b>{fmtInt(s.count)}</b>
                        )}
                      </td>
                      <td>
                        {s.usedBy.length ? (
                          <span className="used-by">
                            {s.usedBy.map((u) => (
                              <Link key={`${u.type}-${u.id}`} className="ttag used-chip" to={usedByHref(u)}>
                                <Icon name={u.type === "campaign" ? "campaigns" : "automations"} />
                                {u.name}
                              </Link>
                            ))}
                          </span>
                        ) : (
                          <span className="muted">Not used yet</span>
                        )}
                      </td>
                      <td className="r">{s.countedAt === null ? "—" : fmtAgoShort(s.countedAt)}</td>
                      <td className="r">
                        <span className="cluster" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                          <Gated
                            allowed={write.allowed}
                            reason="You can’t build segments"
                            who={write.who}
                            side="right"
                          >
                            <button
                              className="btn btn-ghost btn-sm"
                              type="button"
                              disabled={duplicate.isPending}
                              onClick={() => duplicate.mutate(s)}
                              data-endpoint="POST /v1/segments"
                            >
                              Duplicate
                            </button>
                          </Gated>
                          <Gated
                            allowed={write.allowed && s.usedBy.length === 0}
                            reason={
                              write.allowed ? "In use, so it can’t be deleted" : "You can’t delete segments"
                            }
                            who={
                              write.allowed
                                ? `Used by ${s.usedBy.map((u) => u.name).join(", ")}. Point them at another segment first.`
                                : write.who
                            }
                            side="right"
                          >
                            <button
                              className="btn btn-ghost btn-sm"
                              type="button"
                              onClick={() => setDeleting(s)}
                              data-endpoint={`DELETE /v1/segments/${s.id}`}
                              data-od-id={`delete-${s.id}`}
                            >
                              <Icon name="trash" />
                              Delete
                            </button>
                          </Gated>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="phone-only">
              <ul className="list">
                {list.map((s) => (
                  <li key={s.id} className="list-row">
                    <span className="grow" style={{ minWidth: 0 }}>
                      <Link className="row-title" to={`/audience/segments/${s.id}` as string}>
                        {s.name}
                      </Link>
                      <span className="row-sub" style={{ whiteSpace: "normal" }}>
                        {num(s.count) === null ? "Counting" : `${fmtInt(s.count)} match`}
                        {s.usedBy.length ? ` · used by ${s.usedBy.length}` : ""}
                      </span>
                    </span>
                    <Icon name="chevron-right" />
                  </li>
                ))}
              </ul>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Used by counts every campaign built on a segment, sent ones too, and automations through their
              draft or live version. A segment in use can’t be deleted.
            </p>
            {duplicate.isError ? (
              <ApiErrorCallout error={duplicate.error} what="The copy wasn’t made." />
            ) : null}
          </>
        )}
      </Panel>
      {deleting ? (
        <DeleteConfirmSheet
          name={deleting.name}
          busy={del.isPending}
          error={
            del.isError && !(del.error instanceof ApiError && del.error.status === 409) ? del.error : null
          }
          onConfirm={() => del.mutate(deleting)}
          onClose={() => {
            setDeleting(null)
            del.reset()
          }}
        />
      ) : null}
      {blocked ? (
        <DeleteBlockedSheet
          name={blocked.seg.name}
          error={blocked.error}
          usedBy={fresh?.usedBy ?? blocked.seg.usedBy}
          onClose={() => setBlocked(null)}
        />
      ) : null}
    </>
  )
}

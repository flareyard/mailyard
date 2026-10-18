/**
 * An automation's runs (design: automation-runs.html, -runs-empty, -run-failed, -run-skipped; GAPS A8.6,
 * A8.7, A8.12). Filters, the cursor and the open run are the URL (`?status=&version=&cursor=&run=`). The run
 * drawer reads `GET /v1/runs/{id}` and shows its step log: failed is solid red and stops; skipped is dashed and
 * neutral and the run goes on. Exit and retry need `automations.write`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { api, unwrap } from "../api/client.ts"
import { AlertRef } from "../audience/kit/AlertRef.tsx"
import { fmtAgoShort, fmtTime, fmtWeekday } from "../audience/kit/format.ts"
import {
  ApiErrorCallout,
  BackLink,
  Drawer,
  EmptyState,
  SampleMarker,
  SkeletonRows,
  StatusPill,
  UrlLine,
  useCan,
} from "../audience/kit/ui.tsx"
import { Gated } from "../auth/NoPermission.tsx"
import { fmtInt, num } from "../lib/format.ts"
import { usePageTitle } from "../shell/title.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError } from "../ui/Panel.tsx"
import { useNames } from "./List.tsx"
import { type Automation, type GNode, type Run, runStepNow, runSummary, stepTitle } from "./logic.ts"
import { automationQuery, runQuery, runsQuery, versionsQuery } from "./queries.ts"
import { AppLink, RunLog } from "./StepLog.tsx"
import "./automations.css"

type Search = { status?: Run["status"]; version?: string; run?: string; cursor?: string; fx?: string }

const STATUSES: Run["status"][] = ["running", "waiting", "completed", "exited", "failed"]

export function Runs({ id, search }: { id: string; search: Search }) {
  const navigate = useNavigate()
  const a = useQuery(automationQuery(id))
  const auto = a.data && "graph" in a.data ? a.data : undefined
  usePageTitle(auto ? `Runs · ${auto.name}` : "Runs")
  const filter = {
    ...(search.status ? { status: search.status } : {}),
    ...(search.version ? { version: search.version } : {}),
    ...(search.cursor ? { cursor: search.cursor } : {}),
  }
  const q = useQuery(runsQuery(id, filter))
  const versions = useQuery(versionsQuery(id))
  const names = useNames()
  const set = (patch: { [K in keyof Search]?: Search[K] | undefined }) => {
    const merged: Record<string, string | undefined> = { ...search, ...patch }
    const next: Search = {}
    for (const [k, v] of Object.entries(merged)) if (v) (next as Record<string, string>)[k] = v
    return navigate({ to: "/automations/$automationId/runs", params: { automationId: id }, search: next })
  }
  const byId = new Map((auto?.graph.nodes ?? []).map((n) => [n.id, n]))
  const statusOf = (v: number) => versions.data?.versions.find((x) => num(x.version) === v)?.status
  const pub = num(auto?.publishedVersion)
  const rows = q.data?.runs ?? []
  const total = num(q.data?.total) ?? 0

  return (
    <>
      <BackLink to={`/automations/${id}`}>{auto?.name ?? "Automation"}</BackLink>
      <div className="obj-head" data-od-id="object-head">
        <div className="oh-main">
          <h1 data-od-id="page-title">Runs</h1>
          <div className="oh-sub">
            <span>{auto?.name ?? <span className="sk sk-text" style={{ width: 120 }} />}</span>
            {auto ? (
              <StatusPill
                status={auto.status}
                label={
                  auto.status === "draft"
                    ? "Draft"
                    : `${auto.status === "live" ? "Live" : "Paused"} · v${pub ?? num(auto.version)}`
                }
              />
            ) : null}
            {auto ? <span>{runSummary(auto)}</span> : null}
          </div>
        </div>
        <div className="oh-actions">
          <SampleMarker />
          <Link
            className="btn btn-secondary btn-sm"
            to="/automations/$automationId"
            params={{ automationId: id }}
          >
            <Icon name="automations" />
            Open builder
          </Link>
        </div>
      </div>
      <section
        className={`panel${q.isError ? " is-error" : ""}`}
        data-endpoint={`GET /v1/automations/${id}/runs?status=&version=&cursor=&limit=`}
        data-od-id="panel-runs"
        aria-labelledby="h-runs"
        aria-busy={q.isPending}
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-runs">
            Runs
          </h2>
        </header>
        <div className="panel-body">
          <div className="stack stack-12">
            <div className="spread">
              <div className="fchips">
                <label className="fchip au-chip">
                  <span className="fk">Status is</span>
                  <select
                    className="au-chipselect"
                    value={search.status ?? ""}
                    onChange={(e) =>
                      set({
                        status: (e.target.value || undefined) as Run["status"] | undefined,
                        cursor: undefined,
                      })
                    }
                  >
                    <option value="">any</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fchip au-chip">
                  <span className="fk">Version is</span>
                  <select
                    className="au-chipselect"
                    value={search.version ?? ""}
                    onChange={(e) => set({ version: e.target.value || undefined, cursor: undefined })}
                  >
                    <option value="">any</option>
                    {(versions.data?.versions ?? []).map((v) => (
                      <option key={String(v.version)} value={String(num(v.version))}>
                        v{num(v.version)} · {v.status}
                      </option>
                    ))}
                    {search.version &&
                    !versions.data?.versions.some((v) => String(num(v.version)) === search.version) ? (
                      <option value={search.version}>v{search.version}</option>
                    ) : null}
                  </select>
                </label>
                {search.status || search.version ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => set({ status: undefined, version: undefined, cursor: undefined })}
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
              <UrlLine />
            </div>
            {q.isPending ? (
              <SkeletonRows rows={6} cols={6} />
            ) : q.isError ? (
              <PanelError error={q.error} onRetry={() => q.refetch()} what="Runs didn’t load" />
            ) : rows.length === 0 ? (
              search.status || search.version ? (
                <EmptyState
                  icon="filter"
                  title="No runs match"
                  action={
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => set({ status: undefined, version: undefined, cursor: undefined })}
                    >
                      Clear filters
                    </button>
                  }
                >
                  Nothing {search.status ? `is ${search.status}` : ""}
                  {search.version ? ` on v${search.version}` : ""} right now.
                </EmptyState>
              ) : (
                <EmptyState
                  icon="automations"
                  title="No runs yet"
                  action={
                    <Link
                      className="btn btn-secondary btn-sm"
                      to="/automations/$automationId"
                      params={{ automationId: id }}
                      search={{ panel: "dry-run" }}
                    >
                      <Icon name="play" />
                      Try a dry run
                    </Link>
                  }
                >
                  Each contact who enters gets a run you can follow step by step.{" "}
                  {auto?.trigger?.kind === "event"
                    ? `Publish the automation and send a ${auto.trigger.event} event to start one.`
                    : "Publish the automation to start one."}
                </EmptyState>
              )
            ) : (
              <>
                <div className="table-wrap">
                  <table className="table dt" data-od-id="runs-table">
                    <thead>
                      <tr>
                        <th>Contact</th>
                        <th>Version</th>
                        <th>Step now</th>
                        <th>Status</th>
                        <th className="r">Entered</th>
                        <th className="r">Next step at</th>
                        <th className="r">
                          <span className="sr-only">Log</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const v = num(r.version) ?? 0
                        const st = statusOf(v)
                        const node = r.nodeId ? byId.get(r.nodeId) : undefined
                        return (
                          <tr key={r.id}>
                            <td>
                              <AppLink
                                className="cell-link mono-cell"
                                href={`/audience/contacts/${encodeURIComponent(r.contactId)}`}
                              >
                                {r.email ?? r.contactId}
                              </AppLink>
                              <span className="cell-sub mono">{r.id}</span>
                            </td>
                            <td>
                              v{v}
                              {st && st !== "live" ? ` · ${st}` : ""}
                            </td>
                            <td>
                              {r.waitingFor ? (
                                <>
                                  Waiting for <span className="mono">{r.waitingFor}</span>
                                </>
                              ) : (
                                runStepNow(r, node, names)
                              )}
                              {r.error ? (
                                <span className="cell-sub" style={{ color: "var(--red-900)" }}>
                                  {r.error}
                                </span>
                              ) : null}
                            </td>
                            <td>
                              <StatusPill status={r.status} />
                            </td>
                            <td className="r">{fmtAgoShort(r.enteredAt)}</td>
                            <td className="r">
                              {r.nextAt ? `${fmtWeekday(r.nextAt).split(" ")[0]} ${fmtTime(r.nextAt)}` : "—"}
                            </td>
                            <td className="r">
                              <Link
                                className="btn btn-ghost btn-sm"
                                to="/automations/$automationId/runs"
                                params={{ automationId: id }}
                                search={{ ...search, run: r.id }}
                              >
                                Log
                              </Link>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="dt-foot">
                  <span>
                    {fmtInt(rows.length)} of {fmtInt(total)} · newest first
                  </span>
                  <span className="cluster cluster-8">
                    {search.cursor ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        onClick={() => set({ cursor: undefined })}
                      >
                        First page
                      </button>
                    ) : null}
                    {q.data?.nextCursor ? (
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={() => set({ cursor: q.data?.nextCursor ?? undefined })}
                      >
                        Next page
                        <Icon name="chevron-right" />
                      </button>
                    ) : null}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
      {search.run ? (
        <RunDrawer runId={search.run} automation={auto} onClose={() => set({ run: undefined })} />
      ) : null}
    </>
  )
}

function RunDrawer({
  runId,
  automation,
  onClose,
}: {
  runId: string
  automation: Automation | undefined
  onClose: () => void
}) {
  const qc = useQueryClient()
  const q = useQuery(runQuery(runId))
  const names = useNames()
  const write = useCan("automations.write", "exit or retry runs")
  const r = q.data && "steps" in q.data ? q.data : undefined
  const nodes: GNode[] = automation?.graph.nodes ?? []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const after = () => {
    qc.invalidateQueries({ queryKey: ["runs", runId] })
    qc.invalidateQueries({ queryKey: ["automations"] })
  }
  const exit = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/runs/{id}/exit", { params: { path: { id: runId } } })),
    onSuccess: after,
  })
  const retry = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/runs/{id}/retry", { params: { path: { id: runId } } })),
    onSuccess: after,
  })
  const failedStep = r?.steps.find((s) => s.outcome === "failed")
  const failedNode = failedStep ? byId.get(failedStep.nodeId) : undefined
  const sentBefore = r?.steps.filter((s) => s.outcome === "sent").length ?? 0
  const finished = r ? ["completed", "exited"].includes(r.status) : true
  const title = !r
    ? "Run"
    : r.status === "failed"
      ? "Run failed at a step"
      : r.steps.some((s) => s.outcome === "skipped")
        ? "Run with a skipped send"
        : `Run ${r.status}`
  return (
    <Drawer
      title={title}
      sub={
        r ? (
          <>
            {r.id} · v{num(r.version)} · <span className="mono">{r.email ?? r.contactId}</span>
          </>
        ) : (
          runId
        )
      }
      onClose={onClose}
      odId="run-drawer"
      endpoint={`GET /v1/runs/${runId}`}
      footer={
        r ? (
          <>
            <AppLink
              className="btn btn-ghost btn-sm"
              href={`/audience/contacts/${encodeURIComponent(r.contactId)}`}
            >
              <Icon name="user" />
              Open contact
            </AppLink>
            <span className="cluster">
              <Link
                className="btn btn-ghost btn-sm"
                to="/automations/$automationId"
                params={{ automationId: r.automationId }}
                search={{ run: r.id }}
              >
                <Icon name="eye" />
                Show on canvas
              </Link>
              {!finished ? (
                <Gated allowed={write.allowed} reason="You can’t exit runs" who={write.who} side="up">
                  <button
                    className={`btn btn-secondary btn-sm${exit.isPending ? " is-loading" : ""}`}
                    type="button"
                    data-endpoint={`POST /v1/runs/${r.id}/exit`}
                    onClick={() => exit.mutate()}
                  >
                    <Icon name="logout" />
                    Exit contact
                  </button>
                </Gated>
              ) : null}
              {r.status === "failed" ? (
                <Gated allowed={write.allowed} reason="You can’t retry runs" who={write.who} side="up">
                  <button
                    className={`btn btn-primary btn-sm${retry.isPending ? " is-loading" : ""}`}
                    type="button"
                    data-endpoint={`POST /v1/runs/${r.id}/retry`}
                    onClick={() => retry.mutate()}
                  >
                    <Icon name="replay" />
                    Retry the step
                  </button>
                </Gated>
              ) : null}
            </span>
          </>
        ) : null
      }
    >
      {q.isPending ? (
        <div className="stack stack-8" aria-hidden="true" style={{ marginTop: 12 }}>
          <span className="sk sk-text" />
          <span className="sk sk-text" />
          <span className="sk sk-text" />
        </div>
      ) : q.isError ? (
        <div style={{ marginTop: 12 }}>
          <PanelError error={q.error} onRetry={() => q.refetch()} what="This run didn’t load" />
        </div>
      ) : r ? (
        <>
          {r.status === "failed" ? (
            <div className="callout callout-error" style={{ margin: "12px 0" }}>
              <Icon name="x-circle" />
              <span>
                <b>{failedNode ? stepTitle(failedNode, {}, names) : (failedStep?.nodeId ?? "A step")}</b> kept
                failing: <span className="mono">{r.error ?? failedStep?.detail}</span> The run stopped there
                {sentBefore
                  ? `; they got ${sentBefore === 1 ? "one email" : `${sentBefore} emails`} before it`
                  : ""}
                .
              </span>
            </div>
          ) : r.steps.some((s) => s.outcome === "skipped") ? (
            <div className="callout callout-warn" style={{ margin: "12px 0" }}>
              <Icon name="info" />
              <span>
                <b>
                  {r.steps.filter((s) => s.outcome === "skipped").length} send
                  {r.steps.filter((s) => s.outcome === "skipped").length === 1 ? " was" : "s were"} skipped.
                </b>{" "}
                No mail went out for{" "}
                {r.steps.filter((s) => s.outcome === "skipped").length === 1 ? "it" : "them"}, and the run
                went on.
              </span>
            </div>
          ) : null}
          <RunLog steps={r.steps} graph={nodes} names={names} contactId={r.contactId} who="the contact" />
          {r.status === "failed" ? (
            <div style={{ marginTop: 12 }}>
              <AlertRef kind="automation_failed" subjectId={r.automationId} />
            </div>
          ) : null}
          {exit.isError ? <ApiErrorCallout error={exit.error} what="The contact wasn’t exited." /> : null}
          {retry.isError ? <ApiErrorCallout error={retry.error} what="The step wasn’t retried." /> : null}
          {retry.isSuccess ? (
            <div className="callout callout-ok" role="status" style={{ marginTop: 12 }}>
              <Icon name="check-circle" />
              <span>Retrying the step now.</span>
            </div>
          ) : null}
        </>
      ) : null}
    </Drawer>
  )
}

/**
 * Automations list (design: automations.html, -empty, -loading, -error, -viewer; GAPS A8.1, A8.9). The range
 * lives in the URL (`?range=`, 7d by default), the summary strip reads the list's own `summary`, and each row
 * pauses or resumes in place. An empty workspace starts from a recipe or a blank canvas (POST /v1/automations).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { api, unwrap } from "../api/client.ts"
import { allTopicsQuery, segmentsQuery, templatesQuery } from "../audience/kit/queries.ts"
import {
  ApiErrorCallout,
  EmptyState,
  PageHead,
  SkeletonRows,
  StatusPill,
  useCan,
} from "../audience/kit/ui.tsx"
import { Gated } from "../auth/NoPermission.tsx"
import { fmtInt, num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { PanelError } from "../ui/Panel.tsx"
import { MonoMeta } from "./Canvas.tsx"
import { type AutomationRow, type Names, triggerSub, versionLine } from "./logic.ts"
import { automationsQuery, RANGE_SHORT, RANGES, type Range } from "./queries.ts"
import { RECIPES, recipeGraph } from "./recipes.ts"
import "./automations.css"

export function useNames(): Names {
  const segs = useQuery(segmentsQuery).data
  const topics = useQuery(allTopicsQuery).data
  const tpls = useQuery(templatesQuery).data
  // The sidebar's own read of the mailboxes (same key), for naming a mail trigger's mailboxes.
  const boxes = useQuery({ queryKey: ["mailboxes"], queryFn: () => unwrap(api.GET("/v1/mailboxes")) }).data as
    | { mailboxes?: { id: string; address: string }[] }
    | undefined
  return {
    mailbox: (id) => {
      const a = boxes?.mailboxes?.find((m) => m.id === id)?.address
      return a ? `${a.slice(0, a.indexOf("@") + 1)}` : undefined
    },
    segment: (id) => segs?.find((s) => s.id === id)?.name,
    topic: (id) => topics?.find((t) => t.id === id)?.name,
    template: (id) => tpls?.find((t) => t.id === id)?.name,
  }
}

export function AutomationsList({ range }: { range: Range }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const q = useQuery(automationsQuery(range))
  const write = useCan("automations.write", "build and run automations")
  const names = useNames()
  const templates = useQuery(templatesQuery).data
  const setRange = (r: Range) => navigate({ to: "/automations", search: r === "7d" ? {} : { range: r } })

  const create = useMutation({
    mutationFn: (recipe: string | null) => {
      const r = recipe ? RECIPES.find((x) => x.id === recipe) : undefined
      return unwrap(
        api.POST("/v1/automations", {
          body: r
            ? {
                name: r.name,
                graph: recipeGraph(r.id, templates?.find((t) => t.publishedVersion !== null)?.id ?? ""),
              }
            : { name: "Untitled automation" },
        }),
      )
    },
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["automations"] })
      if (a && "id" in a) navigate({ to: "/automations/$automationId", params: { automationId: a.id } })
    },
  })

  const data = q.data
  const rows = data?.automations ?? []
  const s = data?.summary
  const short = RANGE_SHORT[range]

  return (
    <>
      <PageHead
        title="Automations"
        sub="Sequences that run on their own: who entered, who finished, what failed."
        actions={
          <>
            {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg is a styled button group */}
            <div className="seg" role="group" aria-label="Range" data-seg>
              {RANGES.map((r) => (
                <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
                  {r}
                </button>
              ))}
            </div>
            <Gated allowed={write.allowed} reason="You can’t create automations" who={write.who} side="right">
              <button
                className={`btn btn-primary btn-sm${create.isPending ? " is-loading" : ""}`}
                type="button"
                data-od-id="new-automation"
                data-endpoint="POST /v1/automations"
                onClick={() => create.mutate(null)}
              >
                <Icon name="plus" />
                New automation
              </button>
            </Gated>
          </>
        }
      />
      {!write.allowed && write.me ? (
        <div className="callout callout-info" style={{ marginBottom: 12 }} data-od-id="read-only">
          <Icon name="info" />
          <span>
            <b>Read-only.</b> You can see how automations are doing. {write.who}
          </span>
        </div>
      ) : null}
      {create.isError ? <ApiErrorCallout error={create.error} what="The automation wasn’t created." /> : null}
      {s && rows.length ? (
        <div
          className="sumstrip"
          data-endpoint={`GET /v1/automations?range=${range} · summary`}
          data-od-id="automations-summary"
        >
          <div>
            <span className="stat-label">Live</span>
            <span className="stat-value">{fmtInt(s.live)}</span>
          </div>
          <div>
            <span className="stat-label">Running now</span>
            <span className="stat-value">{fmtInt(s.activeRuns)}</span>
          </div>
          <div>
            <span className="stat-label">Entered, {short}</span>
            <span className="stat-value">{fmtInt(s.entered)}</span>
          </div>
          <div>
            <span className="stat-label">Completed, {short}</span>
            <span className="stat-value">{fmtInt(s.completed)}</span>
          </div>
          <div>
            <span className="stat-label">Failed, {short}</span>
            <span
              className="stat-value"
              style={(num(s.failed) ?? 0) > 0 ? { color: "var(--red-900)" } : undefined}
            >
              {fmtInt(s.failed)}
            </span>
            {(num(s.failed) ?? 0) > 0 ? <FailuresLink rows={rows} /> : null}
          </div>
        </div>
      ) : null}
      <section
        className={`panel${q.isError ? " is-error" : ""}`}
        data-endpoint={`GET /v1/automations?range=${range}`}
        data-od-id="panel-automations"
        aria-labelledby="h-automations"
        aria-busy={q.isPending}
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-automations">
            Automations
          </h2>
        </header>
        <div className="panel-body">
          {q.isPending ? (
            <SkeletonRows rows={5} cols={6} />
          ) : q.isError ? (
            <PanelError error={q.error} onRetry={() => q.refetch()} what="Automations didn’t load" />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="automations"
              title="No automations yet"
              action={
                <div className="stack" style={{ width: "100%", maxWidth: 760, alignItems: "center" }}>
                  <div className="recipes">
                    {RECIPES.map((r) => (
                      <Gated
                        key={r.id}
                        allowed={write.allowed}
                        reason="You can’t create automations"
                        who={write.who}
                      >
                        <button
                          className="recipe"
                          type="button"
                          style={{ font: "inherit", cursor: "pointer", width: "100%" }}
                          onClick={() => create.mutate(r.id)}
                        >
                          <span className="r-name">{r.name}</span>
                          <span className="r-desc">{r.desc}</span>
                          <span className="r-steps">
                            {r.steps.map((st, i) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: steps repeat by design
                              <span key={i} className="ttag">
                                {st}
                              </span>
                            ))}
                          </span>
                        </button>
                      </Gated>
                    ))}
                  </div>
                  <Gated allowed={write.allowed} reason="You can’t create automations" who={write.who}>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => create.mutate(null)}
                    >
                      <Icon name="plus" />
                      Start blank
                    </button>
                  </Gated>
                </div>
              }
            >
              An automation sends the right email when something happens: a sign-up, a segment, a topic, a
              date. Start from a recipe or a blank canvas.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table dt" data-od-id="automations-table">
                <thead>
                  <tr>
                    <th>Automation</th>
                    <th>Status</th>
                    <th>Version</th>
                    <th className="r">Running</th>
                    <th className="r">Entered</th>
                    <th className="r">Completed</th>
                    <th className="r">Exited</th>
                    <th className="r">Failed</th>
                    <th className="r">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <Row key={a.id} a={a} names={names} canWrite={write.allowed} who={write.who} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  )
}

function FailuresLink({ rows }: { rows: AutomationRow[] }) {
  const worst = [...rows].sort((a, b) => (num(b.failed) ?? 0) - (num(a.failed) ?? 0))[0]
  if (!worst) return null
  return (
    <Link
      className="link-quiet"
      to="/automations/$automationId/runs"
      params={{ automationId: worst.id }}
      search={{ status: "failed" }}
    >
      See failures
      <Icon name="chevron-right" />
    </Link>
  )
}

const STATUS_LABEL: Record<AutomationRow["status"], string> = {
  draft: "Draft",
  live: "Live",
  paused: "Paused",
}

function Row({
  a,
  names,
  canWrite,
  who,
}: {
  a: AutomationRow
  names: Names
  canWrite: boolean
  who: string
}) {
  const qc = useQueryClient()
  const toggle = useMutation({
    mutationFn: () =>
      a.status === "live"
        ? unwrap(api.POST("/v1/automations/{id}/pause", { params: { path: { id: a.id } } }))
        : unwrap(api.POST("/v1/automations/{id}/resume", { params: { path: { id: a.id } } })),
    onSettled: () => qc.invalidateQueries({ queryKey: ["automations"] }),
  })
  const failed = num(a.failed) ?? 0
  return (
    <tr>
      <td>
        <Link className="cell-link" to="/automations/$automationId" params={{ automationId: a.id }}>
          {a.name}
        </Link>
        <span className="cell-sub">
          <MonoMeta
            meta={triggerSub(a.trigger, names)}
            mono={
              a.trigger?.kind === "event"
                ? a.trigger.event
                : a.trigger?.kind === "date"
                  ? a.trigger.field
                  : undefined
            }
          />
        </span>
      </td>
      <td>
        <StatusPill status={a.status} label={STATUS_LABEL[a.status]} />
      </td>
      <td>{versionLine(a)}</td>
      <td className="r num">{fmtInt(a.activeRuns)}</td>
      <td className="r num">{fmtInt(a.entered)}</td>
      <td className="r num">{fmtInt(a.completed)}</td>
      <td className="r num">{fmtInt(a.exited)}</td>
      <td className="r num">
        {failed > 0 ? (
          <Link
            className="link"
            to="/automations/$automationId/runs"
            params={{ automationId: a.id }}
            search={{ status: "failed" }}
            style={{ color: "var(--red-900)" }}
          >
            {fmtInt(failed)}
          </Link>
        ) : (
          "0"
        )}
      </td>
      <td className="r">
        {a.status === "draft" ? (
          <Link
            className="btn btn-ghost btn-sm"
            to="/automations/$automationId"
            params={{ automationId: a.id }}
          >
            Open
          </Link>
        ) : (
          <Gated
            allowed={canWrite}
            reason={`You can’t ${a.status === "live" ? "pause" : "resume"} automations`}
            who={who}
            side="right"
          >
            <button
              className={`btn btn-ghost btn-sm${toggle.isPending ? " is-loading" : ""}`}
              type="button"
              data-endpoint={`POST /v1/automations/${a.id}/${a.status === "live" ? "pause" : "resume"}`}
              onClick={() => toggle.mutate()}
              title={toggle.isError ? (toggle.error as Error).message : undefined}
            >
              <Icon name={a.status === "live" ? "pause" : "play"} />
              {a.status === "live" ? "Pause" : "Resume"}
            </button>
          </Gated>
        )}
      </td>
    </tr>
  )
}

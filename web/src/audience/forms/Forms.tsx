/**
 * Audience → Forms (design: forms.html, forms-empty.html, forms-loading.html, forms-error.html; GAPS-audience
 * A4.1, A4.3). `GET /v1/forms` with each form's topics, fields and Turnstile state, and the last 30 days from
 * `GET /v1/forms/{id}/stats?range=30d`. "New form" creates one with the first topic and opens it.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { AudienceHead } from "../AudienceHead.tsx"
import { allTopicsQuery } from "../kit/queries.ts"
import { ApiErrorCallout, SkeletonRows, useCan } from "../kit/ui.tsx"
import { fieldKeys, resolveDefs, TURNSTILE_PILL, TURNSTILE_UNCHECKED, turnstileState } from "./logic.ts"
import { formStatsQuery, formsQuery } from "./queries.ts"

export function FormsPage() {
  const q = useQuery(formsQuery)
  const topics = useQuery(allTopicsQuery)
  const write = useCan("contacts.write", "create and edit forms")
  const qc = useQueryClient()
  const navigate = useNavigate()
  const stats = useQueries({ queries: (q.data ?? []).map((f) => formStatsQuery(f.id, "30d")) })
  const statsOf = (id: string) => stats[(q.data ?? []).findIndex((f) => f.id === id)]?.data
  const firstTopic = topics.data?.find((t) => !t.archived)

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/forms", {
          body: { name: "Sign up for updates", topicIds: firstTopic ? [firstTopic.id] : [] },
        }),
      ),
    onSuccess: (f) => {
      qc.invalidateQueries({ queryKey: ["forms"] })
      if (f && "id" in f) navigate({ to: `/audience/forms/${f.id}` as string })
    },
  })
  const block = !write.allowed
    ? { reason: "You can’t create forms", who: write.who }
    : !firstTopic && topics.isSuccess
      ? { reason: "Create a topic first", who: "A form subscribes people to at least one topic." }
      : null
  const newButton = (label: string) => (
    <Gated allowed={!block} reason={block?.reason} who={block?.who} side="right">
      <button
        className={`btn btn-primary btn-sm${create.isPending ? " is-loading" : ""}`}
        type="button"
        onClick={() => create.mutate()}
        disabled={create.isPending}
        data-endpoint="POST /v1/forms"
        data-od-id="new-form"
      >
        {create.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" />}
        {label}
      </button>
    </Gated>
  )
  const unchecked = (q.data ?? []).filter(
    (f) => !f.archived && turnstileState(f.turnstile) === "unchecked",
  ).length

  return (
    <>
      <AudienceHead
        current="forms"
        sub={
          <>
            Hosted signup pages at <span className="mono">/f/:formId</span>, with an embed snippet or an
            iframe for your own site, and Turnstile.
          </>
        }
        actions={newButton("New form")}
      />
      {create.isError ? (
        <div style={{ marginBottom: 16 }}>
          <ApiErrorCallout error={create.error} what="The form wasn’t created." />
        </div>
      ) : null}
      <Panel
        id="forms"
        title="Forms"
        endpoint="GET /v1/forms · GET /v1/forms/:id/stats?range=30d"
        query={q}
        skeleton={<SkeletonRows rows={4} cols={7} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <div className="empty" data-od-id="empty-state">
            <span className="empty-icon">
              <Icon name="file" />
            </span>
            <h3>No signup forms yet</h3>
            <p>
              A form is a hosted page that adds people to the topics you pick. Link to it, embed it, or put it
              in an iframe on your own site.
            </p>
            {newButton("Create a form")}
          </div>
        }
      >
        {(list) => (
          <>
            {unchecked ? (
              <div
                className="callout callout-warn"
                role="status"
                style={{ marginBottom: 12 }}
                data-od-id="turnstile-unconfigured"
              >
                <Icon name="warn" />
                <span>
                  <b>{TURNSTILE_UNCHECKED}</b>{" "}
                  {unchecked === 1 ? "One form has" : `${fmtInt(unchecked)} forms have`} a site key, so
                  visitors see the check, but this deploy has no secret to verify it with. Open a form for how
                  to fix it.
                </span>
              </div>
            ) : null}
            <div className="table-wrap desk-only">
              <table className="table dt" data-od-id="forms-table">
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>Subscribes to</th>
                    <th>Fields</th>
                    <th>Turnstile</th>
                    <th className="r">Submissions, 30 d</th>
                    <th className="r">Signed up</th>
                    <th className="r">Refused</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((f) => {
                    const s = statsOf(f.id)
                    const t = TURNSTILE_PILL[turnstileState(f.turnstile)]
                    return (
                      <tr key={f.id}>
                        <td>
                          <Link className="cell-link" to={`/audience/forms/${f.id}` as string}>
                            {f.name}
                          </Link>
                          <span className="cell-sub mono">/f/{f.id}</span>
                        </td>
                        <td>
                          <span className="topic-tags">
                            {f.topicIds.map((id) => (
                              <span key={id} className="ttag">
                                {topics.data?.find((x) => x.id === id)?.name ?? id}
                              </span>
                            ))}
                          </span>
                          {f.topicChoice === "pick" ? <span className="cell-sub">Visitors pick</span> : null}
                        </td>
                        <td>
                          <span className="mono">{fieldKeys(resolveDefs(f)).join(", ")}</span>
                        </td>
                        <td>
                          <span className={`pill ${t.cls}`}>
                            <span className="dot" />
                            {t.label}
                          </span>
                        </td>
                        <td className="r">{s ? fmtInt(s.submissions) : "—"}</td>
                        <td className="r">
                          {s ? fmtInt((num(s.subscribed) ?? 0) + (num(s.confirm) ?? 0)) : "—"}
                        </td>
                        <td className="r">{s ? fmtInt(s.refused) : "—"}</td>
                        <td>
                          <span className={`pill ${f.archived ? "pill-neutral" : "pill-pass"}`}>
                            <span className="dot" />
                            {f.archived ? "Archived" : "Live"}
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
                {list.map((f) => {
                  const s = statsOf(f.id)
                  const t = TURNSTILE_PILL[turnstileState(f.turnstile)]
                  return (
                    <li key={f.id} className="list-row">
                      <span className="grow" style={{ minWidth: 0 }}>
                        <Link className="row-title" to={`/audience/forms/${f.id}` as string}>
                          {f.name}
                        </Link>
                        <span className="row-sub" style={{ whiteSpace: "normal" }}>
                          {f.archived ? "Archived" : "Live"} · Turnstile {t.label.toLowerCase()}
                          {s ? ` · ${fmtInt(s.submissions)} submissions in 30 d` : ""}
                        </span>
                      </span>
                      <Icon name="chevron-right" />
                    </li>
                  )
                })}
              </ul>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Signed up counts subscribed plus awaiting confirmation. An archived form’s page answers “not
              found”.
            </p>
          </>
        )}
      </Panel>
    </>
  )
}

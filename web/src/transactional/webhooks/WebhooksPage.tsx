/**
 * Transactional → Webhooks (design: transactional/webhooks*.html; HANDOFF-ops §22, §33): every endpoint with
 * its events, last success and failure, dead letters (a red badge linking to them) and state.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { fmtInt, num } from "../../lib/format.ts"
import { BuiltPill, Empty, Time } from "../../ops/kit.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { AdminOnly, Pill, useIsAdmin } from "../keys/ui.tsx"
import { HeadActions } from "../Layout.tsx"
import { HEALTH_PILL, webhookHealth } from "./logic.ts"
import { hooksQuery } from "./queries.ts"
import { EndpointSheet } from "./WebhookSheets.tsx"
import "../keys/keys.css"

const route = getRouteApi("/_app/transactional/webhooks/")

export function WebhooksPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const go = useNavigate()
  const { admin } = useIsAdmin()
  const q = useQuery(hooksQuery)
  const open = () => navigate({ search: (p) => ({ ...p, sheet: "create" as const }) })
  const close = () =>
    navigate({
      search: (p) => {
        const { sheet: _s, ...rest } = p
        return rest
      },
    })
  const add = (label: string, cls = "btn btn-primary") => (
    <AdminOnly allowed={admin} reason="Senders can’t add endpoints" who="Owners and admins manage webhooks.">
      <button className={cls} type="button" onClick={open} data-endpoint="POST /v1/webhooks">
        <Icon name="plus" />
        {label}
      </button>
    </AdminOnly>
  )
  return (
    <>
      <HeadActions>{add("Add endpoint")}</HeadActions>
      <Panel
        id="webhooks"
        title="Webhook endpoints"
        endpoint="GET /v1/webhooks → deadLetters on each endpoint (built, HAL-3416)"
        query={q}
        meta={
          q.data?.webhooks.length ? (
            <span className="cluster">
              {q.data.webhooks.length} endpoint{q.data.webhooks.length === 1 ? "" : "s"}
              <BuiltPill issue="HAL-3416" />
            </span>
          ) : undefined
        }
        isEmpty={(d) => d.webhooks.length === 0}
        empty={
          <Empty icon="webhook" title="No endpoints yet" action={add("Add an endpoint", "btn btn-secondary")}>
            Add a URL and pick events: delivered, bounced, complained, unsubscribed and more. Each request is
            signed so you can trust it.
          </Empty>
        }
      >
        {(d) => (
          <div className="table-wrap rtable-wrap">
            <table className="rtable">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Events</th>
                  <th>Deliveries</th>
                  <th className="r">Dead letters</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {d.webhooks.map((w) => {
                  const h = HEALTH_PILL[webhookHealth(w)]
                  const dead = num(w.deadLetters) ?? 0
                  return (
                    <tr key={w.id}>
                      <td className="is-head">
                        <div className="cell-main">
                          <Link
                            className="mono tb-url"
                            to="/transactional/webhooks/$id"
                            params={{ id: w.id }}
                          >
                            {w.url}
                          </Link>
                          <span className="cell-sub">{w.description ?? "No description"}</span>
                        </div>
                      </td>
                      <td data-label="Events">
                        <span className="scope-tags">
                          {w.events.map((e) => (
                            <span key={e} className="tag">
                              {e === "*" ? "All events (*)" : e}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td data-label="Deliveries">
                        <span className="cell-sub tb-fg">
                          {w.lastSuccessAt ? (
                            <>
                              Last success <Time value={w.lastSuccessAt} />
                            </>
                          ) : (
                            "No success yet"
                          )}
                          {w.lastFailureAt ? (
                            <>
                              {" "}
                              · last failure <Time value={w.lastFailureAt} />
                            </>
                          ) : null}
                        </span>
                      </td>
                      <td className="r" data-label="Dead letters">
                        {dead ? (
                          <Link
                            className="dead-badge"
                            to="/transactional/webhooks/$id"
                            params={{ id: w.id }}
                            search={{ status: "dead" }}
                            aria-label={`${fmtInt(dead)} dead letters`}
                          >
                            <Icon name="warn" className="icon-12" />
                            {fmtInt(dead)}
                          </Link>
                        ) : (
                          <span className="muted num">0</span>
                        )}
                      </td>
                      <td className="is-aside">
                        <Pill tone={h.tone}>
                          {w.paused && w.enabled && num(w.held) ? `Paused · ${fmtInt(w.held)} held` : h.label}
                        </Pill>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {search.sheet === "create" ? (
        <EndpointSheet
          events={q.data?.events ?? []}
          onClose={close}
          onCreated={(id) => go({ to: "/transactional/webhooks/$id", params: { id } })}
        />
      ) : null}
    </>
  )
}

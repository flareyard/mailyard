/**
 * DMARC reports (design: dmarc, dmarc-empty). The aggregate-report endpoints are HAL-3375 and aren't in the
 * live API, so the page says so and shows nothing invented: the per-source table, the pass figures and the policy
 * advice wait for `GET /v1/domains/{id}/dmarc`, and light up by themselves when /openapi.json lists it.
 *
 * What is real today is shown: the DMARC record public DNS answers for the chosen domain, from its record check.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useCapabilities } from "../auth/capabilities.ts"
import { CodeBlock } from "../ops/Copy.tsx"
import { Empty, PlannedPill } from "../ops/kit.tsx"
import { Icon } from "../ui/icons.tsx"
import { Panel } from "../ui/Panel.tsx"
import { STATUS_PILL } from "./logic.ts"
import { domainQuery, domainsQuery } from "./queries.ts"
import { DomainsHead, StatePill } from "./ui.tsx"
import "./domains.css"

const route = getRouteApi("/_app/domains/dmarc")
const RANGES = ["7d", "30d", "90d"] as const

export function DmarcPage() {
  const { domain: wanted, range = "30d" } = route.useSearch()
  const navigate = route.useNavigate()
  const caps = useCapabilities()
  const live = caps.has("GET", "/v1/domains/{id}/dmarc")
  const list = useQuery(domainsQuery)
  const sending = (list.data?.domains ?? []).filter((d) => d.sending)
  const all = list.data?.domains ?? []
  const pickFrom = sending.length ? sending : all
  const current = pickFrom.find((d) => d.id === wanted) ?? pickFrom[0]
  const detail = useQuery({ ...domainQuery(current?.id ?? "none"), enabled: Boolean(current) })
  const dmarc = detail.data?.checks.find((c) => c.id === "dmarc")

  return (
    <>
      <DomainsHead
        sub="Aggregate reports from receivers: who sends as your domain, and whether it passes."
        actions={
          <>
            <label className="sr-only" htmlFor="dm-dom">
              Domain
            </label>
            <select
              className="select dm-select"
              id="dm-dom"
              value={current?.id ?? ""}
              disabled={!pickFrom.length}
              onChange={(e) =>
                navigate({
                  search: (s) => ({ ...s, domain: e.target.value }),
                  replace: true,
                })
              }
            >
              {pickFrom.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <span className="has-reason">
              {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
              <div className="seg" role="group" aria-label="Range" aria-describedby="dm-range-why">
                {RANGES.map((r) => (
                  <button key={r} type="button" aria-pressed={r === range} aria-disabled={!live}>
                    {r}
                  </button>
                ))}
              </div>
              {!live ? (
                <span className="reason-pop is-right" role="tooltip" id="dm-range-why">
                  <b>Reports aren’t built yet</b>
                  <span className="reason-who">
                    Planned · HAL-3375. The range applies once reports arrive.
                  </span>
                </span>
              ) : null}
            </span>
          </>
        }
      />
      <div className="callout callout-info" role="note" style={{ marginBottom: 16 }}>
        <Icon name="info" />
        <span>
          <b>DMARC reports aren’t in Mailyard yet.</b> Reading receivers’ aggregate reports, the sending
          sources and “Mark as known” are planned in HAL-3375. Until then this page shows the DMARC record
          each domain publishes.
        </span>
        <PlannedPill issue="HAL-3375" />
      </div>
      <div className="split-2">
        <div className="stack">
          <section
            className="panel"
            data-endpoint="GET /v1/domains/{id}/dmarc?range= (planned, HAL-3375)"
            data-od-id="panel-sources"
            aria-labelledby="h-sources"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-sources">
                Sending sources
              </h2>
              <div className="cluster">
                <PlannedPill issue="HAL-3375" />
              </div>
            </header>
            <div className="panel-body">
              <Empty icon="shield" title="No reports to show">
                Receivers send a daily report to the address in your DMARC record’s{" "}
                <span className="mono">rua</span>. When HAL-3375 ships, Mailyard reads them and lists every
                source sending as {current ? <span className="mono">{current.name}</span> : "your domain"},
                with its SPF, DKIM and DMARC results.
              </Empty>
            </div>
          </section>
        </div>
        <div className="stack">
          <Panel
            id="policy"
            title="Policy"
            endpoint={`GET /v1/domains/${current?.id ?? "{id}"} → checks[dmarc]`}
            query={detail}
            empty={
              <Empty icon="domains" title="No domain to report on">
                Add a sending domain first.
              </Empty>
            }
            isEmpty={() => !current}
          >
            {(d) =>
              dmarc ? (
                <div className="stack stack-12">
                  <dl className="kv dm-kv">
                    <dt>Published now</dt>
                    <dd>
                      {dmarc.actual.length ? (
                        <span className="mono">{dmarc.actual.join(" · ")}</span>
                      ) : (
                        <span className="muted">Nothing at {dmarc.name}</span>
                      )}
                    </dd>
                    <dt>Check</dt>
                    <dd>
                      <StatePill state={STATUS_PILL[dmarc.status]} />{" "}
                      {dmarc.status === "pass" ? "" : dmarc.detail}
                    </dd>
                  </dl>
                  <div className="stack stack-8">
                    <span className="label">What Mailyard expects</span>
                    <CodeBlock title={dmarc.name} code={dmarc.expected} wrap />
                  </div>
                  <p className="hint">
                    Moving the policy to quarantine or reject, with advice from the reports, comes with
                    HAL-3375.
                  </p>
                  <Link className="btn btn-secondary" to="/domains/$id" params={{ id: d.id }}>
                    Check the DMARC record
                  </Link>
                </div>
              ) : (
                <p className="muted">
                  {d.name} has no DMARC check yet.{" "}
                  <Link to="/domains/$id" params={{ id: d.id }}>
                    Re-check the domain
                  </Link>{" "}
                  to read it.
                </p>
              )
            }
          </Panel>
        </div>
      </div>
    </>
  )
}

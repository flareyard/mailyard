/**
 * The domain list (design: domains, domains-zone-token, domains-empty, domains-loading, domains-error).
 *
 * Without a zone token (production today, owner step HAL-3418) the Zone column reads "Unknown without a zone
 * token", the subline shows the nameservers public DNS answers, and Complaints is dropped. With a token the
 * subline is registrar and DNSSEC, and complaints in 30 days come back. `GET /v1/domains` carries neither the
 * checks nor the zone details, so each row reads its domain's detail too (the list is short); the row shows
 * `checkStatus` until that answers.
 */
import { useQueries, useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { fmtInt, num } from "../lib/format.ts"
import { Empty, Time } from "../ops/kit.tsx"
import { Icon } from "../ui/icons.tsx"
import { Panel } from "../ui/Panel.tsx"
import { AddDomainSheet } from "./AddDomainSheet.tsx"
import { type Domain, type DomainRow, domainState, eventsMissing, recordCounts, zoneState } from "./logic.ts"
import { candidatesQuery, domainQuery, domainsQuery, sendingEventsQuery } from "./queries.ts"
import { DomainsHead, StatePill, StatusWord, TokenNote } from "./ui.tsx"
import "./domains.css"

const route = getRouteApi("/_app/domains/")

export function DomainList() {
  const { add } = route.useSearch()
  const navigate = route.useNavigate()
  const list = useQuery(domainsQuery)
  const events = useQuery(sendingEventsQuery)
  const candidates = useQuery(candidatesQuery)
  const connected = candidates.data?.connected === true
  const rows = list.data?.domains ?? []
  const details = useQueries({ queries: rows.map((d) => domainQuery(d.id)) })
  const detailOf = (id: string) => details.find((q) => q.data?.id === id)?.data
  const missing = rows.flatMap((d) => {
    const e = eventsMissing(d, events.data?.domains)
    return e ? [{ d, e }] : []
  })
  const openAdd = () => navigate({ search: { add: 1 } })

  return (
    <>
      <DomainsHead
        sub="Where your mail is received and sent from, and whether every record still says what it should."
        actions={
          <>
            <Link className="btn btn-secondary" to="/domains/import">
              <Icon name="upload" />
              Import from another registrar
            </Link>
            <button
              className="btn btn-primary"
              type="button"
              onClick={openAdd}
              data-endpoint="GET /v1/domains/candidates · POST /v1/domains"
            >
              <Icon name="plus" />
              Add a domain
            </button>
          </>
        }
      />
      {missing.map(({ d, e }) => (
        <div
          key={d.id}
          className="callout callout-error"
          role="alert"
          style={{ marginBottom: 12 }}
          data-endpoint="GET /v1/sending/events"
        >
          <Icon name="x-circle" />
          <span>
            <b>
              No delivery events for <span className="mono">{d.name}</span>.
            </b>{" "}
            Its deliveries, bounces and complaints never reach Mailyard, so suppression, reports and
            auto-pause can’t see them.
            {num(e.silent) ? ` ${fmtInt(e.silent)} sends are still “sent”.` : ""}
          </span>
          <Link
            className="btn btn-secondary btn-sm dm-callout-action"
            to="/domains/$id"
            params={{ id: d.id }}
          >
            How to fix
          </Link>
        </div>
      ))}
      <Panel
        id="domains"
        title="Domains"
        endpoint="GET /v1/domains → zoneStatus · GET /v1/domains/{id} · GET /v1/sending/events"
        query={list}
        isEmpty={(d) => d.domains.length === 0}
        skeleton={<ListSkeleton />}
        empty={
          <Empty
            icon="domains"
            title="No domains yet"
            action={
              <button className="btn btn-primary" type="button" onClick={openAdd}>
                <Icon name="plus" className="icon-12" />
                Add a domain
              </button>
            }
          >
            Add a domain to receive and send mail from it. Type its name, add the records Mailyard shows, and
            it checks them against public DNS. If it lives at another registrar, import it.
          </Empty>
        }
      >
        {(data) => (
          <>
            {candidates.isSuccess && !connected ? (
              <div style={{ marginBottom: 12 }}>
                <TokenNote
                  detail={false}
                  lead="Connect a zone token to see each zone’s status, registrar, DNSSEC and complaints, and to fix records from here."
                />
              </div>
            ) : null}
            <div className="table-wrap rtable-wrap">
              <table className="rtable dm-table" data-od-id="domain-table">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Zone</th>
                    <th>Mail</th>
                    <th>Records</th>
                    <th className="r">Mailboxes</th>
                    {connected ? <th className="r">Complaints, 30 d</th> : null}
                    <th>Checked</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.domains.map((d) => (
                    <Row
                      key={d.id}
                      d={d}
                      detail={detailOf(d.id)}
                      connected={connected}
                      events={events.data?.domains}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
      {add ? <AddDomainSheet onClose={() => navigate({ search: {} })} /> : null}
    </>
  )
}

function Row({
  d,
  detail,
  connected,
  events,
}: {
  d: DomainRow
  detail: Domain | undefined
  connected: boolean
  events: Parameters<typeof domainState>[1]
}) {
  const state = domainState(detail ? { ...d, checks: detail.checks } : d, events)
  const zone = zoneState(d.zoneStatus, connected)
  const counts = detail ? recordCounts(detail.checks) : null
  const ns = detail?.currentNameservers ?? []
  return (
    <tr>
      <td className="is-head">
        <div className="cell-main">
          <Link className="mono" to="/domains/$id" params={{ id: d.id }}>
            {d.name}
          </Link>
          {connected ? (
            detail && (detail.registrar || detail.dnssec) ? (
              <span className="cell-sub">
                {detail.registrar ?? "Registrar unknown"} · DNSSEC {detail.dnssec ?? "unknown"}
              </span>
            ) : null
          ) : ns.length ? (
            <span className="cell-sub">
              nameservers <span className="mono">{ns[0]}</span>
              {ns.length > 1 ? ` +${ns.length - 1}` : ""} (public DNS)
            </span>
          ) : null}
        </div>
      </td>
      <td data-label="Zone">
        {zone ? (
          <StatusWord tone={zone.tone}>{zone.label}</StatusWord>
        ) : (
          <span className="muted">Unknown without a zone token</span>
        )}
      </td>
      <td data-label="Mail">
        <StatusWord tone={d.receiving ? "pass" : "neutral"}>Routing {d.receiving ? "on" : "off"}</StatusWord>
        <br />
        <StatusWord tone={d.sending ? "pass" : "neutral"}>Sending {d.sending ? "on" : "off"}</StatusWord>
      </td>
      <td data-label="Records">
        {d.lastCheckedAt === null || d.checkStatus === null ? (
          <span className="muted">Not checked yet</span>
        ) : counts ? (
          <>
            <b className="num">
              {counts.passing} of {counts.total}
            </b>{" "}
            passing
          </>
        ) : (
          <span className="muted">{d.checkStatus === "pass" ? "All passing" : "Loading…"}</span>
        )}
      </td>
      <td className="r" data-label="Mailboxes">
        {fmtInt(d.mailboxCount)}
      </td>
      {connected ? (
        <td className="r" data-label="Complaints, 30 d">
          {detail && detail.complaints30d !== null ? (
            fmtInt(detail.complaints30d)
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      ) : null}
      <td data-label="Checked">
        <Time value={d.lastCheckedAt} />
      </td>
      <td className="is-aside">
        <StatePill state={state} />
      </td>
    </tr>
  )
}

function ListSkeleton() {
  return (
    <div className="stack stack-12" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="cluster" style={{ justifyContent: "space-between" }}>
          <span className="sk sk-text" style={{ width: "38%" }} />
          <span className="sk sk-text" style={{ width: "18%" }} />
          <span className="sk sk-text" style={{ width: "14%" }} />
        </div>
      ))}
    </div>
  )
}

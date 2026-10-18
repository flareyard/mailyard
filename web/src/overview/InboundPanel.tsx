/** Inbound: received (and held), Mailyard's own rejections, spam, and the split per mailbox. */
import { useQuery } from "@tanstack/react-query"
import { fmtInt, num } from "../lib/format.ts"
import { Panel } from "../ui/Panel.tsx"
import { RANGE_LABEL, type Range } from "./logic.ts"
import { inboundQuery } from "./queries.ts"
import { AppLink, StaleMeta, useOffline } from "./shared.tsx"

export function InboundPanel({ range }: { range: Range }) {
  const offline = useOffline()
  const q = useQuery(inboundQuery(range))
  return (
    <Panel
      id="inbound"
      title="Inbound"
      to="/analytics/inbound"
      linkLabel="Spam folder"
      span={4}
      endpoint={`GET /v1/stats/inbound?range=${range}`}
      meta={<StaleMeta offline={offline} updatedAt={q.dataUpdatedAt} label={RANGE_LABEL[range]} />}
      query={q}
      skeleton={<InboundSkeleton />}
    >
      {(ib) => {
        const max = Math.max(1, ...ib.byMailbox.map((r) => num(r.received) ?? 0))
        const rj = ib.rejected
        return (
          <div className="stack stack-16">
            <div className="stat-grid ov-stat-3">
              <div className="stat">
                <span className="stat-label">Received</span>
                <span className="stat-value">{fmtInt(ib.received)}</span>
                <span className="stat-delta">{fmtInt(ib.held)} held</span>
              </div>
              <AppLink className="stat ov-plain-link" href="/analytics/inbound#rejected">
                <span className="stat-label">Rejected</span>
                <span className="stat-value">{fmtInt(rj.total)}</span>
              </AppLink>
              <AppLink className="stat ov-plain-link" href="/mail?folder=spam">
                <span className="stat-label">Spam</span>
                <span className="stat-value">{fmtInt(ib.spam)}</span>
              </AppLink>
            </div>
            <div>
              <h3 className="t-h4 ov-mb-2">Why mail was turned away</h3>
              <ul className="list" aria-label="Rejections">
                <RejectRow label="No such address" value={rj.noSuchAddress} />
                <RejectRow label="DMARC failures" value={rj.dmarcFail} />
                <RejectRow label="Listed senders (RBL)" value={rj.rbl} />
              </ul>
              {rj.dmarcFail === null || rj.rbl === null ? (
                <p className="hint ov-mt-6">
                  Email Routing turns away DMARC failures and listed senders before mail reaches Mailyard, so
                  they can’t be counted here yet.
                </p>
              ) : null}
            </div>
            {ib.byMailbox.length ? (
              <ul className="list" aria-label="Received per mailbox">
                {ib.byMailbox.map((r) => (
                  <li key={r.mailboxId} className="list-row">
                    <span className="grow">
                      <span className="row-title mono">{r.address ?? r.mailboxId}</span>
                      <span className="splitbar ov-mini-bar">
                        <span
                          style={{
                            width: `${(((num(r.received) ?? 0) / max) * 100).toFixed(1)}%`,
                            ["--c" as string]: "var(--data-transactional)",
                          }}
                        />
                      </span>
                    </span>
                    <span className="count">{fmtInt(r.received)}</span>
                    <span className="t-small muted num ov-spam-count">{fmtInt(r.spam)} spam</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="t-small muted">
                No mail arrived in this range. Each receiving mailbox lists here with what it got.
              </p>
            )}
          </div>
        )
      }}
    </Panel>
  )
}

function RejectRow({ label, value }: { label: string; value: number | string | null }) {
  if (value === null) {
    return (
      <li className="list-row ov-row-stacked">
        <span className="row-title ov-regular">{label}</span>
        <span className="row-sub ov-wrap">Not visible to Mailyard yet · HAL-3393</span>
      </li>
    )
  }
  return (
    <li className="list-row">
      <span className="grow">
        <span className="row-title ov-regular">{label}</span>
      </span>
      <span className="count">{fmtInt(value)}</span>
    </li>
  )
}

function InboundSkeleton() {
  return (
    <div className="stack stack-16" aria-hidden="true">
      <div className="stat-grid">
        <span className="sk sk-stat" />
        <span className="sk sk-stat" />
        <span className="sk sk-stat" />
      </div>
      <div className="stack stack-12">
        {[100, 86, 92].map((w) => (
          <span key={w} className="sk sk-text" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  )
}

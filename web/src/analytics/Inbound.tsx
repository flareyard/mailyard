/**
 * Analytics → Inbound (design: inbound*.html; HANDOFF-ops §15): received, rejected at the door, held and spam;
 * per day, per mailbox and top senders (≈ when estimated); response times for shared mailboxes. DMARC fail and
 * RBL rejections never reach Mailyard, so they read "Not visible to Mailyard yet (HAL-3393)", never 0.
 */
import { useQuery } from "@tanstack/react-query"
import { fmtInt, num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { countAxis, n0 } from "./logic.ts"
import { inboundQuery, responseTimesQuery } from "./queries.ts"
import { ChartPanel, dayLong, LineChart, SkeletonBlock, shortDay, useRange } from "./shared.tsx"

const minutes = (v: unknown) => {
  const n = num(v as number)
  return n === null ? null : `${fmtInt(Math.round(n))} min`
}

export function Inbound() {
  const range = useRange("inbound")
  const q = useQuery(inboundQuery(range))
  const rt = useQuery(responseTimesQuery(range))
  const endpoint = `GET /v1/stats/inbound?range=${range}`
  const i = q.data
  return (
    <>
      {i ? (
        <div className="big-figures ana-big">
          <div className="fig">
            <span className="stat-label">Received</span>
            <span className="stat-value">{fmtInt(i.received)}</span>
          </div>
          <div className="fig">
            <span className="stat-label">Rejected at the door</span>
            <span className="stat-value">{fmtInt(i.rejected.total)}</span>
            <span className="stat-delta">No such address {fmtInt(i.rejected.noSuchAddress)}</span>
          </div>
          <div className="fig">
            <span className="stat-label">DMARC fail · RBL</span>
            {i.rejected.dmarcFail === null && i.rejected.rbl === null ? (
              <>
                <span className="stat-value ana-fig-note">
                  <span className="muted">Not visible to Mailyard yet (HAL-3393)</span>
                </span>
                <span className="stat-delta">Email Routing rejects that mail before Mailyard sees it</span>
              </>
            ) : (
              <>
                <span className="stat-value">{fmtInt(n0(i.rejected.dmarcFail) + n0(i.rejected.rbl))}</span>
                <span className="stat-delta">
                  DMARC {i.rejected.dmarcFail === null ? "—" : fmtInt(i.rejected.dmarcFail)} · RBL{" "}
                  {i.rejected.rbl === null ? "—" : fmtInt(i.rejected.rbl)}
                </span>
              </>
            )}
          </div>
          <div className="fig">
            <span className="stat-label">Held for review</span>
            <span className="stat-value">{fmtInt(i.held)}</span>
          </div>
          <a className="fig" href="/mail?folder=spam">
            <span className="stat-label">Filed as spam</span>
            <span className="stat-value">{fmtInt(i.spam)}</span>
          </a>
        </div>
      ) : q.isPending ? (
        <div className="big-figures ana-big" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((k) => (
            <div key={k} className="fig">
              <span className="sk sk-text" style={{ width: "50%" }} />
              <span className="sk sk-stat" />
            </div>
          ))}
        </div>
      ) : null}
      <div className="split-even">
        <div className="stack">
          <ChartPanel
            id="per-day"
            name="Received per day"
            title="Received per day"
            range={range}
            endpoint={endpoint}
            query={q}
            built="HAL-3362"
            csv="inbound"
            skeleton={<SkeletonBlock height={200} />}
          >
            {(d) => {
              const values = d.days.map((x) => n0(x.received))
              const axis = countAxis(values)
              const first = d.days[0]?.day
              const last = d.days[d.days.length - 1]?.day
              return (
                <LineChart
                  label={`Received per day over ${range}`}
                  values={values}
                  top={axis.top}
                  ticks={axis.ticks}
                  first={first ? shortDay(first) : ""}
                  last={last ? shortDay(last) : ""}
                  table={{
                    head: ["Day", "Received"],
                    rows: d.days.map((x) => [dayLong(x.day), fmtInt(x.received)]),
                  }}
                />
              )
            }}
          </ChartPanel>
          <ChartPanel
            id="per-mailbox"
            name="Received per mailbox"
            title="Received per mailbox"
            range={range}
            endpoint={endpoint}
            query={q}
            built="HAL-3362"
            csv="inbound"
            empty={(d) =>
              d.byMailbox.length ? null : <p className="muted t-small">No mail arrived in this range.</p>
            }
          >
            {(d) => {
              const peak = Math.max(1, ...d.byMailbox.map((m) => n0(m.received)))
              return (
                <div className="hb">
                  {d.byMailbox.map((m) => (
                    <div key={m.mailboxId} className="hb-row">
                      <span className="hb-name mono ana-mono-sm">{m.address ?? m.mailboxId}</span>
                      <span className="hb-track">
                        <span
                          style={{
                            flex: `0 0 ${Math.round((n0(m.received) / peak) * 100)}%`,
                            ["--c" as string]: "var(--data-transactional)",
                          }}
                        />
                      </span>
                      <span className="hb-n">{fmtInt(m.received)}</span>
                      <span className="hb-sub">{fmtInt(m.spam)} filed as spam</span>
                    </div>
                  ))}
                </div>
              )
            }}
          </ChartPanel>
        </div>
        <div className="stack">
          <ChartPanel
            id="response"
            name="Response times"
            title="Response times, shared mailboxes"
            range={range}
            endpoint={`GET /v1/stats/response-times?range=${range}`}
            query={rt}
            built="HAL-3362"
          >
            {(r) => (
              <div className="stack stack-12">
                {r.unavailable.map((id) => {
                  const address = i?.byMailbox.find((m) => m.mailboxId === id)?.address ?? id
                  return (
                    <div key={id} className="callout callout-warn">
                      <Icon name="warn" />
                      <span>
                        <b>
                          Couldn’t read <span className="mono">{address}</span>.
                        </b>{" "}
                        Its mailbox store didn’t answer, so its response times are missing from this range;
                        other mailboxes are unaffected. This usually clears on the next refresh.
                      </span>
                    </div>
                  )
                })}
                {r.unavailable.length ? (
                  <div>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => rt.refetch()}>
                      <Icon name="refresh" />
                      Retry
                    </button>
                  </div>
                ) : null}
                {!r.mailboxes.length && !r.unavailable.length ? (
                  <p className="muted t-small">No shared mailbox had a thread in this range.</p>
                ) : null}
                {r.mailboxes.map((m) => {
                  const resolution = m.assignees.some((a) => a.resolutionMedianHours !== null)
                  return (
                    <div key={m.mailboxId}>
                      <p className="hint ana-hint-gap">
                        For <span className="mono">{m.address}</span>.
                        {resolution
                          ? ""
                          : " Resolution time: coming (HAL-3392); the column appears once it has values."}
                      </p>
                      <table className="rtable">
                        <thead>
                          <tr>
                            <th>Assignee</th>
                            <th className="r">Threads</th>
                            <th className="r">Answered</th>
                            <th className="r">First response, median</th>
                            <th className="r">p90</th>
                            {resolution ? <th className="r">Resolution, median</th> : null}
                          </tr>
                        </thead>
                        <tbody>
                          {m.assignees.map((a) => (
                            <tr key={a.assigneeId ?? "unassigned"}>
                              <td className="is-head">
                                {a.assigneeId === null ? (
                                  <span className="muted">Unassigned</span>
                                ) : (
                                  (a.name ?? a.assigneeId)
                                )}
                              </td>
                              <td className="r" data-label="Threads">
                                {fmtInt(a.threads)}
                              </td>
                              <td className="r" data-label="Answered">
                                {fmtInt(a.answered)}
                              </td>
                              <td className="r" data-label="First response, median">
                                {minutes(a.firstResponseMedianMin) ?? <span className="muted">—</span>}
                              </td>
                              <td className="r" data-label="First response, p90">
                                {minutes(a.firstResponseP90Min) ?? <span className="muted">—</span>}
                              </td>
                              {resolution ? (
                                <td className="r" data-label="Resolution, median">
                                  {num(a.resolutionMedianHours) === null ? (
                                    <span className="muted">—</span>
                                  ) : (
                                    `${num(a.resolutionMedianHours)} h`
                                  )}
                                </td>
                              ) : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                })}
              </div>
            )}
          </ChartPanel>
          <ChartPanel
            id="top-senders"
            name="Top senders"
            title={
              q.data?.topSendersEstimate ? (
                <>
                  Top senders <span className="pill pill-neutral">Estimated</span>
                </>
              ) : (
                "Top senders"
              )
            }
            range={range}
            endpoint={endpoint}
            query={q}
            built="HAL-3362"
            csv="inbound"
            empty={(d) =>
              d.topSenders.length ? null : <p className="muted t-small">No senders in this range.</p>
            }
          >
            {(d) => (
              <>
                <ul className="list">
                  {d.topSenders.map((s) => (
                    <li key={s.address} className="list-row">
                      <span className="grow">
                        <span className="row-title mono">{s.address}</span>
                      </span>
                      <span className="count">
                        {d.topSendersEstimate ? "≈" : ""}
                        {fmtInt(s.received)}
                      </span>
                    </li>
                  ))}
                </ul>
                {d.topSendersEstimate ? (
                  <p className="hint ana-hint-top">
                    Estimated from a sample over long ranges (
                    <span className="mono">topSendersEstimate: true</span>).
                  </p>
                ) : null}
              </>
            )}
          </ChartPanel>
        </div>
      </div>
    </>
  )
}

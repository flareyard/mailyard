/**
 * DMARC reports (HAL-3375; design: dmarc, dmarc-empty). Receivers' aggregate reports for one domain over a
 * range, both in the URL (`?domain=&range=`): the pass figures, every source sending as the domain (unknown
 * failing ones first, each one markable as known with a label), who reported, and the policy with the next
 * safe step, previewed with a dry run before anything is written.
 *
 * Reports only arrive when the published `rua` includes Mailyard's address (`receiving.inRua`); when it
 * doesn't, the page says so and gives the tag to publish.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { type FormEvent, useId, useState } from "react"
import { ApiError } from "../api/client.ts"
import { fmtInt, num } from "../lib/format.ts"
import { CodeBlock, CopyChip } from "../ops/Copy.tsx"
import { pct } from "../ops/format.ts"
import { Empty, Time } from "../ops/kit.tsx"
import { Sheet } from "../ops/Overlay.tsx"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError, PanelSkeleton, RequestId } from "../ui/Panel.tsx"
import { DmarcPolicySheet } from "./DmarcPolicySheet.tsx"
import {
  authLines,
  type Dmarc,
  type DmarcP,
  P_LABEL,
  RANGES,
  type Range,
  ruaWith,
  type Source,
  share,
  sortSources,
  sourceName,
  sourceState,
  stepLabel,
} from "./dmarc.ts"
import { dmarcQuery, domainsQuery, useMarkKnown } from "./queries.ts"
import { DomainsHead, StatePill } from "./ui.tsx"
import "./domains.css"

const route = getRouteApi("/_app/domains/dmarc")

export function DmarcPage() {
  const { domain: wanted, range = "30d" } = route.useSearch()
  const navigate = route.useNavigate()
  const list = useQuery(domainsQuery)
  const all = list.data?.domains ?? []
  const sending = all.filter((d) => d.sending)
  const pickFrom = sending.length ? sending : all
  const current = pickFrom.find((d) => d.id === wanted) ?? pickFrom[0]
  const q = useQuery({ ...dmarcQuery(current?.id ?? "none", range), enabled: Boolean(current) })
  const [policyOpen, setPolicyOpen] = useState(false)

  const setRange = (r: Range) =>
    navigate({
      search: (s) => {
        // 30d is the default and stays out of the URL.
        const { range: _drop, ...rest } = s
        return r === "30d" ? rest : { ...rest, range: r }
      },
      replace: true,
    })

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
              onChange={(e) => navigate({ search: (s) => ({ ...s, domain: e.target.value }), replace: true })}
            >
              {pickFrom.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
            <div className="seg" role="group" aria-label="Range">
              {RANGES.map((r) => (
                <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
                  {r}
                </button>
              ))}
            </div>
          </>
        }
      />
      {list.isPending || (current && q.isPending) ? (
        <section className="panel" aria-busy="true">
          <div className="panel-body">
            <PanelSkeleton rows={5} />
          </div>
        </section>
      ) : list.isError ? (
        <section className="panel is-error">
          <div className="panel-body">
            <PanelError error={list.error} onRetry={() => list.refetch()} what="Domains didn’t load" />
          </div>
        </section>
      ) : !current ? (
        <section className="panel">
          <div className="panel-body">
            <Empty
              icon="domains"
              title="No domain to report on"
              action={
                <Link className="btn btn-primary" to="/domains" search={{ add: 1 }}>
                  <Icon name="plus" className="icon-12" />
                  Add a domain
                </Link>
              }
            >
              DMARC reports are about a domain you send from. Add one first.
            </Empty>
          </div>
        </section>
      ) : q.isError ? (
        <section
          className="panel is-error"
          data-endpoint={`GET /v1/domains/${current.id}/dmarc?range=${range}`}
          data-od-id="panel-dmarc"
        >
          <div className="panel-body">
            <PanelError error={q.error} onRetry={() => q.refetch()} what="DMARC reports didn’t load" />
          </div>
        </section>
      ) : q.data ? (
        num(q.data.reports) ? (
          <Reports d={q.data} range={range} onPolicy={() => setPolicyOpen(true)} />
        ) : (
          <NoReports d={q.data} />
        )
      ) : null}
      {policyOpen && q.data && current ? (
        <DmarcPolicySheet
          domainId={current.id}
          domainName={current.name}
          initial={initialChoice(q.data)}
          onClose={() => setPolicyOpen(false)}
        />
      ) : null}
    </>
  )
}

/** The sheet opens on the recommended next step, or one step up from what's published. */
function initialChoice(d: Dmarc): { p: DmarcP; pct: number | null } {
  const next = d.recommendation.next
  if (next) return { p: next.p, pct: num(next.pct) }
  return { p: d.policy.p === "none" || d.policy.p === null ? "quarantine" : d.policy.p, pct: null }
}

/** No reports in the range: either the rua doesn't reach Mailyard, or none have arrived yet. */
function NoReports({ d }: { d: Dmarc }) {
  const tag = ruaWith(d.policy.rua, d.receiving.address)
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/domains/${d.domain.id}/dmarc → receiving`}
      data-od-id="panel-dmarc"
      aria-labelledby="h-dmarc"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-dmarc">
          DMARC reports
        </h2>
        <div className="cluster">
          <span className="panel-meta">Last {fmtInt(d.range.days)} days</span>
        </div>
      </header>
      <div className="panel-body">
        {d.receiving.inRua ? (
          <Empty
            icon="shield"
            title="No reports yet"
            action={
              <Link className="btn btn-secondary" to="/domains/$id" params={{ id: d.domain.id }}>
                Check the DMARC record
              </Link>
            }
          >
            Receivers send a daily report to the address in your DMARC record. Yours points at{" "}
            <span className="mono">{d.receiving.address}</span>, which Mailyard reads; the first reports
            usually arrive within 48 hours.
            {d.lastReportAt ? (
              <>
                {" "}
                The last one arrived <Time value={d.lastReportAt} />.
              </>
            ) : null}
          </Empty>
        ) : (
          <div className="stack stack-16" data-od-id="dmarc-not-in-rua">
            <Empty icon="shield" title="Reports aren’t being sent to Mailyard">
              <span className="mono">{d.domain.name}</span>’s DMARC record doesn’t list{" "}
              <span className="mono">{d.receiving.address}</span> in <span className="mono">rua</span>, so
              receivers send their reports elsewhere{d.policy.rua.length ? "" : ", or nowhere"}. Add it, and
              reports start within a day or two.
            </Empty>
            <div className="stack stack-8">
              <span className="label">
                Publish this <span className="mono">rua</span> in the TXT record at{" "}
                <span className="mono">_dmarc.{d.domain.name}</span>
              </span>
              <span className="ns">
                <code>{tag}</code>
                <CopyChip value={tag} what="the rua tag" />
              </span>
              <span className="hint">
                {d.policy.rua.length
                  ? "It keeps the addresses you already send reports to, and adds Mailyard’s."
                  : "Keep the rest of the record as it is."}
                {d.receiving.routed
                  ? ""
                  : ` Routing is off for this domain, so mail to ${d.receiving.address} won’t reach Mailyard until it’s on.`}
              </span>
            </div>
            {d.policy.record ? (
              <dl className="kv dm-kv">
                <dt>Published now</dt>
                <dd>
                  <span className="mono">{d.policy.record}</span>
                </dd>
              </dl>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}

function Reports({ d, range, onPolicy }: { d: Dmarc; range: Range; onPolicy: () => void }) {
  const t = d.totals
  const failed = (num(t.messages) ?? 0) - (num(t.dmarcPass) ?? 0)
  const sources = sortSources(d.sources)
  const [marking, setMarking] = useState<Source | null>(null)
  const mark = useMarkKnown(d.domain.id)
  const unmark = (s: Source) =>
    mark.mutate(
      { ip: s.ip, known: false },
      {
        onSuccess: () => toast({ title: `${sourceName(s)} is no longer marked known` }),
        onError: (e) => toast({ tone: "bad", title: "Not changed", sub: e.message }),
      },
    )
  return (
    <>
      <div className="big-figures" style={{ marginBottom: 16 }}>
        <div className="fig">
          <span className="stat-label">Messages reported</span>
          <span className="stat-value">{fmtInt(t.messages)}</span>
          <span className="stat-delta">
            {fmtInt(d.reports)} report{num(d.reports) === 1 ? "" : "s"} from {fmtInt(d.reporters.length)}{" "}
            receiver
            {d.reporters.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="fig">
          <span className="stat-label">DMARC pass</span>
          <span className="stat-value">{pct(share(t.dmarcPass, t.messages))}</span>
          <span className="stat-delta">{fmtInt(failed)} failed</span>
        </div>
        <div className="fig">
          <span className="stat-label">SPF aligned</span>
          <span className="stat-value">{pct(share(t.spfPass, t.messages))}</span>
        </div>
        <div className="fig">
          <span className="stat-label">DKIM aligned</span>
          <span className="stat-value">{pct(share(t.dkimPass, t.messages))}</span>
          {num(t.quarantined) || num(t.rejected) ? (
            <span className="stat-delta">
              {fmtInt(t.quarantined)} quarantined · {fmtInt(t.rejected)} rejected
            </span>
          ) : null}
        </div>
      </div>
      <div className="split-2">
        <div className="stack">
          <section
            className="panel"
            data-endpoint={`GET /v1/domains/${d.domain.id}/dmarc?range=${range} → sources · POST/DELETE …/sources/{ip}/known`}
            data-od-id="panel-sources"
            aria-labelledby="h-sources"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-sources">
                Sending sources
              </h2>
              <div className="cluster">
                <span className="panel-meta">
                  Last {fmtInt(d.range.days)} days · reports on {fmtInt(d.reportDays)} day
                  {num(d.reportDays) === 1 ? "" : "s"}
                </span>
              </div>
            </header>
            <div className="panel-body">
              <div className="table-wrap rtable-wrap">
                <table className="rtable dm-table" data-od-id="dmarc-sources">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th className="r">Messages</th>
                      <th className="r">SPF pass</th>
                      <th className="r">DKIM pass</th>
                      <th>
                        <span className="sr-only">Known</span>
                      </th>
                      <th>DMARC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => (
                      <SourceRow
                        key={s.ip}
                        s={s}
                        busy={mark.isPending && mark.variables?.ip === s.ip}
                        onMark={() => setMarking(s)}
                        onUnmark={() => unmark(s)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
          <section
            className="panel"
            data-endpoint={`GET /v1/domains/${d.domain.id}/dmarc → reporters`}
            data-od-id="panel-reporters"
            aria-labelledby="h-reporters"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-reporters">
                Who reported
              </h2>
              <div className="cluster">
                {d.lastReportAt ? (
                  <span className="panel-meta">
                    last report <Time value={d.lastReportAt} />
                  </span>
                ) : null}
              </div>
            </header>
            <div className="panel-body">
              <ul className="list">
                {d.reporters.map((r) => (
                  <li key={`${r.org}-${r.email ?? ""}`} className="list-row">
                    <span className="grow">
                      <span className="row-title">{r.org}</span>
                      {r.email ? <span className="row-sub mono">{r.email}</span> : null}
                    </span>
                    <span className="t-small muted num">
                      {fmtInt(r.reports)} report{num(r.reports) === 1 ? "" : "s"} · {fmtInt(r.messages)}{" "}
                      messages
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
        <div className="stack">
          <PolicyPanel d={d} onPolicy={onPolicy} />
        </div>
      </div>
      {marking ? (
        <MarkKnownSheet
          s={marking}
          domainId={d.domain.id}
          domainName={d.domain.name}
          onClose={() => setMarking(null)}
        />
      ) : null}
    </>
  )
}

function SourceRow({
  s,
  busy,
  onMark,
  onUnmark,
}: {
  s: Source
  busy: boolean
  onMark: () => void
  onUnmark: () => void
}) {
  const m = num(s.messages) ?? 0
  const state = sourceState(s)
  const dkim = authLines(s.dkimDomains)
  const spf = authLines(s.spfDomains)
  return (
    <tr>
      <td className="is-head">
        <div className="cell-main">
          <span className="dm-source-name">{sourceName(s)}</span>
          <span className="cell-sub mono">
            {s.ip}
            {s.ptr && sourceName(s) !== s.ptr ? ` · ${s.ptr}` : ""}
          </span>
          <span className="cell-sub dm-wrap">{s.reason}</span>
          {dkim.length || spf.length ? (
            <span className="cell-sub dm-wrap">
              {dkim.length ? (
                <>
                  DKIM <span className="mono">{dkim.join(", ")}</span>
                </>
              ) : null}
              {dkim.length && spf.length ? " · " : null}
              {spf.length ? (
                <>
                  SPF <span className="mono">{spf.join(", ")}</span>
                </>
              ) : null}
            </span>
          ) : null}
          {s.firstSeen ? (
            <span className="cell-sub">
              Seen <Time value={s.firstSeen} />
              {s.lastSeen && s.lastSeen !== s.firstSeen ? (
                <>
                  {" "}
                  to <Time value={s.lastSeen} />
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      </td>
      <td className="r" data-label="Messages">
        {fmtInt(m)}
      </td>
      <td className="r" data-label="SPF pass">
        {pct(share(s.spfPass, m))}
      </td>
      <td className="r" data-label="DKIM pass">
        {pct(share(s.dkimPass, m))}
      </td>
      <td className="actions">
        {s.markedKnown ? (
          <span className="cluster cluster-4">
            <span className="pill pill-neutral">Known</span>
            <button className="btn btn-ghost btn-sm" type="button" onClick={onUnmark} disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              Unmark
            </button>
          </span>
        ) : s.known ? (
          <span className="pill pill-neutral">Known</span>
        ) : (
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={onMark}
            disabled={busy}
            data-endpoint={`POST …/dmarc/sources/${s.ip}/known`}
          >
            <Icon name="check" className="icon-12" />
            Mark as known
          </button>
        )}
      </td>
      <td className="is-aside">
        <StatePill state={state} />
      </td>
    </tr>
  )
}

function MarkKnownSheet({
  s,
  domainId,
  domainName,
  onClose,
}: {
  s: Source
  domainId: string
  domainName: string
  onClose: () => void
}) {
  const id = useId()
  const [label, setLabel] = useState(s.label ?? s.provider ?? "")
  const mark = useMarkKnown(domainId)
  const err = mark.error instanceof ApiError ? mark.error : null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    mark.mutate(
      { ip: s.ip, known: true, label },
      {
        onSuccess: () => {
          toast({
            title: `${label.trim() || s.ip} marked known`,
            sub: "It no longer blocks a stricter policy.",
          })
          onClose()
        },
      },
    )
  }
  return (
    <Sheet
      title="Mark as known"
      sub={`POST /v1/domains/${domainId}/dmarc/sources/${s.ip}/known`}
      onClose={onClose}
      odId="dmarc-known-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn btn-primary${mark.isPending ? " is-loading" : ""}`}
            type="submit"
            form={`${id}-form`}
            disabled={mark.isPending}
          >
            {mark.isPending ? <span className="spinner" /> : <Icon name="check" />}
            Mark known
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className="stack stack-12" onSubmit={submit}>
        <p>
          <span className="mono">{s.ip}</span>
          {s.ptr ? (
            <>
              {" "}
              (<span className="mono">{s.ptr}</span>)
            </>
          ) : null}{" "}
          sent {fmtInt(s.messages)} messages as <span className="mono">{domainName}</span>. Marking it known
          says it’s yours or sent on your behalf, so its failures stop counting against a stricter policy. Its
          mail still fails DMARC until its SPF or DKIM is fixed.
        </p>
        <div className="field">
          <label className="label" htmlFor={`${id}-label`}>
            Label <span className="opt">· optional</span>
          </label>
          <input
            className="input"
            id={`${id}-label`}
            value={label}
            maxLength={100}
            placeholder="Old contact form"
            onChange={(e) => setLabel(e.target.value)}
            data-autofocus=""
          />
          <span className="hint">What it is, so the next person knows. Up to 100 characters.</span>
        </div>
        {err ? (
          <div className="callout callout-error" role="alert">
            <Icon name="x-circle" />
            <span>
              <b>Not marked.</b> {err.message} {err.requestId ? <RequestId id={err.requestId} /> : null}
            </span>
          </div>
        ) : null}
      </form>
    </Sheet>
  )
}

function PolicyPanel({ d, onPolicy }: { d: Dmarc; onPolicy: () => void }) {
  const p = d.policy
  const rec = d.recommendation
  const next = stepLabel(rec.next)
  const safe = rec.next ? (rec.next.p === "reject" ? rec.safeToReject : rec.safeToQuarantine) : false
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/domains/${d.domain.id}/dmarc → policy, recommendation · PATCH …/dmarc?dryRun=1`}
      data-od-id="panel-policy"
      aria-labelledby="h-policy"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-policy">
          Policy
        </h2>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          {p.lookupError ? (
            <div className="callout callout-warn" role="status">
              <Icon name="warn" />
              <span>
                <b>Couldn’t read the published record.</b> {p.lookupError}
              </span>
            </div>
          ) : null}
          <dl className="kv dm-kv">
            <dt>Current record</dt>
            <dd>
              {p.record ? (
                <span className="mono">{p.record}</span>
              ) : (
                <span className="muted">No DMARC record</span>
              )}
            </dd>
            {p.records.length > 1 ? (
              <>
                <dt>Published</dt>
                <dd>
                  <span className="pill pill-fail">{p.records.length} records</span> Receivers ignore them
                  all; delete the extras by hand.
                </dd>
              </>
            ) : null}
            <dt>Policy</dt>
            <dd>{p.p ? <b>{P_LABEL[p.p]}</b> : <span className="muted">None published</span>}</dd>
            {num(p.pct) !== null && (num(p.pct) ?? 100) < 100 ? (
              <>
                <dt>Applies to</dt>
                <dd>{fmtInt(p.pct)}% of failing mail</dd>
              </>
            ) : null}
            <dt>Unknown failing</dt>
            <dd>{pct(rec.unknownFailShare)} of messages, from sources nobody marked known</dd>
          </dl>
          {next ? (
            safe ? (
              <div className="callout callout-ok" role="status">
                <Icon name="check-circle" />
                <span>
                  <b>Safe to move to {next}.</b> Every source failing DMARC is known, so receivers would only
                  act on mail that isn’t yours.
                </span>
              </div>
            ) : (
              <div className="callout callout-warn" role="status">
                <Icon name="warn" />
                <span>
                  <b>Not yet safe to move to {next}.</b>{" "}
                  {rec.blockers.length
                    ? rec.blockers.map((b) => b.message).join(" ")
                    : "Some mail still fails."}
                </span>
              </div>
            )
          ) : (
            <div className="callout callout-ok" role="status">
              <Icon name="check-circle" />
              <span>
                <b>At the strongest policy.</b> Receivers refuse mail that fails DMARC.
              </span>
            </div>
          )}
          {rec.nextRecord ? (
            <div className="stack stack-8">
              <span className="label">{safe ? "Change to" : "When those pass, change to"}</span>
              <CodeBlock title={`_dmarc.${d.domain.name}`} code={rec.nextRecord} wrap />
            </div>
          ) : null}
          <div>
            <button className="btn btn-secondary" type="button" onClick={onPolicy}>
              <Icon name="eye" />
              Preview the DNS change
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

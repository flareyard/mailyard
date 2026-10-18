/**
 * Transactional → Suppressions (design: transactional/suppressions*.html; HAL-3372, HANDOFF-ops §12–14): the
 * list with per-reason counts and URL filters, and Cloudflare's own account list beside it. Production has no
 * Cloudflare token, so "not connected" is drawn as the normal state: the list still blocks before every send.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { type FormEvent, useEffect, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { BuiltPill, Empty, Time } from "../../ops/kit.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel, PanelSkeleton } from "../../ui/Panel.tsx"
import { AdminOnly, Pill, Refusal } from "../keys/ui.tsx"
import { HeadActions } from "../Layout.tsx"
import { activeFilters, blocksLabel, CF, type Filters, filtersQuery, REASON, SOURCE } from "./logic.ts"
import { supsQuery } from "./queries.ts"
import { AddSheet, RemoveResultNote, takeRemoval } from "./SupSheets.tsx"
import "../keys/keys.css"

const route = getRouteApi("/_app/transactional/suppressions/")

type CfStatus = {
  readable: boolean
  writable: boolean
  checkedAt: number | string | null
  cloudflareOnly: number | string
  error: string | null
}

export function SuppressionsPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const filters: Filters = {
    ...(search.reason ? { reason: search.reason } : {}),
    ...(search.source ? { source: search.source } : {}),
    ...(search.cloudflare ? { cloudflare: search.cloudflare } : {}),
    ...(search.q ? { q: search.q } : {}),
    ...(search.cursor ? { cursor: search.cursor } : {}),
  }
  const q = useQuery(supsQuery(filters))
  const fixture = {
    ...(search.state ? { state: search.state } : {}),
    ...(search.as ? { as: search.as } : {}),
  }
  const setFilters = (f: Filters) => navigate({ search: { ...f, ...fixture } })
  const cf = q.data?.cloudflare
  const chips = activeFilters(filters)
  const missing = (q.data?.suppressions ?? []).filter((s) => s.cloudflare === "missing").length
  const [removed] = useState(takeRemoval)

  return (
    <>
      <HeadActions>
        <Link
          className="btn btn-secondary"
          to="/transactional/suppressions/import"
          search={fixture}
          data-endpoint="POST /v1/suppressions/import (built, HAL-3372)"
        >
          <Icon name="upload" />
          Import CSV
        </Link>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => navigate({ search: (p) => ({ ...p, sheet: "add" as const }) })}
          data-endpoint="POST /v1/suppressions (built, HAL-3372)"
        >
          <Icon name="plus" />
          Add address
        </button>
      </HeadActions>
      {removed ? (
        <div style={{ marginBottom: 16 }}>
          <RemoveResultNote r={removed} />
        </div>
      ) : null}
      {q.data ? <Counts counts={q.data.counts} current={filters.reason} fixture={fixture} /> : null}
      <FilterBar filters={filters} onApply={setFilters} />
      {chips.length ? (
        <div className="active-filters" data-od-id="active-filters">
          {chips.map((c) => {
            const { [c.key]: _drop, cursor: _c, ...rest } = filters
            return (
              <span key={c.key} className="fchip">
                {c.label} <b>{c.value}</b>
                <Link
                  to="/transactional/suppressions"
                  search={{ ...rest, ...fixture }}
                  aria-label={`Remove filter ${c.label} ${c.value}`}
                >
                  <Icon name="x" className="icon-12" />
                </Link>
              </span>
            )
          })}
          <Link className="link-quiet" to="/transactional/suppressions" search={fixture}>
            Clear all
          </Link>
        </div>
      ) : null}
      <div className="split-2 sup-split">
        <div className="stack">
          <Panel
            id="suppressions"
            title="Suppression list"
            endpoint="GET /v1/suppressions?reason=&source=&cloudflare=&q=&cursor= (built, HAL-3372)"
            query={q}
            meta={
              <span className="cluster tb-meta">
                Newest first
                <BuiltPill issue="HAL-3372" />
              </span>
            }
            skeleton={<PanelSkeleton rows={6} />}
            isEmpty={(d) => d.suppressions.length === 0}
            empty={
              chips.length ? (
                <Empty icon="search" title="Nothing matches these filters">
                  Address search matches the start of an address.{" "}
                  <Link to="/transactional/suppressions" search={fixture}>
                    Clear the filters
                  </Link>{" "}
                  to see every suppression.
                </Empty>
              ) : (
                <Empty
                  icon="suppress"
                  title="Nothing suppressed"
                  action={
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => navigate({ search: (p) => ({ ...p, sheet: "add" as const }) })}
                    >
                      <Icon name="plus" className="icon-12" />
                      Add an address
                    </button>
                  }
                >
                  When an address hard-bounces or someone marks you as spam, it lands here and later sends
                  skip it. You can also add one by hand or import a list from your old provider.
                </Empty>
              )
            }
          >
            {(d) => (
              <>
                {filters.cloudflare === "missing" && missing ? (
                  <div className="callout callout-warn" style={{ marginBottom: 12 }}>
                    <Icon name="warn" />
                    <span>
                      <b>
                        {missing === 1 ? "1 address isn’t" : `${fmtInt(missing)} addresses aren’t`} on
                        Cloudflare’s list.
                      </b>{" "}
                      Mailyard blocks {missing === 1 ? "it" : "them"}, but a send through SMTP or another tool
                      on this account would still go out. Push from the detail page.
                    </span>
                  </div>
                ) : null}
                <div className="table-wrap rtable-wrap">
                  <table className="rtable">
                    <thead>
                      <tr>
                        <th>Address</th>
                        <th>Source</th>
                        <th>On Cloudflare</th>
                        <th>Message</th>
                        <th>Since</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.suppressions.map((s) => (
                        <tr key={s.email}>
                          <td className="is-head">
                            <div className="cell-main">
                              <Link
                                className="mono tb-url"
                                to="/transactional/suppressions/$email"
                                params={{ email: s.email }}
                                search={fixture}
                              >
                                {s.email}
                              </Link>
                              <span className="cell-sub">
                                {blocksLabel(s)}
                                {s.note ? ` · ${s.note}` : ""}
                              </span>
                            </div>
                          </td>
                          <td data-label="Source">{SOURCE[s.source]}</td>
                          <td data-label="On Cloudflare">
                            <Pill tone={CF[s.cloudflare].tone}>{CF[s.cloudflare].label}</Pill>
                          </td>
                          <td data-label="Message">
                            {s.messageId ? (
                              <Link
                                className="link mono"
                                to="/transactional/messages/$id"
                                params={{ id: s.messageId }}
                              >
                                {s.messageId}
                              </Link>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td data-label="Since">
                            <Time value={s.at} />
                          </td>
                          <td className="is-aside">
                            <Pill tone={REASON[s.reason].tone}>{REASON[s.reason].label}</Pill>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Panel>
          {q.data ? (
            <footer className="cluster tb-between tb-pager">
              <span className="url-state">
                <Icon name="link" className="icon-12" />
                This view is a link: <code className="mono">{filtersQuery(filters)}</code>
              </span>
              <span className="cluster">
                {filters.cursor ? (
                  <Link
                    className="btn btn-secondary btn-sm"
                    to="/transactional/suppressions"
                    search={{ ...withoutCursor(filters), ...fixture }}
                  >
                    <Icon name="chevron-left" className="icon-12" />
                    Newest
                  </Link>
                ) : null}
                {q.data.nextCursor ? (
                  <Link
                    className="btn btn-secondary btn-sm"
                    to="/transactional/suppressions"
                    search={{ ...filters, cursor: q.data.nextCursor, ...fixture }}
                  >
                    Older
                    <Icon name="chevron-right" className="icon-12" />
                  </Link>
                ) : null}
              </span>
            </footer>
          ) : null}
        </div>
        <div className="stack">
          {cf ? <CloudflarePanel cf={cf} /> : q.isPending ? <PanelSkeleton rows={4} /> : null}
        </div>
      </div>
      {search.sheet === "add" ? (
        <AddSheet
          writable={cf?.writable ?? false}
          onClose={() =>
            navigate({
              search: (p) => {
                const { sheet: _s, ...rest } = p
                return rest
              },
            })
          }
        />
      ) : null}
    </>
  )
}

function withoutCursor(f: Filters): Filters {
  const { cursor: _c, ...rest } = f
  return rest
}

function Counts({
  counts,
  current,
  fixture,
}: {
  counts: {
    total: number | string
    hard_bounce: number | string
    complaint: number | string
    unsubscribe: number | string
    manual: number | string
  }
  current: Filters["reason"]
  fixture: Record<string, string>
}) {
  const figs = [
    { reason: "hard_bounce" as const, n: counts.hard_bounce },
    { reason: "complaint" as const, n: counts.complaint },
    { reason: "unsubscribe" as const, n: counts.unsubscribe },
    { reason: "manual" as const, n: counts.manual },
  ]
  return (
    <div className="big-figures" style={{ marginBottom: 16 }}>
      <Link
        className="fig"
        to="/transactional/suppressions"
        search={fixture}
        aria-current={current ? undefined : "true"}
      >
        <span className="stat-label">All</span>
        <span className="stat-value">{fmtInt(counts.total)}</span>
      </Link>
      {figs.map((f) => (
        <Link
          key={f.reason}
          className="fig"
          to="/transactional/suppressions"
          search={{ reason: f.reason, ...fixture }}
          aria-current={current === f.reason ? "true" : undefined}
        >
          <span className="stat-label">{REASON[f.reason].label}</span>
          <span className="stat-value">{fmtInt(f.n)}</span>
        </Link>
      ))}
    </div>
  )
}

function FilterBar({ filters, onApply }: { filters: Filters; onApply: (f: Filters) => void }) {
  const [q, setQ] = useState(filters.q ?? "")
  const [reason, setReason] = useState(filters.reason ?? "")
  const [source, setSource] = useState(filters.source ?? "")
  const [cloudflare, setCloudflare] = useState(filters.cloudflare ?? "")
  // The URL owns the filters: following a chip or a count link resets the form to match.
  useEffect(() => {
    setQ(filters.q ?? "")
    setReason(filters.reason ?? "")
    setSource(filters.source ?? "")
    setCloudflare(filters.cloudflare ?? "")
  }, [filters.q, filters.reason, filters.source, filters.cloudflare])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onApply({
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(reason ? { reason: reason as Filters["reason"] & string } : {}),
      ...(source ? { source: source as Filters["source"] & string } : {}),
      ...(cloudflare ? { cloudflare: cloudflare as Filters["cloudflare"] & string } : {}),
    } as Filters)
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: <search> isn't styled by the design; the form keeps role=search
    <form className="filterbar" method="get" onSubmit={submit} role="search" aria-label="Filter suppressions">
      <div className="field is-wide">
        <label className="label" htmlFor="s-q">
          Address
        </label>
        <input
          className="input mono"
          id="s-q"
          name="q"
          type="search"
          placeholder="name@domain"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="s-reason">
          Reason
        </label>
        <select
          className="select"
          id="s-reason"
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          <option value="">Any reason</option>
          <option value="hard_bounce">Hard bounce</option>
          <option value="complaint">Complaint</option>
          <option value="unsubscribe">Unsubscribe</option>
          <option value="manual">Added by hand</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="s-source">
          Source
        </label>
        <select
          className="select"
          id="s-source"
          name="source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">Any source</option>
          <option value="events">Delivery event</option>
          <option value="cloudflare">Cloudflare’s list</option>
          <option value="manual">By hand</option>
          <option value="import">CSV import</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="s-cloudflare">
          On Cloudflare
        </label>
        <select
          className="select"
          id="s-cloudflare"
          name="cloudflare"
          value={cloudflare}
          onChange={(e) => setCloudflare(e.target.value)}
        >
          <option value="">Any state</option>
          <option value="in-sync">In sync</option>
          <option value="missing">Missing on Cloudflare</option>
          <option value="not-applicable">Not pushed: bulk only</option>
          <option value="unchecked">Not checked yet</option>
        </select>
      </div>
      <button className="btn btn-secondary" type="submit">
        <Icon name="filter" className="icon-12" />
        Apply
      </button>
    </form>
  )
}

function CloudflarePanel({ cf }: { cf: CfStatus }) {
  const qc = useQueryClient()
  const sync = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/suppressions/sync")),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppressions"] }),
  })
  const connected = cf.readable
  const r = sync.data
  const only = num(cf.cloudflareOnly) ?? 0
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/suppressions → cloudflare · POST /v1/suppressions/sync (built, HAL-3372)"
      data-od-id="panel-cf-sync"
      aria-labelledby="h-cf-sync"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-cf-sync">
          Cloudflare’s suppression list
        </h2>
        <div className="cluster">
          <BuiltPill issue="HAL-3372" />
          <AdminOnly
            allowed={connected}
            reason="Cloudflare isn’t connected"
            who="This deploy has no Cloudflare API token. Add one with Email Sending read (to sync) and write (to push) to the Worker’s secrets; Mailyard picks it up on the next request."
            side="right"
          >
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              aria-disabled={sync.isPending}
              onClick={() => !sync.isPending && sync.mutate()}
              data-endpoint="POST /v1/suppressions/sync (built, HAL-3372)"
            >
              <Icon name="refresh" className="icon-12" />
              {sync.isPending ? "Syncing…" : "Sync now"}
            </button>
          </AdminOnly>
        </div>
      </header>
      <div className="panel-body">
        {r ? (
          r.connected ? (
            <div className="callout callout-ok" style={{ marginBottom: 12 }}>
              <Icon name="check-circle" />
              <span>
                <b>Synced just now.</b>{" "}
                {num(r.adopted)
                  ? `${fmtInt(r.adopted)} permanent Cloudflare ${num(r.adopted) === 1 ? "entry" : "entries"} Mailyard didn’t know about ${num(r.adopted) === 1 ? "was" : "were"} adopted (a bounce whose event never arrived). `
                  : "Nothing new to adopt. "}
                {num(r.cloudflareOnly)
                  ? `${fmtInt(r.cloudflareOnly)} temporary entries stay with Cloudflare.`
                  : ""}
                {r.complete ? "" : " The list is long, so the next sync picks up where this one stopped."}
              </span>
            </div>
          ) : (
            <div className="callout callout-warn" style={{ marginBottom: 12 }} role="status">
              <Icon name="warn" />
              <span>
                <b>Nothing to sync.</b> <span className="mono">POST /v1/suppressions/sync</span> answered{" "}
                <span className="mono">{"{ connected: false }"}</span>: with no token, Mailyard can’t read
                Cloudflare’s list. Your own list is unchanged and still checked before every send.
              </span>
            </div>
          )
        ) : null}
        {r?.error ? (
          <div className="callout callout-error" style={{ marginBottom: 12 }}>
            <Icon name="warn" />
            <span>
              <b>Cloudflare answered with an error.</b> {r.error}
            </span>
          </div>
        ) : null}
        <Refusal error={sync.error} what="Sync didn’t run." />
        {!connected ? (
          <div className="callout callout-info" style={{ marginBottom: 12 }}>
            <Icon name="info" />
            <span>
              <b>Your list still works.</b> Mailyard checks it before every send, so blocked sends are never
              billed. What’s missing is Cloudflare’s own account list: Mailyard can’t see it (so it can’t
              adopt bounces whose event never arrived) and can’t push to it (so a send through SMTP or another
              tool on this account isn’t blocked).
            </span>
          </div>
        ) : null}
        <dl className="kv">
          <dt>Cloudflare</dt>
          <dd>
            {connected ? (
              <Pill tone="pill-pass">{cf.writable ? "Read and write" : "Read only"}</Pill>
            ) : (
              <>
                <Pill tone="pill-neutral">Not connected</Pill>{" "}
                <span className="muted t-small">readable: false · writable: false</span>
              </>
            )}
          </dd>
          <dt>Last checked</dt>
          <dd>
            {cf.checkedAt ? (
              <>
                <Time value={cf.checkedAt} /> · runs every hour
              </>
            ) : (
              <>
                <span className="muted">Never</span> <span className="muted t-small">· checkedAt: null</span>
              </>
            )}
          </dd>
          <dt>Only on Cloudflare</dt>
          <dd>
            {connected ? (
              only ? (
                `${fmtInt(only)} temporary entr${only === 1 ? "y" : "ies"}, left to expire there`
              ) : (
                "None"
              )
            ) : (
              <span className="muted">Unknown until it’s connected</span>
            )}
          </dd>
          <dt>Last error</dt>
          <dd>{cf.error ? <span className="mono">{cf.error}</span> : <span className="muted">None</span>}</dd>
        </dl>
        {!connected ? (
          <Link className="btn btn-secondary btn-sm" to="/settings/sending" style={{ marginTop: 12 }}>
            <Icon name="external" className="icon-12" />
            How to connect Cloudflare
          </Link>
        ) : null}
      </div>
      <footer className="panel-foot">
        <span>
          {connected ? "Cloudflare keeps its own account list. " : ""}Unsubscribes and bulk-only rows are
          never pushed
          {connected ? "" : ", connected or not"}: they would block transactional mail too.
        </span>
      </footer>
    </section>
  )
}

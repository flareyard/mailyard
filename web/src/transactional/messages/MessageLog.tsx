/**
 * The message log (design: transactional/messages*.html; HANDOFF-ops §22, HAL-3413). Every filter is in the
 * URL and maps one to one onto GET /v1/messages, so a filtered view is a link. The first page refreshes on its
 * own ("live"); "Older" walks back with the API's cursor.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useEffect, useId } from "react"
import { ApiError } from "../../api/client.ts"
import { fmtInt } from "../../lib/format.ts"
import { fromLocalInput, toLocalInput, utcFull, utcTime } from "../../ops/format.ts"
import { BuiltPill } from "../../ops/kit.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError } from "../../ui/Panel.tsx"
import {
  chips,
  echo,
  hasFilters,
  type LogSearch,
  logQuery,
  parseLogSearch,
  rowNote,
  STATUSES,
  STREAM_LABEL,
  STREAMS,
  sentBy,
  statusPill,
  without,
} from "../logic.ts"
import {
  type MessageRow,
  messagesQuery,
  useCampaignNames,
  useKeyNames,
  useTemplateNames,
} from "../queries.ts"

const route = getRouteApi("/_app/transactional/messages/")
const ENDPOINT = "GET /v1/messages?status=&stream=&templateId=&q=&from=&to=&cursor=&limit= (built, HAL-3413)"
const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1)

export function MessageLog() {
  const search = route.useSearch()
  const navigate = useNavigate()

  // A design link (`?open=msg_…`) hands over to the message's own page.
  useEffect(() => {
    if (search.open)
      navigate({ to: "/transactional/messages/$id", params: { id: search.open }, replace: true })
  }, [search.open, navigate])

  const q = useQuery(messagesQuery(search))
  const templates = useTemplateNames()
  const keys = useKeyNames()
  const campaigns = useCampaignNames()
  const go = (s: LogSearch) => navigate({ to: "/transactional/messages", search: s })
  const active = chips(search, (id) => templates.get(id))
  const rows = q.data?.messages ?? []

  return (
    <>
      <Filters search={search} templates={templates} onApply={go} />
      {active.length ? (
        <div className="active-filters" data-od-id="active-filters">
          {active.map((c) => (
            <span className="fchip" key={c.key}>
              {c.label} <b>{c.value}</b>
              <Link
                to="/transactional/messages"
                search={without(search, c.key)}
                aria-label={`Remove filter ${c.label} ${c.value}`}
              >
                <Icon name="x" />
              </Link>
            </span>
          ))}
          <Link className="link-quiet" to="/transactional/messages" search={{}}>
            Clear all
          </Link>
        </div>
      ) : null}
      <section
        className={`panel${q.isError ? " is-error" : ""}`}
        data-endpoint={ENDPOINT}
        data-od-id="panel-message-log"
        aria-labelledby="h-message-log"
        aria-busy={q.isPending}
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-message-log">
            Message log
          </h2>
          <div className="cluster">
            {q.isPending ? (
              <span className="panel-meta">
                <span className="sk sk-text" style={{ width: 80, display: "inline-block" }} />
              </span>
            ) : q.isSuccess && rows.length ? (
              <>
                <span className="panel-meta">{search.cursor ? "Older sends, UTC" : "Newest first, UTC"}</span>
                <BuiltPill issue="HAL-3413" />
              </>
            ) : null}
          </div>
        </header>
        <div className="panel-body">
          {q.isPending ? (
            <LogSkeleton />
          ) : q.isError ? (
            <LogError error={q.error} search={search} onRetry={() => q.refetch()} />
          ) : !rows.length ? (
            hasFilters(search) ? (
              <NoMatch search={search} />
            ) : (
              <div className="empty" data-od-id="empty-state">
                <span className="empty-icon">
                  <Icon name="send" />
                </span>
                <h3>{search.cursor ? "No older sends" : "No sends yet"}</h3>
                <p>
                  Every message your app, campaigns, automations and mailboxes send lands here with its
                  delivery trail. Copy a snippet from the quick start and send one to yourself.
                </p>
                <Link className="btn btn-primary" to="/transactional/quickstart">
                  <Icon name="code" />
                  Send your first email
                </Link>
              </div>
            )
          ) : (
            <table className="rtable" data-od-id="message-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Recipient and subject</th>
                  <th>Template</th>
                  <th>Source</th>
                  <th>Sent by</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <Row key={m.id} m={m} templates={templates} keys={keys} campaigns={campaigns} />
                ))}
              </tbody>
            </table>
          )}
        </div>
        {q.isSuccess && (rows.length || hasFilters(search)) ? (
          <footer className="panel-foot">
            <span className="url-state">
              <Icon name="link" />
              This view is a link: <code className="mono">{echo(search)}</code>
            </span>
            {rows.length ? (
              <span className="cluster">
                <span>
                  {hasFilters(search) || search.cursor
                    ? `${fmtInt(rows.length)} shown · newest first`
                    : `Last ${fmtInt(rows.length)} · newest first · live`}
                </span>
                {search.cursor ? (
                  <Link
                    className="btn btn-ghost btn-sm"
                    to="/transactional/messages"
                    search={without(search, "cursor")}
                  >
                    Newest
                  </Link>
                ) : null}
                {q.data?.nextCursor ? (
                  <Link
                    className="btn btn-secondary btn-sm"
                    to="/transactional/messages"
                    search={{ ...without(search, "cursor"), cursor: q.data.nextCursor }}
                  >
                    Older
                    <Icon name="chevron-right" />
                  </Link>
                ) : null}
              </span>
            ) : null}
          </footer>
        ) : null}
      </section>
    </>
  )
}

function Row({
  m,
  templates,
  keys,
  campaigns,
}: {
  m: MessageRow
  templates: Map<string, string>
  keys: Map<string, { name: string; prefix: string }>
  campaigns: Map<string, string>
}) {
  const pill = statusPill(m.status, m.bounceType)
  const note = rowNote(m)
  const by = sentBy(m, keys, campaigns)
  const tpl = m.templateId ? (templates.get(m.templateId) ?? m.templateId) : null
  return (
    <tr data-od-id={`msg-${m.id}`}>
      <td className="nowrap" data-label="Time">
        <time dateTime={new Date(Number(m.createdAt)).toISOString()} title={utcFull(m.createdAt)}>
          {utcTime(m.createdAt, true)}
        </time>
      </td>
      <td className="is-head">
        <div className="cell-main">
          <Link className="mono" to="/transactional/messages/$id" params={{ id: m.id }}>
            {m.recipient}
          </Link>
          <span className="cell-sub">{m.subject}</span>
          {note ? (
            <span
              className="cell-sub"
              style={{ color: `var(--${note.tone === "warn" ? "amber" : "red"}-900)` }}
            >
              {note.text}
            </span>
          ) : null}
        </div>
      </td>
      <td data-label="Template">
        {tpl ? (
          <>
            <span className="mono">{tpl}</span>
            {m.templateVersion !== null ? <span className="muted num"> v{m.templateVersion}</span> : null}
          </>
        ) : (
          <span className="muted">None</span>
        )}
      </td>
      <td data-label="Source">
        <span className="tag src-chip" data-source={m.source}>
          {m.source}
        </span>
        <span className="cell-sub" style={{ display: "block" }}>
          {STREAM_LABEL[m.stream] ?? m.stream}
        </span>
      </td>
      <td data-label="Sent by">
        <span className="cell-sub" style={{ color: "var(--my-fg)" }}>
          {by.kind === "key" && !by.prefix ? <span className="mono">{by.name}</span> : by.name}
        </span>
      </td>
      <td className="is-aside">
        <span className={`pill pill-${pill.tone}`}>
          <span className="dot" />
          {pill.label}
        </span>
      </td>
    </tr>
  )
}

/** The filter bar (`form.filterbar`): a plain GET form, so it works as a link; the router owns the URL. */
function Filters({
  search,
  templates,
  onApply,
}: {
  search: LogSearch
  templates: Map<string, string>
  onApply: (s: LogSearch) => void
}) {
  const id = useId()
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const raw: Record<string, unknown> = {}
    for (const [k, v] of f.entries()) raw[k] = String(v)
    const from = fromLocalInput(String(f.get("from") ?? ""))
    const to = fromLocalInput(String(f.get("to") ?? ""))
    onApply(parseLogSearch({ ...raw, from: from ?? undefined, to: to ?? undefined }))
  }
  // The form is keyed by the view, so Back/Forward and chip removal reset what it shows.
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design's form.filterbar[role=search]; <search> would add a wrapper the CSS doesn't expect
    <form
      key={JSON.stringify(logQuery(search))}
      className="filterbar"
      method="get"
      onSubmit={submit}
      data-od-id="message-filters"
      role="search"
      aria-label="Filter messages"
    >
      <div className="field is-wide">
        <label className="label" htmlFor={`${id}-q`}>
          Search
        </label>
        <input
          className="input mono"
          id={`${id}-q`}
          name="q"
          type="search"
          defaultValue={search.q ?? ""}
          placeholder="msg_…, a Cloudflare id, or ada@…"
          aria-describedby={`${id}-qh`}
        />
        <span className="hint" id={`${id}-qh`}>
          An exact message id or Cloudflare id, or the start of a recipient address.
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-status`}>
          Status
        </label>
        <select className="select" id={`${id}-status`} name="status" defaultValue={search.status ?? ""}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {cap(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-stream`}>
          Stream
        </label>
        <select className="select" id={`${id}-stream`} name="stream" defaultValue={search.stream ?? ""}>
          <option value="">Any stream</option>
          {STREAMS.map((s) => (
            <option key={s} value={s}>
              {STREAM_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-tpl`}>
          Template
        </label>
        <select className="select" id={`${id}-tpl`} name="templateId" defaultValue={search.templateId ?? ""}>
          <option value="">Any template</option>
          {[...templates].map(([tid, name]) => (
            <option key={tid} value={tid}>
              {name}
            </option>
          ))}
          {search.templateId && !templates.has(search.templateId) ? (
            <option value={search.templateId}>{search.templateId}</option>
          ) : null}
        </select>
      </div>
      <fieldset className="field f-range" aria-describedby={`${id}-rh`}>
        <legend className="label">Sent between</legend>
        <div className="f-range-inputs">
          <input
            className="input"
            type="datetime-local"
            name="from"
            defaultValue={toLocalInput(search.from)}
            aria-label="From (UTC)"
          />
          <span aria-hidden="true">–</span>
          <input
            className="input"
            type="datetime-local"
            name="to"
            defaultValue={toLocalInput(search.to)}
            aria-label="To (UTC)"
          />
        </div>
        <span className="hint" id={`${id}-rh`}>
          UTC. Sent as <span className="mono">from</span> and <span className="mono">to</span> in epoch ms.
        </span>
      </fieldset>
      <button className="btn btn-secondary" type="submit">
        <Icon name="filter" className="icon-12" />
        Apply
      </button>
    </form>
  )
}

function LogSkeleton() {
  const widths = [70, 83, 96, 79, 92, 75]
  return (
    <table className="rtable" aria-busy="true">
      <tbody>
        {Array.from({ length: 6 }, (_, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          <tr key={r}>
            {widths.map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
              <td key={i}>
                <span className="sk sk-text" style={{ width: `${((w + r * 7) % 40) + 55}%` }} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function LogError({ error, search, onRetry }: { error: unknown; search: LogSearch; onRetry: () => void }) {
  const e = error instanceof ApiError ? error : null
  const qs = new URLSearchParams(logQuery(search)).toString()
  return (
    <div data-od-id="error-block">
      <PanelError error={error} onRetry={onRetry} what="The message log didn’t load" />
      <p className="hint" style={{ marginTop: 8 }}>
        <code className="mono">GET /v1/messages?{qs}</code>
        {e ? ` answered ${e.status}.` : " didn’t answer."} Filters are kept in the address bar, so Retry asks
        for exactly this view again.
      </p>
    </div>
  )
}

function NoMatch({ search }: { search: LogSearch }) {
  return (
    <div className="empty" data-od-id="empty-state">
      <span className="empty-icon">
        <Icon name="search" />
      </span>
      <h3>No messages match</h3>
      <p>
        {search.q ? (
          <>
            Search matches an exact message id or Cloudflare id, or the <b>start</b> of a recipient address,
            so <span className="mono">{search.q}</span> finds addresses beginning with it.{" "}
          </>
        ) : null}
        Widen the dates or clear a filter.
      </p>
      <Link className="btn btn-secondary" to="/transactional/messages" search={{}}>
        Clear all
      </Link>
    </div>
  )
}

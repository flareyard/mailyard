/**
 * Search all mailboxes (search-all.html, GET /v1/search/mail, HAL-3363): one search across every mailbox you
 * can read within the server's 2.5 s budget, grouped by mailbox, the operators the server applied as chips,
 * the sort, and a note naming any mailbox that didn't answer.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { fixturesEnabled } from "../../fixtures/mode.ts"
import { num } from "../../lib/format.ts"
import { usePageTitle } from "../../shell/title.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError } from "../../ui/Panel.tsx"
import { removeOperator, rowTime, stripMarks } from "../logic.ts"
import { mailboxesQuery, searchAllQuery } from "../queries.ts"
import { Hl, SampleMarker, ToolBtn, Who } from "../ui.tsx"

export function SearchAll() {
  const search = useSearch({ from: "/_app/mail/search" })
  const navigate = useNavigate()
  const boxes = useQuery(mailboxesQuery)
  const q = useQuery(searchAllQuery(search.q ?? "", search.sort))
  const [value, setValue] = useState(search.q ?? "")
  const input = useRef<HTMLInputElement>(null)
  usePageTitle("Search all mailboxes")
  useEffect(() => setValue(search.q ?? ""), [search.q])
  useEffect(() => {
    const main = document.getElementById("main")
    main?.classList.add("mail-content")
    if (!search.q) input.current?.focus()
    return () => main?.classList.remove("mail-content")
  }, [search.q])
  const go = (text: string, sort = search.sort) =>
    navigate({
      to: "/mail/search",
      search: { ...(text.trim() ? { q: text.trim() } : {}), ...(sort ? { sort } : {}) },
    })
  const readable = (boxes.data?.mailboxes ?? []).filter((m) => m.holdsMail)
  const d = q.data
  const results = d?.groups.reduce((n, g) => n + g.threads.length, 0) ?? 0
  const addressOf = (id: string) => readable.find((m) => m.id === id)?.address ?? id
  return (
    <div className="mail mail-search-all" data-pane="list">
      <section
        className="mail-list"
        aria-label="Search all mailboxes"
        data-endpoint="GET /v1/search/mail?q=&sort="
        data-url={`/mail/search?q=${encodeURIComponent(search.q ?? "")}`}
      >
        <div className="ml-head">
          <div className="ml-title-row">
            <Link className="icon-btn only-phone" to="/mail" aria-label="Back to Mail">
              <Icon name="chevron-left" />
            </Link>
            <div className="ml-title">
              <h1>Search</h1>
              <span className="ml-sub">
                {readable.map((m) => `${m.address.split("@")[0]}@`).join(" · ") ||
                  "every mailbox you can read"}
              </span>
            </div>
            {fixturesEnabled() ? (
              <span className="hide-phone">
                <SampleMarker />
              </span>
            ) : null}
          </div>
          <div className="ml-search" data-endpoint="GET /v1/search/mail?q=">
            <div className="input-group">
              <span className="addon">
                <Icon name="search" />
              </span>
              <input
                ref={input}
                className="input"
                type="search"
                aria-label="Search every mailbox"
                placeholder="Search every mailbox you can read"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    go(value)
                  }
                }}
              />
              <span className="kbd" aria-hidden="true">
                ↵
              </span>
            </div>
            {d?.parsed && (d.parsed.operators.length || d.parsed.terms.length) ? (
              <div
                className="cluster cluster-4"
                style={{ marginTop: 8 }}
                data-label="Operators the server applied"
                data-endpoint="search/mail → parsed"
              >
                {d.parsed.operators.map((o) => (
                  <span key={`${o.op}:${o.value}`} className="op-chip">
                    <span className="op-k">{o.op}:</span>
                    {o.value}
                    <button
                      type="button"
                      aria-label={`Remove ${o.op}:`}
                      onClick={() => go(removeOperator(search.q ?? "", o.op, o.value))}
                    >
                      <Icon name="x" />
                    </button>
                  </span>
                ))}
                {d.parsed.terms.length ? (
                  <span className="t-small muted" style={{ paddingLeft: 4 }}>
                    + words: {d.parsed.terms.join(" ")}
                  </span>
                ) : null}
              </div>
            ) : null}
            {d?.parsed?.unsupported.length ? (
              <p className="field-error" role="status" style={{ marginTop: 6, color: "var(--amber-900)" }}>
                <span>
                  Ignored:{" "}
                  <span className="mono">
                    {d.parsed.unsupported.map((u) => `${u.op}:${u.value}`).join(", ")}
                  </span>
                  , which search doesn’t understand.
                </span>
              </p>
            ) : null}
          </div>
          <div className="spread" style={{ paddingBottom: 10, flexWrap: "wrap", gap: 8 }}>
            {readable[0] ? (
              <Link
                className="switch"
                to="/mail/$mailboxId/search"
                params={{ mailboxId: readable[0].id }}
                search={{ q: search.q } as never}
              >
                <span className="mail-switch is-on" aria-hidden="true" />
                Search all mailboxes
              </Link>
            ) : null}
          </div>
        </div>
        <div className="ml-tools" role="toolbar" aria-label="List actions">
          <ToolBtn icon="refresh" label="Search again" onClick={() => void q.refetch()} />
          {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
          <div className="seg" role="group" aria-label="Sort results">
            {(["recent", "relevance"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={(search.sort ?? "recent") === s}
                onClick={() => go(search.q ?? "", s === "relevance" ? s : undefined)}
              >
                {s === "recent" ? "Recent" : "Relevance"}
              </button>
            ))}
          </div>
          <span className="ml-count">
            {q.isFetching && !d
              ? "Searching…"
              : search.q
                ? `${results} result${results === 1 ? "" : "s"}`
                : ""}
          </span>
        </div>
        {d?.partial.length ? (
          <div className="ml-note" role="status" data-endpoint="search/mail → searched, partial[]">
            <span className="grow">
              Searched {num(d.searched) ?? 0} of {(num(d.searched) ?? 0) + d.partial.length} mailboxes.{" "}
              {d.partial.map((p, i) => (
                <span key={p.mailboxId}>
                  {i ? ", " : ""}
                  <span className="mono">{addressOf(p.mailboxId)}</span> (
                  {p.reason === "timeout" ? "didn’t answer within 2.5 s" : "failed"})
                </span>
              ))}
              , so {d.partial.length === 1 ? "its" : "their"} results are missing.
            </span>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => void q.refetch()}>
              Search again
            </button>
          </div>
        ) : null}
        <div className="pane-scroll">
          {!search.q ? (
            <ul className="ml-rows" aria-label="Results">
              <li className="empty" style={{ padding: "48px 20px" }}>
                <span className="empty-icon">
                  <Icon name="search" />
                </span>
                <h3>Search every mailbox at once</h3>
                <p>
                  Operators work here too: <span className="mono">from:</span>,{" "}
                  <span className="mono">subject:</span>, <span className="mono">has:attachment</span>,{" "}
                  <span className="mono">after:</span>.
                </p>
              </li>
            </ul>
          ) : q.isPending ? (
            <div style={{ padding: 16 }} aria-busy="true">
              <span className="sk sk-text" />
            </div>
          ) : q.isError ? (
            <div style={{ padding: 16 }}>
              <PanelError error={q.error} onRetry={() => q.refetch()} what="Search didn’t run" />
            </div>
          ) : !results ? (
            <ul className="ml-rows" aria-label="Results">
              <li className="empty" style={{ padding: "40px 20px" }}>
                <span className="empty-icon">
                  <Icon name="search" />
                </span>
                <h3>Nothing matches</h3>
                <p>
                  No thread in any mailbox you can read matches <span className="mono">{search.q}</span>.
                </p>
              </li>
            </ul>
          ) : (
            <ul className="ml-rows" aria-label="Results">
              {d?.groups
                .filter((g) => g.threads.length)
                .flatMap((g) => {
                  const marks = new Map(g.hits.map((h) => [h.threadId, h]))
                  return [
                    <li
                      key={`h:${g.mailboxId}`}
                      className="ml-note"
                      style={{ background: "var(--gray-100)" }}
                    >
                      <span className="mono" style={{ color: "var(--my-fg)" }}>
                        {g.address}
                      </span>
                      <span className="t-small muted" style={{ marginLeft: "auto" }}>
                        {g.threads.length} result{g.threads.length === 1 ? "" : "s"}
                      </span>
                    </li>,
                    ...g.threads.map((t) => {
                      const h = marks.get(t.id)
                      const unread = (num(t.unreadCount) ?? 0) > 0
                      const who =
                        t.participants.find((p) => p.address.toLowerCase() !== g.address.toLowerCase()) ??
                        t.participants[0]
                      return (
                        <li key={`${g.mailboxId}:${t.id}`} className={`tr${unread ? " is-unread" : ""}`}>
                          <div className="tr-gutter">
                            <Who name={who?.name} address={who?.address} className="tr-avatar" />
                          </div>
                          <Link
                            className="tr-body tr-link"
                            to="/mail/$mailboxId/threads/$threadId"
                            params={{ mailboxId: g.mailboxId, threadId: t.id }}
                            search={{ q: search.q } as never}
                            aria-label={`${who?.name ?? who?.address ?? ""}${unread ? ", unread" : ""}: ${h ? stripMarks(h.subjectHighlighted) : t.subject}`}
                          >
                            <span className="tr-l1">
                              <span className="tr-dot" aria-hidden="true" />
                              <span className="tr-names">
                                {t.participants
                                  .map((p) => p.name ?? p.address)
                                  .slice(0, 3)
                                  .join(", ")}
                              </span>
                              <span className="tr-meta">
                                <time>{rowTime(t.lastAt)}</time>
                              </span>
                            </span>
                            <span className="tr-l2">
                              {h ? <Hl text={h.subjectHighlighted} /> : t.subject}
                            </span>
                            <span className="tr-l3">
                              <span className="tr-snip">{h ? <Hl text={h.excerpt} /> : t.snippet}</span>
                            </span>
                          </Link>
                        </li>
                      )
                    }),
                  ]
                })}
            </ul>
          )}
        </div>
      </section>
      <section className="mail-reader" aria-label="Reader">
        <div className="rd-empty">
          <div className="empty">
            <span className="empty-icon">
              <Icon name="mail" />
            </span>
            <h3>Open a result</h3>
            <p>It opens in its own mailbox, with this search kept in the list.</p>
          </div>
        </div>
      </section>
    </div>
  )
}

/**
 * Audience → Contacts (design: contacts*.html; HANDOFF-audience §3 and §6; GAPS-audience A1). Everyone you can
 * email, filtered by URL state that mirrors `GET /v1/contacts` one to one, so every view is a link. Selection
 * never enters the URL. Owners, admins and senders can select, act in bulk and export; agents and viewers read.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useCallback, useMemo, useState } from "react"
import { ApiError } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, RequestId } from "../../ui/Panel.tsx"
import { AudienceHead, contactsTotalQuery } from "../AudienceHead.tsx"
import { errorField, fmtAgoShort, fmtDay, initialsOf } from "../kit/format.ts"
import { allTopicsQuery, type ContactField, fieldLabel, fieldsQuery, segmentsQuery } from "../kit/queries.ts"
import { EmptyState, SkeletonRows, StatusPill, UrlLine, useCan } from "../kit/ui.tsx"
import { BulkBar, BulkJob, type BulkKind, type BulkOutcome, BulkResult, BulkSheet } from "./Bulk.tsx"
import { ContactsToolbar } from "./ContactsToolbar.tsx"
import { ExportSheet } from "./ExportSheet.tsx"
import { FilterSheet } from "./FilterSheet.tsx"
import {
  ariaSort,
  COLUMN_LABEL,
  type ContactsSearch,
  chipsOf,
  clean,
  columnsOf,
  DEFAULT_SORT,
  describeView,
  hasFilters,
  invalidChips,
  MAX_BULK_IDS,
  type Names,
  nextSort,
  type SearchPatch,
  SORT_WORDS,
} from "./logic.ts"
import { NewContactSheet } from "./NewContactSheet.tsx"
import { type ContactRow, contactsQuery, PAGE_SIZE } from "./queries.ts"

export function ContactsPage({ search }: { search: ContactsSearch }) {
  const navigate = useNavigate()
  const go = useCallback(
    (next: SearchPatch, replace = false) =>
      navigate({
        to: "/audience/contacts",
        search: clean(next as Record<string, unknown>) as ContactsSearch,
        replace,
      }),
    [navigate],
  )
  const write = useCan("contacts.write", "change contacts")
  const q = useQuery(contactsQuery(search))
  const total = useQuery(contactsTotalQuery).data ?? null
  const fields = useQuery(fieldsQuery).data ?? []
  const topics = useQuery(allTopicsQuery).data ?? []
  const segments = useQuery(segmentsQuery).data ?? []
  const names: Names = useMemo(
    () => ({
      topic: (id) => topics.find((t) => t.id === id)?.name ?? id,
      segment: (id) => segments.find((s) => s.id === id)?.name ?? id,
      field: (key) => {
        if (key === "email") return "Email"
        if (key === "name") return "Name"
        return fieldLabel(
          fields.find((f) => f.key === key),
          key,
        )
      },
    }),
    [topics, segments, fields],
  )
  const chips = chipsOf(search, names)
  const badRequest = q.error instanceof ApiError && q.error.status === 400 ? q.error : null
  const invalid = invalidChips(chips, badRequest ? errorField(badRequest) : null)
  if (!badRequest) for (const c of chips) if (!c.invalid) invalid.delete(`${c.key}:${c.value}`)
  const columns = columnsOf(
    search.cols,
    fields.map((f) => f.key),
  )
  const sort = search.sort ?? DEFAULT_SORT

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [all, setAll] = useState(false)
  const [bulk, setBulk] = useState<BulkKind | null>(null)
  const [result, setResult] = useState<Extract<BulkOutcome, { mode: "sync" }> | null>(null)
  const rows = q.data?.contacts ?? []
  const matching = num(q.data?.total) ?? null
  const pageIds = rows.map((r) => r.id)
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const count = all ? (matching ?? 0) : selected.size
  const clearSelection = () => {
    setSelected(new Set())
    setAll(false)
  }

  const agentNote = write.me?.role === "agent" || write.me?.role === "viewer"
  return (
    <>
      <AudienceHead
        current="contacts"
        sub="Everyone you can email, what they agreed to, and how they’re engaging."
        actions={
          <>
            <Gated allowed={write.allowed} reason="You can’t import contacts" who={write.who}>
              <Link className="btn btn-secondary btn-sm" to="/audience/imports" data-od-id="import-csv">
                <Icon name="upload" />
                Import CSV
              </Link>
            </Gated>
            <Gated allowed={write.allowed} reason="You can’t add contacts" who={write.who} side="right">
              <button
                className="btn btn-primary btn-sm"
                type="button"
                data-od-id="add-contact"
                data-endpoint="POST /v1/contacts"
                onClick={() => go({ ...search, sheet: "new" }, true)}
              >
                <Icon name="plus" />
                Add contact
              </button>
            </Gated>
          </>
        }
      />
      {!write.allowed ? (
        <div className="callout callout-info" style={{ marginBottom: 12 }}>
          <Icon name="info" />
          <span>
            <b>You can read contacts.</b>{" "}
            {agentNote
              ? "Agents look people up while answering mail. Changing, importing, exporting and deleting is for owners, admins and senders."
              : write.who}
          </span>
        </div>
      ) : null}
      <ContactsToolbar
        search={search}
        go={go}
        chips={chips}
        invalid={invalid}
        columns={columns}
        fields={fields}
        canExport={write.allowed}
        exportWho={write.who}
      />
      <section
        className="panel"
        data-endpoint="GET /v1/contacts?q=&status=&topicId=&engagement=&segmentId=&field=&event=&sort=&cursor=&limit="
        data-od-id="panel-contacts"
        aria-label="Contacts"
        aria-busy={q.isFetching}
      >
        <div className="panel-body stack stack-12">
          <div className="spread">
            {q.data ? (
              <div className="count-line" data-od-id="count-line">
                {hasFilters(search) ? (
                  <>
                    <b>{fmtInt(matching)}</b> of {fmtInt(total)} match
                  </>
                ) : (
                  <>
                    <b>{fmtInt(matching)}</b> contacts
                  </>
                )}
                {rows.length
                  ? ` · showing ${search.cursor ? `${fmtInt(rows.length)} more` : `1–${fmtInt(rows.length)}`} · sorted by ${SORT_WORDS[sort]}`
                  : ""}
              </div>
            ) : (
              <span />
            )}
            <UrlLine />
          </div>
          {search.job ? (
            <BulkJob
              id={search.job}
              topics={topics}
              onDismiss={() => go({ ...search, job: undefined }, true)}
            />
          ) : null}
          {write.allowed && count > 0 ? (
            <BulkBar
              count={count}
              all={all}
              total={matching}
              onAll={() => setAll(true)}
              onPage={() => setAll(false)}
              onAction={setBulk}
            />
          ) : null}
          {result ? <BulkResult outcome={result} topics={topics} onDismiss={() => setResult(null)} /> : null}
          {q.isPending ? (
            <SkeletonRows rows={10} cols={6} />
          ) : badRequest ? (
            <div className="error-block" role="alert" data-od-id="error-block">
              <h3>
                <Icon name="warn" />
                That filter isn’t complete
              </h3>
              <p>
                The list answered <b>400 InvalidRequest</b>. The API says: <b>“{badRequest.message}”</b> Fix
                the highlighted filter, or remove it; the rest of the view is kept.
              </p>
              <div className="cluster">
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  data-od-id="retry"
                  onClick={() => q.refetch()}
                >
                  <Icon name="refresh" />
                  Retry
                </button>
                {badRequest.requestId ? <RequestId id={badRequest.requestId} /> : null}
              </div>
            </div>
          ) : q.isError ? (
            <PanelError error={q.error} onRetry={() => q.refetch()} what="Contacts didn’t load" />
          ) : !rows.length ? (
            hasFilters(search) ? (
              <EmptyState
                icon="filter"
                title="No contacts match these filters"
                action={
                  <Link
                    className="btn btn-secondary btn-sm"
                    to="/audience/contacts"
                    search={search.cols ? { cols: search.cols } : {}}
                  >
                    Clear filters
                  </Link>
                }
              >
                Nobody matches {describeView(search, names)}. Remove a filter to widen the view.
              </EmptyState>
            ) : (
              <EmptyState
                icon="audience"
                title="No contacts yet"
                action={
                  <Gated allowed={write.allowed} reason="You can’t import contacts" who={write.who}>
                    <Link className="btn btn-primary btn-sm" to="/audience/imports">
                      <Icon name="upload" />
                      Import a CSV
                    </Link>
                  </Gated>
                }
              >
                Contacts arrive from a CSV import, a hosted form, or{" "}
                <code className="mono">POST /v1/contacts</code> from your app. Start with the list you already
                have.
              </EmptyState>
            )
          ) : (
            <>
              <div className="table-wrap desk-only">
                <table className="table dt" data-od-id="contacts-table">
                  <thead>
                    <tr>
                      {write.allowed ? (
                        <th className="sel">
                          <label className="check">
                            <input
                              type="checkbox"
                              aria-label="Select all on this page"
                              checked={allOnPage}
                              onChange={(e) => {
                                setAll(false)
                                setSelected(e.target.checked ? new Set(pageIds) : new Set())
                              }}
                            />
                          </label>
                        </th>
                      ) : null}
                      <SortTh
                        column="contact"
                        sort={sort}
                        go={(s) => go({ ...search, sort: s, cursor: undefined }, true)}
                      >
                        Contact
                      </SortTh>
                      {columns.map((c) => (
                        <SortTh
                          key={c}
                          column={c}
                          sort={sort}
                          right={
                            c === "lastActivityAt" ||
                            c === "lastOpenedAt" ||
                            c === "createdAt" ||
                            c === "lastClickedAt"
                          }
                          go={(s) => go({ ...search, sort: s, cursor: undefined }, true)}
                        >
                          {c.startsWith("f.")
                            ? names.field(c.slice(2))
                            : COLUMN_LABEL[c as keyof typeof COLUMN_LABEL]}
                        </SortTh>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const on = all || selected.has(r.id)
                      return (
                        <tr key={r.id} className={on ? "is-selected" : undefined}>
                          {write.allowed ? (
                            <td className="sel">
                              <label className="check">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${r.email}`}
                                  checked={on}
                                  onChange={(e) => {
                                    if (all) {
                                      setAll(false)
                                      setSelected(new Set(pageIds.filter((id) => id !== r.id)))
                                      return
                                    }
                                    const next = new Set(selected)
                                    if (e.target.checked) next.add(r.id)
                                    else next.delete(r.id)
                                    setSelected(next)
                                  }}
                                />
                              </label>
                            </td>
                          ) : null}
                          <td>
                            <Link
                              className="cell-link"
                              to="/audience/contacts/$contactId"
                              params={{ contactId: r.id }}
                            >
                              {r.name || r.email}
                            </Link>
                            <span className="cell-sub mono">{r.email}</span>
                          </td>
                          {columns.map((c) => (
                            <Cell key={c} column={c} row={r} fields={fields} />
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="phone-only" data-od-id="contacts-phone-list">
                {rows.map((r) => (
                  <Link
                    key={r.id}
                    className="mrow"
                    to="/audience/contacts/$contactId"
                    params={{ contactId: r.id }}
                  >
                    <span className="avatar" aria-hidden="true">
                      {initialsOf(r.name, r.email)}
                    </span>
                    <span className="grow">
                      <span className="m-name">{r.name || r.email}</span>
                      <span className="m-mail">{r.email}</span>
                    </span>
                    <StatusPill status={r.status} />
                  </Link>
                ))}
              </div>
              <div className="dt-foot">
                <span>
                  {PAGE_SIZE} per page
                  {search.cursor ? (
                    <>
                      {" "}
                      · cursor <code className="mono">{search.cursor.slice(0, 8)}…</code>
                    </>
                  ) : null}
                </span>
                <span className="cluster">
                  {search.cursor ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      onClick={() => go({ ...search, cursor: undefined })}
                    >
                      <Icon name="chevron-left" />
                      First page
                    </button>
                  ) : null}
                  {q.data?.nextCursor ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => {
                        clearSelection()
                        go({ ...search, cursor: q.data?.nextCursor ?? undefined })
                      }}
                    >
                      Next page
                      <Icon name="chevron-right" />
                    </button>
                  ) : null}
                </span>
              </div>
            </>
          )}
        </div>
      </section>
      {search.sheet === "filter" ? (
        <FilterSheet
          search={search}
          fields={fields}
          segments={segments}
          topics={topics}
          onApply={(next) => go(next)}
          onClose={() => go({ ...search, sheet: undefined }, true)}
        />
      ) : null}
      {search.sheet === "export" && write.allowed ? (
        <ExportSheet
          search={search}
          description={describeView(search, names)}
          fields={fields}
          onClose={() => go({ ...search, sheet: undefined }, true)}
        />
      ) : null}
      {search.sheet === "new" && write.allowed ? (
        <NewContactSheet fields={fields} onClose={() => go({ ...search, sheet: undefined }, true)} />
      ) : null}
      {bulk ? (
        <BulkSheet
          kind={bulk}
          target={
            all || selected.size > MAX_BULK_IDS
              ? { kind: "filter", search }
              : { kind: "ids", ids: [...selected] }
          }
          count={count}
          topics={topics}
          search={search}
          onClose={() => setBulk(null)}
          onDone={(o) => {
            setBulk(null)
            clearSelection()
            if (o.mode === "async") go({ ...search, job: o.jobId }, true)
            else setResult(o)
          }}
        />
      ) : null}
    </>
  )
}

function SortTh({
  column,
  sort,
  go,
  right,
  children,
}: {
  column: string
  sort: ContactsSearch["sort"] & string
  go: (s: NonNullable<ContactsSearch["sort"]>) => void
  right?: boolean
  children: ReactNode
}) {
  const next = nextSort(sort, column)
  const aria = ariaSort(sort, column)
  return (
    <th className={right ? "r" : undefined} aria-sort={aria}>
      {next ? (
        <button className="th-sort" type="button" onClick={() => go(next)}>
          {children}
          {aria ? <Icon name={aria === "ascending" ? "updown" : "chevron-down"} /> : null}
        </button>
      ) : (
        children
      )}
    </th>
  )
}

const ENG_WORD = { active: "Active", cooling: "Cooling", dormant: "Dormant" } as const

export function Engagement({ value }: { value: "active" | "cooling" | "dormant" }) {
  return (
    <span className={`eng is-${value}`}>
      <i aria-hidden="true">
        <b />
        <b />
        <b />
      </i>
      {ENG_WORD[value]}
    </span>
  )
}

export function fieldValue(v: unknown, type: string | undefined): string {
  if (v === null || v === undefined || v === "") return "—"
  if (type === "boolean" || typeof v === "boolean") return v === true || v === "true" ? "yes" : "no"
  if (type === "date" && typeof v === "string" && !Number.isNaN(Date.parse(v))) return fmtDay(Date.parse(v))
  if (type === "number" && num(v as number) !== null) return (num(v as number) as number).toLocaleString("en")
  return String(v)
}

function Cell({ column, row, fields }: { column: string; row: ContactRow; fields: ContactField[] }) {
  switch (column) {
    case "status":
      return (
        <td>
          <StatusPill status={row.status} />
        </td>
      )
    case "topics":
      return (
        <td>
          <span className="topic-tags">
            {row.topics
              .filter((t) => t.state !== "unsubscribed")
              .map((t) => (
                <span
                  key={t.topicId}
                  className={`ttag${t.state === "unconfirmed" ? " is-pending" : ""}`}
                  title={t.state}
                >
                  {t.name}
                  {t.state === "unconfirmed" ? " · unconfirmed" : ""}
                </span>
              ))}
          </span>
        </td>
      )
    case "engagement":
      return (
        <td>
          <Engagement value={row.engagement} />
        </td>
      )
    case "lastActivityAt":
    case "lastOpenedAt":
    case "lastClickedAt":
      return <td className="r">{fmtAgoShort(row[column])}</td>
    case "createdAt":
      return <td className="r">{fmtDay(row.createdAt)}</td>
    default: {
      const key = column.slice(2)
      const f = fields.find((x) => x.key === key)
      return <td>{fieldValue((row.fields as Record<string, unknown>)[key], f?.type)}</td>
    }
  }
}

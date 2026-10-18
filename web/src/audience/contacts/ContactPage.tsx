/**
 * One contact (design: contact.html and its states: -new, -loading, -error, -agent, -sender, -erase,
 * -suppressed, -complained, -missing-field, -timeline-kinds; GAPS-audience A1.3–A1.6, A6.1). The profile reads
 * labels and types from the field registry; topics show the consent on record; the suppression panel reads
 * `contact.suppression` and sends removal to Transactional; the timeline filters by `?kind=` and pages back by
 * cursor; erasure is owners' and admins' and needs the address typed.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtAgo, fmtInt } from "../../lib/format.ts"
import { usePageTitle } from "../../shell/title.tsx"
import { Icon, type IconName } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { fieldError, fmtDateTime, fmtDay, initialsOf } from "../kit/format.ts"
import { usePopover } from "../kit/popover.ts"
import { allTopicsQuery, type ContactField, fieldLabel, fieldsQuery, type Topic } from "../kit/queries.ts"
import {
  ApiErrorCallout,
  BackLink,
  CopyButton,
  EmptyState,
  SampleMarker,
  Sheet,
  StatusPill,
  useCan,
} from "../kit/ui.tsx"
import { Engagement, fieldValue } from "./ContactsPage.tsx"
import {
  consentParts,
  dataLine,
  deliveryMeta,
  deliveryTone,
  deliveryVerb,
  groupByDay,
  highlightField,
  inputValue,
  itemTime,
  KIND_LABEL,
  messageTone,
  SUPPRESSION_REASON,
  SUPPRESSION_SOURCE,
  streamLabel,
  TIMELINE_KINDS,
  type TimelineKind,
  typedInput,
} from "./detail.ts"
import { type Contact, contactQuery, prefsLinkQuery, type TimelineItem } from "./queries.ts"

export type ContactSearch = { kind?: string; field?: string; sheet?: "erase" | "edit" | "trigger" }
type ContactPatch = { [K in keyof ContactSearch]?: ContactSearch[K] | undefined }

export function ContactPage({ id, search }: { id: string; search: ContactSearch }) {
  const navigate = useNavigate()
  const q = useQuery(contactQuery(id))
  const setSearch = (patch: ContactPatch, replace = true) => {
    const next = { ...search, ...patch }
    const clean = Object.fromEntries(
      Object.entries(next).filter(([, v]) => v !== undefined && v !== ""),
    ) as ContactSearch
    navigate({ to: "/audience/contacts/$contactId", params: { contactId: id }, search: clean, replace })
  }
  const c = q.data && "id" in q.data ? q.data : undefined
  usePageTitle(c ? c.name || c.email : "Contact")

  if (!c)
    return (
      <>
        <BackLink to="/audience/contacts">Contacts</BackLink>
        {q.isError ? (
          <section className="panel">
            <div className="panel-body">
              {q.error instanceof ApiError && q.error.status === 404 ? (
                <EmptyState
                  icon="user"
                  title="No contact here"
                  action={
                    <Link className="btn btn-secondary btn-sm" to="/audience/contacts">
                      Back to contacts
                    </Link>
                  }
                >
                  It may have been erased or deleted. Erasing removes every trace except the counts in
                  reports.
                </EmptyState>
              ) : (
                <PanelError error={q.error} onRetry={() => q.refetch()} what="This contact didn’t load" />
              )}
            </div>
          </section>
        ) : (
          <ContactSkeleton />
        )}
      </>
    )
  return <ContactView c={c} search={search} setSearch={setSearch} />
}

function ContactSkeleton() {
  return (
    <div aria-busy="true">
      <div className="obj-head">
        <span className="avatar-xl sk" aria-hidden="true" />
        <div className="oh-main" aria-hidden="true">
          <span className="sk sk-title" style={{ width: 220 }} />
          <span className="sk sk-text" style={{ width: 360 }} />
        </div>
      </div>
      <div className="detail">
        <div className="stack">
          <section className="panel">
            <div className="panel-body">
              <PanelSkeleton rows={6} />
            </div>
          </section>
          <section className="panel">
            <div className="panel-body">
              <PanelSkeleton rows={4} />
            </div>
          </section>
        </div>
        <section className="panel">
          <div className="panel-body">
            <PanelSkeleton rows={10} />
          </div>
        </section>
      </div>
    </div>
  )
}

function ContactView({
  c,
  search,
  setSearch,
}: {
  c: Contact
  search: ContactSearch
  setSearch: (p: ContactPatch, replace?: boolean) => void
}) {
  const navigate = useNavigate()
  const write = useCan("contacts.write", "change contacts")
  const erase = useCan("contacts.erase", "erase a contact")
  const autos = useCan("automations.write", "start automations")
  const fields = useQuery(fieldsQuery).data ?? []
  const topics = useQuery(allTopicsQuery).data ?? []
  const agent = write.me?.role === "agent"
  const highlight = highlightField(
    search.field,
    fields.map((f) => f.key),
  )
  return (
    <>
      <BackLink to="/audience/contacts">Contacts</BackLink>
      <div className="obj-head" data-od-id="object-head">
        <span className="avatar-xl" aria-hidden="true">
          {initialsOf(c.name, c.email)}
        </span>
        <div className="oh-main">
          <h1 data-od-id="page-title">{c.name || c.email}</h1>
          <div className="oh-sub">
            <code className="mono">{c.email}</code>
            <StatusPill status={c.status} />
            <Engagement value={c.engagement} />
            <span>Contact since {fmtDay(c.createdAt, Number.POSITIVE_INFINITY)}</span>
            <span className="mono">{c.id}</span>
          </div>
        </div>
        <div className="oh-actions">
          <SampleMarker />
          <Gated allowed={autos.allowed} reason="You can’t start automations" who={autos.who}>
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              data-od-id="trigger-automation"
              onClick={() => setSearch({ sheet: "trigger" })}
            >
              <Icon name="automations" />
              Trigger automation
            </button>
          </Gated>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            data-od-id="send-one-off"
            onClick={() => navigate({ to: "/mail", search: { compose: 1, to: c.email } as never })}
          >
            <Icon name="compose" />
            {agent ? "Email from a shared mailbox" : "Send a one-off"}
          </button>
        </div>
      </div>
      <div className="detail">
        <div className="stack">
          <ProfilePanel
            c={c}
            fields={fields}
            canEdit={write.allowed}
            who={write.who}
            editing={search.sheet === "edit"}
            highlight={highlight}
            onEdit={(on) => setSearch({ sheet: on ? "edit" : undefined })}
          />
          <TopicsPanel c={c} topics={topics} canEdit={write.allowed} who={write.who} />
          <SuppressionPanel c={c} />
          <section
            className="stack stack-8"
            data-od-id="panel-privacy"
            aria-labelledby="h-privacy"
            data-endpoint={`GET /v1/contacts/${c.id}/export · POST /v1/contacts/${c.id}/erase`}
          >
            <h2 className="panel-title" id="h-privacy">
              Data and privacy
            </h2>
            <div className="dzone">
              <div className="dz-row">
                <div className="grow">
                  <span className="dz-title">Export their data</span>
                  <span className="dz-sub">
                    Profile, subscriptions and their history, events, messages and suppression, as one JSON
                    file.
                  </span>
                </div>
                <Gated
                  allowed={write.allowed}
                  reason="You can’t export contacts"
                  who={write.who}
                  side="right"
                >
                  <a
                    className="btn btn-secondary btn-sm"
                    href={`/v1/contacts/${encodeURIComponent(c.id)}/export`}
                    download={`${c.id}.json`}
                    data-od-id="export-contact"
                  >
                    <Icon name="download" />
                    Export JSON
                  </a>
                </Gated>
              </div>
              <div className="dz-row">
                <div className="grow">
                  <span className="dz-title">Erase this contact</span>
                  <span className="dz-sub">
                    GDPR erasure: deletes the profile and events and scrubs their address from sent messages.
                    It can’t be undone.
                  </span>
                </div>
                <Gated allowed={erase.allowed} reason="You can’t erase contacts" who={erase.who} side="right">
                  <button
                    className="btn btn-danger-ghost btn-sm"
                    type="button"
                    data-od-id="erase-contact"
                    onClick={() => setSearch({ sheet: "erase" })}
                  >
                    <Icon name="trash" />
                    Erase…
                  </button>
                </Gated>
              </div>
            </div>
          </section>
        </div>
        <div className="stack">
          <TimelinePanel c={c} kinds={search.kind} onKinds={(k) => setSearch({ kind: k || undefined })} />
        </div>
      </div>
      {search.sheet === "erase" && erase.allowed ? (
        <EraseSheet c={c} canExport={write.allowed} onClose={() => setSearch({ sheet: undefined })} />
      ) : null}
      {search.sheet === "trigger" && autos.allowed ? (
        <TriggerSheet c={c} onClose={() => setSearch({ sheet: undefined })} />
      ) : null}
    </>
  )
}

function ftype(f: ContactField | undefined, key: string) {
  if (!f) return <span className="ftype">string</span>
  if (f.label === f.key) return <span className="ftype"> {f.type}</span>
  return (
    <span className="ftype">
      {" "}
      <span className="mono">{key}</span> · {f.type}
    </span>
  )
}

function ProfilePanel({
  c,
  fields,
  canEdit,
  who,
  editing,
  highlight,
  onEdit,
}: {
  c: Contact
  fields: ContactField[]
  canEdit: boolean
  who: string
  editing: boolean
  highlight: string | null
  onEdit: (on: boolean) => void
}) {
  const qc = useQueryClient()
  const ids = useId()
  const values = c.fields as Record<string, unknown>
  const keys = [...new Set([...fields.map((f) => f.key), ...Object.keys(values)])].sort((a, b) =>
    a.localeCompare(b),
  )
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [name, setName] = useState(c.name ?? "")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const hl = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (highlight && hl.current) {
      hl.current.focus({ preventScroll: true })
      hl.current.scrollIntoView({ block: "center" })
    }
  }, [highlight])
  const save = useMutation({
    mutationFn: (body: { name?: string | null; fields?: Record<string, unknown> }) =>
      unwrap(api.PATCH("/v1/contacts/{id}", { params: { path: { id: c.id } }, body: body as never })),
    onSuccess: (r) => {
      if (r && "id" in r) qc.setQueryData(contactQuery(c.id).queryKey, r)
      qc.invalidateQueries({ queryKey: ["contacts", "list"] })
      setDraft({})
      setErrors({})
      onEdit(false)
    },
  })
  const typeOf = (k: string) => fields.find((f) => f.key === k)?.type
  const collect = (only?: string) => {
    const out: Record<string, unknown> = {}
    const errs: Record<string, string> = {}
    for (const [k, raw] of Object.entries(draft)) {
      if (only && k !== only) continue
      const r = typedInput(typeOf(k), raw)
      if ("error" in r) errs[k] = r.error
      else out[k] = r.value
    }
    setErrors(errs)
    return Object.keys(errs).length ? null : out
  }
  const apiErr = save.error ? fieldError(save.error, "fields", { prefix: true }) : null
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/contacts/${c.id} · PATCH`}
      data-od-id="panel-profile"
      aria-labelledby="h-profile"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-profile">
          Profile
        </h2>
        <div className="cluster">
          {editing ? (
            <>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => onEdit(false)}
                disabled={save.isPending}
              >
                Cancel
              </button>
              <button
                className={`btn btn-primary btn-sm${save.isPending ? " is-loading" : ""}`}
                type="button"
                disabled={save.isPending}
                onClick={() => {
                  const f = collect()
                  if (!f) return
                  save.mutate({ name: name.trim() || null, ...(Object.keys(f).length ? { fields: f } : {}) })
                }}
              >
                {save.isPending ? <span className="spinner" aria-hidden="true" /> : null}
                Save
              </button>
            </>
          ) : (
            <Gated allowed={canEdit} reason="You can’t edit contacts" who={who} side="right">
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                data-od-id="edit-profile"
                data-endpoint={`PATCH /v1/contacts/${c.id}`}
                onClick={() => onEdit(true)}
              >
                <Icon name="pencil" />
                Edit
              </button>
            </Gated>
          )}
        </div>
      </header>
      <div className="panel-body">
        {highlight ? (
          <div
            className="callout callout-warn"
            role="note"
            style={{ marginBottom: 12 }}
            data-od-id="missing-field-why"
          >
            <Icon name="warn" />
            <span>
              <b>An automation skipped a send to {c.name || c.email}.</b> Its template needs{" "}
              <span className="mono">{`{{ ${highlight} }}`}</span>, which has no value for this contact. Add
              it below and later sends go out.
            </span>
          </div>
        ) : null}
        <dl className="kv">
          <dt>
            Name<span className="ftype">string</span>
          </dt>
          <dd>
            {editing ? (
              <input
                className="input input-sm"
                aria-label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            ) : (
              c.name || <span className="muted">Empty</span>
            )}
          </dd>
          {keys.map((k) => {
            const f = fields.find((x) => x.key === k)
            const isHl = highlight === k
            const v = values[k]
            const showInput = editing || (isHl && canEdit)
            const errId = `${ids}-${k}`
            return (
              <FragmentKv
                key={k}
                dt={
                  <dt className={isHl ? "is-hl" : undefined} id={`field-${k}`}>
                    {fieldLabel(f, k)}
                    {ftype(f, k)}
                  </dt>
                }
                dd={
                  <dd
                    className={isHl ? "is-hl" : undefined}
                    {...(isHl ? { "data-od-id": "missing-field" } : {})}
                  >
                    {showInput ? (
                      <span className="stack stack-4" style={{ flex: 1, minWidth: 0 }}>
                        <span className="cluster" style={{ ["--gap" as string]: "8px", flexWrap: "nowrap" }}>
                          <input
                            ref={isHl ? hl : undefined}
                            className="input input-sm"
                            aria-label={fieldLabel(f, k)}
                            placeholder={v === null || v === undefined ? "No value" : undefined}
                            value={draft[k] ?? inputValue(v, f?.type)}
                            inputMode={f?.type === "number" ? "decimal" : undefined}
                            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                            {...(errors[k] ? { "aria-invalid": true, "aria-describedby": errId } : {})}
                          />
                          {!editing ? (
                            <button
                              className="btn btn-primary btn-sm"
                              type="button"
                              disabled={save.isPending || draft[k] === undefined}
                              onClick={() => {
                                const out = collect(k)
                                if (out) save.mutate({ fields: out })
                              }}
                            >
                              Save
                            </button>
                          ) : null}
                        </span>
                        {errors[k] ? (
                          <span className="field-error" id={errId} role="alert">
                            {errors[k]}
                          </span>
                        ) : null}
                      </span>
                    ) : v === null || v === undefined || v === "" ? (
                      <span className="muted">Empty</span>
                    ) : (
                      fieldValue(v, f?.type)
                    )}
                  </dd>
                }
              />
            )
          })}
        </dl>
        {apiErr || (save.isError && !apiErr) ? (
          <ApiErrorCallout error={save.error} what="Not saved." />
        ) : null}
      </div>
      <footer className="panel-foot">
        <span>
          Labels and types from{" "}
          <Link className="link" to="/audience/fields">
            the field registry
          </Link>
        </span>
      </footer>
    </section>
  )
}

function FragmentKv({ dt, dd }: { dt: ReactNode; dd: ReactNode }) {
  return (
    <>
      {dt}
      {dd}
    </>
  )
}

function TopicsPanel({
  c,
  topics,
  canEdit,
  who,
}: {
  c: Contact
  topics: Topic[]
  canEdit: boolean
  who: string
}) {
  const qc = useQueryClient()
  const link = useQuery({ ...prefsLinkQuery(c.id), enabled: canEdit })
  const [pending, setPending] = useState<string | null>(null)
  const set = useMutation({
    mutationFn: (v: { topicId: string; state: "subscribed" | "unsubscribed" }) =>
      unwrap(
        api.PUT("/v1/contacts/{id}/topics/{topicId}", {
          params: { path: { id: c.id, topicId: v.topicId } },
          body: { state: v.state },
        }),
      ),
    onMutate: (v) => setPending(v.topicId),
    onSettled: () => {
      setPending(null)
      qc.invalidateQueries({ queryKey: ["contacts", "one", c.id] })
      qc.invalidateQueries({ queryKey: ["contacts", "list"] })
    },
  })
  const shown = [
    ...topics.filter((t) => !t.archived || c.topics.some((x) => x.topicId === t.id)),
    ...c.topics
      .filter((x) => !topics.some((t) => t.id === x.topicId))
      .map((x) => ({ id: x.topicId, name: x.name, doubleOptIn: false, archived: false }) as Topic),
  ]
  const blocked = c.status === "bounced" || c.status === "complained" || c.status === "suppressed"
  return (
    <section
      className="panel"
      data-endpoint={`PUT /v1/contacts/${c.id}/topics/{topicId} · GET /v1/contacts/${c.id}/preferences-link`}
      data-od-id="panel-topics"
      aria-labelledby="h-topics"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-topics">
          Topics and consent
        </h2>
      </header>
      <div className="panel-body">
        {shown.length ? (
          <div>
            {shown.map((t) => {
              const row = c.topics.find((x) => x.topicId === t.id)
              const on = row?.state === "subscribed" || row?.state === "unconfirmed"
              const parts = consentParts(row)
              const canToggle = canEdit && !(blocked && !on)
              return (
                <div key={t.id} className="consent">
                  <span className="c-name">
                    {t.name}
                    {t.doubleOptIn ? (
                      <span className="pill pill-info">
                        <span className="dot" />
                        Double opt-in
                      </span>
                    ) : null}
                    {row?.state === "unconfirmed" ? (
                      <span className="pill pill-neutral">
                        <span className="dot" />
                        Unconfirmed
                      </span>
                    ) : null}
                  </span>
                  <Gated
                    allowed={canToggle}
                    reason={canEdit ? `${c.email} can’t be subscribed` : "You can’t change subscriptions"}
                    who={canEdit ? `This contact is ${c.status}; mail to them would not arrive.` : who}
                    side="right"
                  >
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={`${t.name}: ${row?.state ?? "unsubscribed"}`}
                        disabled={pending === t.id}
                        onChange={(e) =>
                          set.mutate({
                            topicId: t.id,
                            state: e.target.checked ? "subscribed" : "unsubscribed",
                          })
                        }
                      />
                      <span className="sr-only">{row?.state ?? "unsubscribed"}</span>
                    </label>
                  </Gated>
                  <span className="c-how">
                    {parts.text}
                    {parts.source ? (
                      <>
                        {" "}
                        via <code className="mono">{parts.source}</code>
                      </>
                    ) : null}
                    {parts.confirmed ? ` · ${parts.confirmed}` : ""}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="hint">
            No topics yet. <Link to="/audience/topics">Create one</Link> to let people choose what they get.
          </p>
        )}
        {set.isError ? <ApiErrorCallout error={set.error} what="The subscription didn’t change." /> : null}
        {canEdit ? (
          <>
            <hr className="divider" style={{ margin: "12px 0" }} />
            <div className="stack stack-8">
              <span className="label" id="prefs-link-l">
                Preference page link
              </span>
              {link.data?.url ? (
                <div className="input-group">
                  <input
                    className="input mono"
                    readOnly
                    value={link.data.url}
                    aria-labelledby="prefs-link-l"
                  />
                  <span className="addon" style={{ padding: 0 }}>
                    <CopyButton value={link.data.url} label="Copy preference page link" />
                  </span>
                </div>
              ) : link.isError ? (
                <ApiErrorCallout error={link.error} what="The link didn’t come back." />
              ) : (
                <span className="sk sk-text" aria-hidden="true" />
              )}
              <span className="hint">
                A signed link to their preference centre, to paste in a reply. It doesn’t expire with the
                session.
              </span>
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
}

function SuppressionPanel({ c }: { c: Contact }) {
  const s = c.suppression ?? null
  const to = `/transactional/suppressions?q=${encodeURIComponent(c.email)}`
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/contacts/${c.id} · suppression`}
      data-od-id="panel-suppression"
      aria-labelledby="h-suppression"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-suppression">
          Suppression
        </h2>
        <div className="cluster">
          <a className="panel-link" href={to}>
            In Transactional
            <Icon name="chevron-right" />
          </a>
        </div>
      </header>
      <div className="panel-body">
        {!s ? (
          <>
            <div className="spread">
              <span className="cluster">
                <Icon name="check-circle" className="status-icon status-pass" />
                <span>Not suppressed. Mail can reach this address.</span>
              </span>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              <span className="mono">suppression</span> is null on this contact.
            </p>
          </>
        ) : (
          <div className="stack stack-12">
            <div className="spread">
              <span className="pill pill-warn">
                <span className="dot" />
                Suppressed: {(SUPPRESSION_REASON[s.reason] ?? s.reason).toLowerCase()}
              </span>
              <span className="panel-meta">{fmtAgo(s.createdAt)}</span>
            </div>
            <dl className="kv">
              <dt>Reason</dt>
              <dd>{SUPPRESSION_REASON[s.reason] ?? s.reason}</dd>
              <dt>Source</dt>
              <dd>
                {SUPPRESSION_SOURCE[s.source] ?? s.source} <span className="mono muted">{s.source}</span>
              </dd>
              {s.detail ? (
                <>
                  <dt>Detail</dt>
                  <dd>{s.detail}</dd>
                </>
              ) : null}
              {s.messageId ? (
                <>
                  <dt>Message</dt>
                  <dd>
                    <a className="link" href={`/transactional/messages/${encodeURIComponent(s.messageId)}`}>
                      <code className="mono">{s.messageId}</code>
                    </a>
                  </dd>
                </>
              ) : null}
              <dt>Bulk only</dt>
              <dd>
                {s.bulkOnly ? "Yes · transactional mail still goes through" : "No · all mail is blocked"}
              </dd>
              <dt>Created</dt>
              <dd>{fmtDateTime(s.createdAt)}</dd>
              <dt>Cloudflare</dt>
              <dd>
                {s.cloudflare ? (
                  <>
                    <span className={`pill ${s.cloudflare.synced ? "pill-pass" : "pill-warn"}`}>
                      <span className="dot" />
                      {s.cloudflare.synced ? "Synced" : "Not synced"}
                    </span>{" "}
                    <span className="muted">
                      {s.cloudflare.synced && s.cloudflare.id ? (
                        <>
                          on Cloudflare’s list as <span className="mono">{s.cloudflare.id}</span>
                        </>
                      ) : (
                        "not on Cloudflare’s list yet"
                      )}
                      {s.cloudflare.checkedAt ? `, checked ${fmtAgo(s.cloudflare.checkedAt)}` : ""}
                    </span>
                  </>
                ) : (
                  <span className="muted">Not checked</span>
                )}
              </dd>
            </dl>
            {s.reason === "complaint" ? (
              <>
                <div className="callout callout-error" role="note">
                  <Icon name="x-circle" />
                  <span>
                    <b>A complaint can never be removed.</b> They marked our mail as spam, so Mailyard never
                    mails them in bulk again.
                    {s.bulkOnly
                      ? " It’s already bulk-only, so receipts and other transactional mail still reach them."
                      : " To let receipts and other transactional mail reach them, make it bulk-only in Transactional: campaigns and automations stay blocked."}
                  </span>
                </div>
                {!s.bulkOnly ? (
                  <div className="cluster">
                    <a className="btn btn-secondary btn-sm" href={to} data-od-id="make-bulk-only">
                      Make bulk-only in Transactional
                      <Icon name="chevron-right" />
                    </a>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="callout callout-warn">
                  <Icon name="warn" />
                  <span>
                    Removing it lets campaigns send here again.
                    {s.reason === "hard_bounce"
                      ? " Cloudflare counts every bounce against this account’s 5% at-risk line, so only remove it once they’ve confirmed the address works."
                      : ""}
                  </span>
                </div>
                <div className="cluster">
                  <a className="btn btn-danger-ghost btn-sm" href={to} data-od-id="remove-suppression">
                    Remove in Transactional
                    <Icon name="chevron-right" />
                  </a>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

const KIND_ICON: Record<TimelineKind, IconName> = {
  event: "zap",
  delivery: "send",
  reply: "mail",
  message: "envelope",
  subscription: "tag",
  automation: "automations",
  consent: "shield",
}

function TimelinePanel({
  c,
  kinds,
  onKinds,
}: {
  c: Contact
  kinds: string | undefined
  onKinds: (k: string) => void
}) {
  const selected = TIMELINE_KINDS.filter((k) => (kinds ?? "").split(",").includes(k))
  const q = useInfiniteQuery({
    queryKey: ["contacts", "one", c.id, "timeline", selected.join(",") || "all"],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/contacts/{id}/timeline", {
          params: {
            path: { id: c.id },
            query: {
              limit: "50",
              ...(selected.length ? { kind: selected.join(",") } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
  })
  const items = (q.data?.pages ?? []).flatMap((p) => p?.items ?? [])
  const pop = usePopover<HTMLSpanElement>()
  const menuId = useId()
  const label = selected.length ? selected.map((k) => KIND_LABEL[k]).join(", ") : "All kinds"
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/contacts/${c.id}/timeline?kind=&cursor=`}
      data-od-id="panel-timeline"
      aria-labelledby="h-timeline"
      aria-busy={q.isFetching}
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-timeline">
          Timeline
        </h2>
        <div className="cluster">
          <span className="fchip-anchor" ref={pop.anchor}>
            <button
              ref={pop.trigger}
              className="fchip is-multi fchip-open"
              type="button"
              aria-haspopup="menu"
              aria-expanded={pop.open}
              aria-controls={menuId}
              data-od-id="timeline-kinds"
              onClick={pop.toggle}
            >
              <span className="fk">Show</span>
              <b>{label}</b>
              <Icon name="chevron-down" />
            </button>
            {pop.open ? (
              <div className="menu chip-menu is-right" id={menuId} role="menu" aria-label="Timeline kinds">
                <div className="menu-label">Show these kinds</div>
                {TIMELINE_KINDS.map((k) => (
                  <label key={k} className="menu-item">
                    <span className="check">
                      <input
                        type="checkbox"
                        checked={selected.includes(k)}
                        onChange={(e) => {
                          const next = e.target.checked ? [...selected, k] : selected.filter((x) => x !== k)
                          onKinds(TIMELINE_KINDS.filter((x) => next.includes(x)).join(","))
                        }}
                      />
                    </span>
                    <Icon name={KIND_ICON[k]} />
                    <span className="grow">{KIND_LABEL[k]}</span>
                    <span className="kind mono">{k}</span>
                  </label>
                ))}
                <div className="menu-sep" />
                <div className="menu-foot">
                  <code className="mono">{selected.length ? `kind=${selected.join(",")}` : "all kinds"}</code>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => onKinds("")}>
                    All
                  </button>
                </div>
              </div>
            ) : null}
          </span>
        </div>
      </header>
      <div className="panel-body">
        {q.isPending ? (
          <PanelSkeleton rows={8} />
        ) : q.isError ? (
          <PanelError error={q.error} onRetry={() => q.refetch()} what="The timeline didn’t load" />
        ) : !items.length ? (
          selected.length ? (
            <EmptyState icon="filter" title={`No ${label.toLowerCase()} yet`}>
              Nothing of these kinds has happened for this contact. Show all kinds to see the rest.
            </EmptyState>
          ) : (
            <EmptyState icon="clock" title="Nothing has happened yet">
              Emails, opens, clicks, replies, events from your app and consent changes appear here as they
              happen.
            </EmptyState>
          )
        ) : (
          <>
            <ul className="timeline" data-od-id="contact-timeline">
              {groupByDay(items).map((g) => (
                <TimelineDay key={g.day + g.items[0]?.id} day={g.day} items={g.items} />
              ))}
            </ul>
            <div className="dt-foot">
              <span>Newest first · times in UTC</span>
              {q.hasNextPage ? (
                <button
                  className={`btn btn-secondary btn-sm${q.isFetchingNextPage ? " is-loading" : ""}`}
                  type="button"
                  onClick={() => q.fetchNextPage()}
                  disabled={q.isFetchingNextPage}
                >
                  {q.isFetchingNextPage ? <span className="spinner" aria-hidden="true" /> : null}
                  Load older
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function TimelineDay({ day, items }: { day: string; items: TimelineItem[] }) {
  return (
    <>
      <li className="tl-day">{day}</li>
      {items.map((it) => (
        <TlItem key={`${it.kind}-${it.id}`} it={it} />
      ))}
    </>
  )
}

/** A message link: Transactional owns the message log, so this goes there by URL. */
function MsgLink({ id, children }: { id: string; children: ReactNode }) {
  return <a href={`/transactional/messages/${encodeURIComponent(id)}`}>{children}</a>
}

function TlItem({ it }: { it: TimelineItem }) {
  let tone = ""
  let title: ReactNode = null
  let meta: ReactNode = null
  switch (it.kind) {
    case "event":
      title = (
        <>
          Event <code className="mono">{it.name}</code>
        </>
      )
      meta = dataLine(it.data)
      break
    case "delivery":
      tone = deliveryTone(it.event)
      title = (
        <>
          {deliveryVerb(it.event)}:{" "}
          {it.messageId ? (
            <MsgLink id={it.messageId}>{it.subject ?? it.messageId}</MsgLink>
          ) : (
            (it.subject ?? "a message")
          )}
        </>
      )
      meta = (
        <>
          <span className="mono">{it.event}</span>
          {deliveryMeta(it.data).map((m) => (
            <span key={m}>{m}</span>
          ))}
        </>
      )
      break
    case "message":
      tone = messageTone(it.status)
      title = it.campaignId ? (
        <Link to={`/campaigns/${it.campaignId}/report` as never}>{it.subject}</Link>
      ) : (
        <MsgLink id={it.id}>{it.subject}</MsgLink>
      )
      meta = (
        <>
          <span>{streamLabel(it.stream)}</span>
          <span>{it.status}</span>
          {it.bounceType ? <span>{it.bounceType} bounce</span> : null}
          <a className="mono" href={`/transactional/messages/${encodeURIComponent(it.id)}`}>
            {it.id}
          </a>
        </>
      )
      break
    case "subscription":
      title = `${it.to === "subscribed" ? "Subscribed to" : it.to === "unconfirmed" ? "Asked to confirm" : "Unsubscribed from"} ${it.topic}`
      meta = (
        <>
          <span>was {it.from ?? "nothing"}</span>
          <span>
            via <code className="mono">{it.source}</code>
          </span>
        </>
      )
      break
    case "consent":
      tone = "is-pass"
      title = `Confirmed ${it.topic} by double opt-in`
      meta = (
        <>
          <span>
            via <code className="mono">{it.source}</code>
          </span>
          <span>Consent on record</span>
        </>
      )
      break
    case "reply":
      title = `Replied: ${it.subject ?? "(no subject)"}`
      meta = (
        <>
          <span>
            To <span className="mono">{it.to}</span>
          </span>
          {it.inReplyTo ? (
            <span>
              In reply to{" "}
              <a className="mono" href={`/transactional/messages/${encodeURIComponent(it.inReplyTo)}`}>
                {it.inReplyTo}
              </a>
            </span>
          ) : null}
        </>
      )
      break
    case "automation":
      tone =
        it.state === "failed" ? "is-fail" : it.state === "completed" || it.state === "exited" ? "is-pass" : ""
      title = (
        <>
          <Link to={`/automations/${it.automationId}/runs?run=${it.id}` as never}>
            {it.automation ?? it.automationId}
          </Link>{" "}
          · {it.state === "completed" ? "run finished" : `run ${it.state}`}
        </>
      )
      meta = (
        <>
          {it.finishedAt ? <span>Finished {fmtAgo(it.finishedAt)}</span> : <span>In progress</span>}
          <span className="mono">{it.id}</span>
        </>
      )
      break
  }
  return (
    <li className={`tl-item is-${it.kind}`}>
      <span className={`tl-dot${tone ? ` ${tone}` : ""}`}>
        <Icon name={KIND_ICON[it.kind]} />
      </span>
      <span className="tl-body">
        <span className="tl-title">{title}</span>
        {meta ? <span className="tl-meta">{meta}</span> : null}
      </span>
      <time className="tl-time">{itemTime(it.at)}</time>
    </li>
  )
}

function EraseSheet({ c, canExport, onClose }: { c: Contact; canExport: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const id = useId()
  const [typed, setTyped] = useState("")
  const match = typed.trim().toLowerCase() === c.email.toLowerCase()
  const run = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/contacts/{id}/erase", { params: { path: { id: c.id } } })),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["contacts", "one", c.id] })
      qc.invalidateQueries({ queryKey: ["contacts"] })
    },
  })
  if (run.isSuccess && run.data)
    return (
      <Sheet title="Erased" onClose={() => navigate({ to: "/audience/contacts" })} odId="erase-sheet">
        <div className="callout callout-ok" role="status">
          <Icon name="check-circle" />
          <span>
            <b>{c.email} is erased.</b> The profile, fields, topics and events are gone, and the address was
            scrubbed from {fmtInt(run.data.messagesScrubbed)} sent messages. Report counts stay.
          </span>
        </div>
        <div>
          <Link className="btn btn-primary btn-sm" to="/audience/contacts">
            Back to contacts
          </Link>
        </div>
      </Sheet>
    )
  return (
    <Sheet
      title={`Erase ${c.name || c.email}?`}
      sub="A GDPR erasure. It can’t be undone."
      onClose={onClose}
      odId="erase-sheet"
      endpoint={`POST /v1/contacts/${c.id}/erase`}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Keep contact
          </button>
          <Gated allowed={match} reason="Type the address above first" side="up">
            <button
              className={`btn btn-danger${run.isPending ? " is-loading" : ""}`}
              type="button"
              data-od-id="confirm-erase"
              disabled={run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="trash" />}
              Erase for good
            </button>
          </Gated>
        </>
      }
    >
      <ul className="role-list">
        <li>
          <Icon name="x" />
          Deletes the profile, custom fields, topic subscriptions and tracked events.
        </li>
        <li>
          <Icon name="x" />
          Scrubs <code className="mono">{c.email}</code> from every message we sent them; the counts in
          campaign reports stay.
        </li>
        <li>
          <Icon name="x" />
          Ends any automation runs they’re in.
        </li>
        <li>
          <Icon name="info" />
          If they’re on Cloudflare’s suppression list, that entry is Cloudflare’s and stays.
        </li>
      </ul>
      {canExport ? (
        <div className="callout callout-info">
          <Icon name="info" />
          <span>
            Asked for a copy too?{" "}
            <a
              className="link"
              href={`/v1/contacts/${encodeURIComponent(c.id)}/export`}
              download={`${c.id}.json`}
            >
              Export their data first
            </a>
            ; after erasure there’s nothing left to export.
          </span>
        </div>
      ) : null}
      <div className="field">
        <label className="label" htmlFor={`${id}-confirm`}>
          Type their email address to confirm
        </label>
        <input
          className="input mono"
          id={`${id}-confirm`}
          placeholder={c.email}
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      {run.isError ? <ApiErrorCallout error={run.error} what="Nothing was erased." /> : null}
    </Sheet>
  )
}

function TriggerSheet({ c, onClose }: { c: Contact; onClose: () => void }) {
  const id = useId()
  const list = useQuery({
    queryKey: ["automations", "for-enter"],
    queryFn: async () =>
      (await unwrap(api.GET("/v1/automations", { params: { query: { range: "7d" } } })))?.automations ?? [],
  })
  const live = (list.data ?? []).filter((a) => a.status === "live")
  const [pick, setPick] = useState("")
  const chosen = pick || live[0]?.id || ""
  const run = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/automations/{id}/enter", {
          params: { path: { id: chosen } },
          body: { contactId: c.id },
        }),
      ),
  })
  const name = live.find((a) => a.id === chosen)?.name
  return (
    <Sheet
      title="Trigger an automation"
      sub={`Start ${c.name || c.email} in a live automation now, as if its trigger had fired.`}
      onClose={onClose}
      endpoint="POST /v1/automations/{id}/enter"
      odId="trigger-sheet"
      footer={
        run.isSuccess ? (
          <button className="btn btn-primary" type="button" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn btn-ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className={`btn btn-primary${run.isPending ? " is-loading" : ""}`}
              type="button"
              disabled={!chosen || run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? <span className="spinner" aria-hidden="true" /> : null}
              Start the run
            </button>
          </>
        )
      }
    >
      {list.isPending ? (
        <PanelSkeleton rows={2} />
      ) : list.isError ? (
        <ApiErrorCallout error={list.error} what="Automations didn’t load." />
      ) : !live.length ? (
        <div className="callout callout-info">
          <Icon name="info" />
          <span>
            No automation is live. <Link to={"/automations" as never}>Publish one</Link> first; drafts and
            paused ones don’t take new runs.
          </span>
        </div>
      ) : run.isSuccess ? (
        <div className="callout callout-ok" role="status">
          <Icon name="check-circle" />
          <span>
            <b>
              {c.name || c.email} entered {name}.
            </b>{" "}
            The run follows the live version; see it under the automation’s runs.
          </span>
        </div>
      ) : (
        <div className="field">
          <label className="label" htmlFor={`${id}-a`}>
            Automation
          </label>
          <select className="select" id={`${id}-a`} value={chosen} onChange={(e) => setPick(e.target.value)}>
            {live.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · version {a.publishedVersion ?? a.version}
              </option>
            ))}
          </select>
          <span className="hint">
            Re-entry rules still apply: someone who can’t enter again is refused with the reason.
          </span>
        </div>
      )}
      {run.isError ? <ApiErrorCallout error={run.error} what="The run didn’t start." /> : null}
    </Sheet>
  )
}

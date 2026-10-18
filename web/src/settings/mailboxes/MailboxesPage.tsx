/**
 * Settings → Mailboxes and addresses (design: mailboxes, -empty, -loading, -error; HANDOFF-ops §16, §17, §27).
 * Mailboxes that hold mail, then aliases, groups and the catch-all that only deliver, then catch-all per domain.
 * The list endpoint is a summary, so each mailbox's members, auto-reply, forwarding and spam threshold come from
 * its own GET (mailboxes are few).
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { num } from "../../lib/format.ts"
import { BuiltPill, Empty } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel, PanelSkeleton } from "../../ui/Panel.tsx"
import { autoReplyWindow, DEFAULT_SPAM, KIND_LABEL, type MailboxKind } from "../logic.ts"
import { domainsQuery, type Mailbox, type MailboxSummary, mailboxesQuery, mailboxQuery } from "../queries.ts"
import { SectionHead } from "../ui.tsx"
import { ApiRefusal, CreateMailbox, fixtureAutoSubmit } from "./CreateMailbox.tsx"

const route = getRouteApi("/_app/settings/mailboxes")

export function MailboxesPage() {
  const { new: creating, fx } = route.useSearch()
  const navigate = route.useNavigate()
  const q = useQuery(mailboxesQuery)
  const all = q.data?.mailboxes ?? []
  const holders = all.filter((m) => m.holdsMail)
  const delivering = all.filter((m) => !m.holdsMail)
  const open = (kind: MailboxKind | "1") =>
    navigate({ search: (p) => ({ ...p, new: kind === "1" ? "1" : kind }), replace: true })
  const close = () =>
    navigate({
      search: ({ new: _n, fx: _f, ...rest }) => rest,
      replace: true,
    })
  return (
    <>
      <SectionHead
        title="Mailboxes and addresses"
        sub="Who receives what, and where it goes."
        actions={
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => open("1")}
            data-endpoint="POST /v1/mailboxes"
          >
            <Icon name="plus" />
            New mailbox
          </button>
        }
      />
      <Panel
        id="mailboxes"
        title="Mailboxes"
        endpoint="GET /v1/mailboxes · GET /v1/mailboxes/{id} · POST /v1/mailboxes (built, HAL-3378: routing, replaceRoutingRule)"
        query={q}
        meta={q.data ? `${holders.length} mailbox${holders.length === 1 ? "" : "es"}` : undefined}
        skeleton={<TableSkeleton />}
        isEmpty={() => holders.length === 0}
        empty={
          <Empty
            icon="mailbox"
            title="No mailboxes yet"
            action={
              <button className="btn btn-secondary" type="button" onClick={() => open("1")}>
                <Icon name="plus" />
                New mailbox
              </button>
            }
          >
            A mailbox keeps mail for an address on your domain: personal for one person, shared for a team.
            Aliases and groups deliver into mailboxes.
          </Empty>
        }
      >
        {() => <HoldersTable boxes={holders} />}
      </Panel>
      {q.isSuccess && (holders.length > 0 || delivering.length > 0) ? (
        <AliasesPanel all={all} delivering={delivering} onAdd={() => open("alias")} />
      ) : null}
      {q.isSuccess ? <CatchAllPanel all={all} /> : null}
      {creating ? (
        <CreateMailbox
          onClose={close}
          initialKind={creating === "1" ? "shared" : (creating as MailboxKind)}
          autoSubmit={fixtureAutoSubmit(fx)}
        />
      ) : null}
    </>
  )
}

function TableSkeleton() {
  return (
    <div className="stack stack-12" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="cluster" style={{ justifyContent: "space-between" }}>
          <span className="sk sk-text" style={{ width: "40%" }} />
          <span className="sk sk-text" style={{ width: "15%" }} />
          <span className="sk sk-text" style={{ width: "20%" }} />
        </div>
      ))}
    </div>
  )
}

function HoldersTable({ boxes }: { boxes: MailboxSummary[] }) {
  const details = useQueries({ queries: boxes.map((b) => mailboxQuery(b.id)) })
  return (
    <table className="rtable">
      <thead>
        <tr>
          <th>Address</th>
          <th>Kind</th>
          <th className="r">Members</th>
          <th>Auto-reply</th>
          <th>Forwarding</th>
          <th>Spam threshold</th>
          <th>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {boxes.map((b, i) => (
          <HolderRow key={b.id} box={b} detail={details[i]?.data} loading={Boolean(details[i]?.isPending)} />
        ))}
      </tbody>
    </table>
  )
}

function HolderRow({
  box,
  detail,
  loading,
}: {
  box: MailboxSummary
  detail: Mailbox | undefined
  loading: boolean
}) {
  const dash = loading ? (
    <span className="sk sk-text" style={{ width: 48 }} />
  ) : (
    <span className="muted">—</span>
  )
  const arWindow = detail ? autoReplyWindow(detail.autoReply) : null
  const fw = detail?.forwarding
  const members = detail ? detail.people.length + detail.members.filter((m) => !m.revoked).length : null
  return (
    <tr>
      <td className="is-head">
        <div className="cell-main">
          <Link className="mono" to="/settings/mailboxes/$id" params={{ id: box.id }}>
            {box.address}
          </Link>
          {box.displayName ? <span className="cell-sub">{box.displayName}</span> : null}
        </div>
      </td>
      <td data-label="Kind">{KIND_LABEL[box.kind]}</td>
      <td className="r" data-label="Members">
        {members ?? dash}
      </td>
      <td data-label="Auto-reply">
        {detail ? (
          arWindow ? (
            <span className="pill pill-info">
              <span className="dot" />
              {arWindow}
            </span>
          ) : (
            <span className="muted">Off</span>
          )
        ) : (
          dash
        )}
      </td>
      <td data-label="Forwarding">
        {detail ? (
          fw?.enabled && fw.to.length ? (
            `To ${fw.to.length} address${fw.to.length === 1 ? "" : "es"}`
          ) : (
            <span className="muted">Off</span>
          )
        ) : (
          dash
        )}
      </td>
      <td data-label="Spam threshold">
        {detail ? (
          detail.spamThresholdIsDefault ? (
            <span className="muted">Default ({DEFAULT_SPAM})</span>
          ) : (
            <>
              <b className="num">{num(detail.spamThreshold)}</b> <span className="muted t-small">custom</span>
            </>
          )
        ) : (
          dash
        )}
      </td>
      <td className="actions">
        <Link
          className="btn btn-ghost btn-sm"
          to="/settings/mailboxes/$id"
          params={{ id: box.id }}
          aria-label={`Edit ${box.address}`}
        >
          Edit
        </Link>
      </td>
    </tr>
  )
}

function AliasesPanel({
  all,
  delivering,
  onAdd,
}: {
  all: MailboxSummary[]
  delivering: MailboxSummary[]
  onAdd: () => void
}) {
  const [editing, setEditing] = useState<MailboxSummary | null>(null)
  const byId = new Map(all.map((m) => [m.id, m]))
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/mailboxes (kind alias, group, catch_all) · PATCH /v1/mailboxes/{id} { targets }"
      data-od-id="panel-aliases"
      aria-labelledby="h-aliases"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-aliases">
          Aliases, groups and catch-all
        </h2>
        <div className="cluster">
          <span className="panel-meta">no storage of their own</span>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={onAdd}
            data-endpoint="POST /v1/mailboxes { kind: alias }"
          >
            <Icon name="plus" />
            Add alias
          </button>
        </div>
      </header>
      <div className="panel-body">
        {delivering.length ? (
          <table className="rtable">
            <thead>
              <tr>
                <th>Address</th>
                <th>Kind</th>
                <th>Delivers to</th>
                <th>Signature</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {delivering.map((a) => {
                const targets = a.targetIds.map((t) => byId.get(t)?.address ?? t)
                return (
                  <tr key={a.id}>
                    <td className="is-head">
                      <div className="cell-main">
                        <span className="mono" style={{ color: "var(--my-fg)" }}>
                          {a.address}
                        </span>
                        {a.displayName ? <span className="cell-sub">{a.displayName}</span> : null}
                      </div>
                    </td>
                    <td data-label="Kind">{KIND_LABEL[a.kind]}</td>
                    <td data-label="Delivers to">
                      {targets.length ? (
                        targets.map((t, i) => (
                          <span key={t}>
                            {i ? ", " : ""}
                            <span className="mono">{t}</span>
                          </span>
                        ))
                      ) : (
                        <span className="muted">Nowhere yet</span>
                      )}
                    </td>
                    <td data-label="Signature">
                      {a.kind === "alias" && targets[0] ? (
                        <span className="cell-sub" style={{ color: "var(--my-fg)" }}>
                          Inherits <span className="mono">{targets[0]}</span>’s
                        </span>
                      ) : (
                        <span className="muted t-small">Not used: doesn’t send</span>
                      )}
                    </td>
                    <td className="actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        onClick={() => setEditing(a)}
                        aria-label={`Edit ${a.address}`}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <p className="muted t-small">No aliases or groups. Add one to give a mailbox a second address.</p>
        )}
      </div>
      {editing ? (
        <EditTargets
          box={editing}
          holders={all.filter((m) => m.holdsMail)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  )
}

function EditTargets({
  box,
  holders,
  onClose,
}: {
  box: MailboxSummary
  holders: MailboxSummary[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [targets, setTargets] = useState<string[]>(box.targetIds)
  const [name, setName] = useState(box.displayName ?? "")
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/mailboxes/{id}", {
          params: { path: { id: box.id } },
          body: { targets, displayName: name.trim() || null },
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailboxesQuery.queryKey })
      toast({ title: `Saved ${box.address}` })
      onClose()
    },
  })
  return (
    <Sheet
      title={<span className="mono">{box.address}</span>}
      sub={`${KIND_LABEL[box.kind]} · PATCH /v1/mailboxes/${box.id}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!targets.length || m.isPending}
            onClick={() => m.mutate()}
          >
            {m.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor="tg-name">
          Display name <span className="opt">· optional</span>
        </label>
        <input
          className="input"
          id="tg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-autofocus=""
        />
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 6 }}>
          Delivers to
        </legend>
        {holders.map((h) => (
          <label key={h.id} className="check">
            <input
              type="checkbox"
              checked={targets.includes(h.id)}
              onChange={(e) =>
                setTargets(e.target.checked ? [...targets, h.id] : targets.filter((t) => t !== h.id))
              }
            />
            <span className="mono">{h.address}</span>
          </label>
        ))}
        {!targets.length ? <span className="hint">Choose at least one mailbox.</span> : null}
      </fieldset>
      {m.isError ? <ApiRefusal error={m.error} /> : null}
    </Sheet>
  )
}

function CatchAllPanel({ all }: { all: MailboxSummary[] }) {
  const qc = useQueryClient()
  const domains = useQuery(domainsQuery)
  const m = useMutation({
    mutationFn: ({ id, catchAll }: { id: string; catchAll: "bounce" | "keep" }) =>
      unwrap(api.PATCH("/v1/domains/{id}", { params: { path: { id } }, body: { catchAll } })),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: domainsQuery.queryKey })
      toast({ title: v.catchAll === "keep" ? "Unknown addresses are kept" : "Unknown addresses bounce" })
    },
    onError: (e) =>
      toast({ title: "Catch-all not changed", sub: e instanceof Error ? e.message : undefined, tone: "bad" }),
  })
  const byId = new Map(all.map((x) => [x.id, x]))
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/domains → catchAll · PATCH /v1/domains/{id} { catchAll }"
      data-od-id="panel-catch-all"
      aria-labelledby="h-catch-all"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-catch-all">
          Catch-all per domain
        </h2>
        <div className="cluster">
          <BuiltPill issue="HAL-3378" />
        </div>
      </header>
      <div className="panel-body">
        {domains.isPending ? (
          <PanelSkeleton rows={2} />
        ) : domains.isError ? (
          <ApiRefusal error={domains.error} />
        ) : !domains.data.domains.length ? (
          <p className="muted t-small">
            No domains yet. <Link to="/domains">Add one in Domains</Link>.
          </p>
        ) : (
          domains.data.domains.map((d) => {
            const box = all.find((x) => x.kind === "catch_all" && x.domainId === d.id)
            const keepIn = box?.targetIds.map((t) => byId.get(t)?.address).filter(Boolean)[0]
            return (
              <div key={d.id} className="toggle-row st-catchall">
                <span className="tr-title">
                  <span className="mono">{d.name}</span>
                </span>
                {d.receiving ? (
                  <select
                    className="select st-catchall-ctl"
                    aria-label={`Catch-all for ${d.name}`}
                    value={d.catchAll}
                    disabled={m.isPending}
                    onChange={(e) => m.mutate({ id: d.id, catchAll: e.target.value as "bounce" | "keep" })}
                  >
                    <option value="keep">
                      {keepIn ? `Keep in ${keepIn}` : "Keep (add a catch-all mailbox)"}
                    </option>
                    <option value="bounce">Bounce</option>
                  </select>
                ) : (
                  <span className="muted t-small st-catchall-ctl">Routing off</span>
                )}
                <span className="tr-sub">
                  {d.receiving
                    ? "Mail to an address that doesn’t exist."
                    : "Sending only; nothing is received here."}
                </span>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}

/**
 * One mailbox's settings (design: mailbox-support.html; HANDOFF-ops §16, §17): identity, members and access,
 * the default signature, spam filtering, auto-reply and forwarding, with one save bar. Members save with
 * PUT /v1/mailboxes/{id}/members, which replaces the whole list, so people and keys are sent together.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { fromLocalInput, toLocalInput, utcShort } from "../../ops/format.ts"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { ACCESS_LABEL, changedFields, clampSpam, DEFAULT_SPAM, KIND_LABEL, unsavedLine } from "../logic.ts"
import { type Mailbox, mailboxesQuery, mailboxQuery, membersQuery } from "../queries.ts"
import { Initials, SaveBar, SectionHead } from "../ui.tsx"
import { ApiRefusal } from "./CreateMailbox.tsx"

type Access = "owner" | "member" | "viewer"
type Row =
  | { kind: "person"; memberId: string; name: string; email: string; access: Access }
  | { kind: "key"; apiKeyId: string; name: string; access: Access; revoked: boolean }

type Form = {
  displayName: string
  signature: string
  autoOn: boolean
  autoFrom: string
  autoTo: string
  autoSubject: string
  autoBody: string
  fwOn: boolean
  fwTo: string
  fwKeep: boolean
  spam: number
  rows: Row[]
}

function formOf(m: Mailbox): Form {
  return {
    displayName: m.displayName ?? "",
    signature: m.signature?.text ?? "",
    autoOn: m.autoReply?.enabled ?? false,
    autoFrom: toLocalInput(m.autoReply?.startsAt as number | null),
    autoTo: toLocalInput(m.autoReply?.endsAt as number | null),
    autoSubject: m.autoReply?.subject ?? "",
    autoBody: m.autoReply?.body ?? "",
    fwOn: m.forwarding?.enabled ?? false,
    fwTo: (m.forwarding?.to ?? []).join(", "),
    fwKeep: m.forwarding?.keepCopy ?? true,
    spam: num(m.spamThreshold) ?? DEFAULT_SPAM,
    rows: [
      ...m.people.map(
        (p): Row => ({
          kind: "person",
          memberId: p.memberId,
          name: p.name,
          email: p.email,
          access: p.access,
        }),
      ),
      ...m.members.map(
        (k): Row => ({ kind: "key", apiKeyId: k.apiKeyId, name: k.name, access: k.role, revoked: k.revoked }),
      ),
    ],
  }
}

const LABELS: Partial<Record<keyof Form, string>> = {
  displayName: "display name",
  signature: "signature",
  autoOn: "auto-reply",
  autoFrom: "auto-reply dates",
  autoTo: "auto-reply dates",
  autoSubject: "auto-reply message",
  autoBody: "auto-reply message",
  fwOn: "forwarding",
  fwTo: "forwarding",
  fwKeep: "forwarding",
  spam: "spam threshold",
  rows: "members",
}

export function MailboxDetail({ id }: { id: string }) {
  const q = useQuery(mailboxQuery(id))
  if (q.isPending)
    return (
      <>
        <SectionHead title={<span className="sk sk-title" style={{ width: 240 }} />} />
        <div className="panel">
          <div className="panel-body">
            <PanelSkeleton rows={8} />
          </div>
        </div>
      </>
    )
  if (q.isError)
    return (
      <>
        <SectionHead title="Mailbox" actions={<BackLink />} />
        <div className="panel is-error">
          <div className="panel-body">
            <PanelError error={q.error} onRetry={() => q.refetch()} what="This mailbox didn’t load" />
          </div>
        </div>
      </>
    )
  return <Editor key={q.data.updatedAt as number} box={q.data} />
}

function BackLink() {
  return (
    <Link className="btn btn-ghost" to="/settings/mailboxes">
      <Icon name="chevron-left" />
      All mailboxes
    </Link>
  )
}

function Editor({ box }: { box: Mailbox }) {
  const qc = useQueryClient()
  const initial = useMemo(() => formOf(box), [box])
  const [f, setF] = useState<Form>(initial)
  useEffect(() => setF(initial), [initial])
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }))
  const changed = changedFields(initial, f, LABELS)
  const holds = box.holdsMail
  const members = useQuery({ ...membersQuery, enabled: holds })
  const boxes = useQuery(mailboxesQuery)
  const aliases = (boxes.data?.mailboxes ?? []).filter((m) => m.kind === "alias" && m.targetIds[0] === box.id)
  const [spamError, setSpamError] = useState<string | null>(null)
  const [fwError, setFwError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const mailboxFields = changed.filter((c) => c !== "members")
      if (mailboxFields.length) {
        const fwTo = f.fwTo
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
        await unwrap(
          api.PATCH("/v1/mailboxes/{id}", {
            params: { path: { id: box.id } },
            body: {
              displayName: f.displayName.trim() || null,
              ...(holds
                ? {
                    signature: f.signature.trim() ? { text: f.signature, html: null } : null,
                    autoReply: {
                      enabled: f.autoOn,
                      subject: f.autoSubject,
                      body: f.autoBody,
                      startsAt: fromLocalInput(f.autoFrom),
                      endsAt: fromLocalInput(f.autoTo),
                    },
                    forwarding: { enabled: f.fwOn, to: fwTo, keepCopy: f.fwKeep },
                    ...(f.spam !== initial.spam ? { spamThreshold: f.spam } : {}),
                  }
                : {}),
            },
          }),
        )
      }
      if (changed.includes("members")) {
        await unwrap(
          api.PUT("/v1/mailboxes/{id}/members", {
            params: { path: { id: box.id } },
            body: {
              members: f.rows.map((r) =>
                r.kind === "person"
                  ? { memberId: r.memberId, access: r.access }
                  : { apiKeyId: r.apiKeyId, role: r.access },
              ),
            },
          }),
        )
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mailboxes"] })
      qc.invalidateQueries({ queryKey: ["identities"] })
      toast({
        title: `Saved ${box.address}`,
        sub: unsavedLine(changed).replace(/^\d+ unsaved changes?: /, ""),
      })
    },
  })

  const resetSpam = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/mailboxes/{id}", { params: { path: { id: box.id } }, body: { spamThreshold: null } }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mailboxes", box.id] })
      toast({ title: `Spam threshold back to the default (${DEFAULT_SPAM})` })
    },
  })

  const canSave = changed.length > 0 && !spamError && !fwError && !save.isPending
  const inRows = new Set(f.rows.map((r) => (r.kind === "person" ? r.memberId : r.apiKeyId)))
  const addable = (members.data?.members ?? []).filter((m) => !inRows.has(m.id))
  const [adding, setAdding] = useState("")

  return (
    <>
      <SectionHead
        title={
          <span className="mono" style={{ fontFamily: "var(--font-mono)", fontWeight: 400 }}>
            {box.address}
          </span>
        }
        sub={`${KIND_LABEL[box.kind]} mailbox`}
        actions={<BackLink />}
      />
      <div
        className="panel"
        data-endpoint={`GET /v1/mailboxes/${box.id} · PATCH /v1/mailboxes/${box.id} · PUT /v1/mailboxes/${box.id}/members`}
        data-od-id="panel-mailbox"
      >
        <div className="panel-body">
          <section className="form-section">
            <div className="fs-head">
              <h2>Identity</h2>
              <p>How it shows in the From line.</p>
            </div>
            <div className="fs-body">
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="mb-addr">
                    Address
                  </label>
                  <input className="input mono" id="mb-addr" value={box.address} disabled />
                </div>
                <div className="field">
                  <label className="label" htmlFor="mb-dname">
                    Display name
                  </label>
                  <input
                    className="input"
                    id="mb-dname"
                    value={f.displayName}
                    onChange={(e) => set("displayName", e.target.value)}
                  />
                </div>
              </div>
              <span className="hint">
                {KIND_LABEL[box.kind]} mailbox
                {box.messageCount !== null ? ` · ${fmtInt(box.messageCount)} messages` : ""}
              </span>
            </div>
          </section>
          {holds ? (
            <>
              <section className="form-section">
                <div className="fs-head">
                  <h2>Members and access</h2>
                  <p>Who can read and send as this address. Members come from the workspace’s people.</p>
                </div>
                <div className="fs-body">
                  {f.rows.length ? (
                    <table className="rtable">
                      <tbody>
                        {f.rows.map((r, i) => (
                          <tr key={r.kind === "person" ? r.memberId : r.apiKeyId}>
                            <td className="is-head">
                              <span className="person">
                                {r.kind === "person" ? (
                                  <Initials name={r.name} />
                                ) : (
                                  <span className="avatar" aria-hidden="true">
                                    <Icon name="key" />
                                  </span>
                                )}
                                <span className="p-meta">
                                  <span className="p-name">{r.name}</span>
                                  <span className="p-mail">
                                    {r.kind === "person"
                                      ? r.email
                                      : `API key${r.revoked ? " · revoked" : ""}`}
                                  </span>
                                </span>
                              </span>
                            </td>
                            <td data-label="Access">
                              <select
                                className="select"
                                style={{ height: 36 }}
                                aria-label={`Access for ${r.name}`}
                                value={r.access}
                                onChange={(e) =>
                                  set(
                                    "rows",
                                    f.rows.map((x, j) =>
                                      j === i ? { ...x, access: e.target.value as Access } : x,
                                    ),
                                  )
                                }
                              >
                                {(Object.keys(ACCESS_LABEL) as Access[]).map((a) => (
                                  <option key={a} value={a}>
                                    {ACCESS_LABEL[a]}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="actions">
                              <button
                                className="btn btn-ghost btn-sm"
                                type="button"
                                aria-label={`Remove ${r.name}`}
                                onClick={() =>
                                  set(
                                    "rows",
                                    f.rows.filter((_, j) => j !== i),
                                  )
                                }
                              >
                                <Icon name="x" />
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="muted t-small">Nobody yet. Admins and the owner can always open it.</p>
                  )}
                  <div className="st-member-add">
                    <label className="sr-only" htmlFor="mb-add">
                      Add a member
                    </label>
                    <select
                      className="select"
                      id="mb-add"
                      value={adding}
                      onChange={(e) => setAdding(e.target.value)}
                      disabled={!addable.length}
                    >
                      <option value="">
                        {members.isPending
                          ? "Loading people…"
                          : addable.length
                            ? "Choose a person"
                            : "Everyone is already here"}
                      </option>
                      {addable.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} · {m.email}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      disabled={!adding}
                      onClick={() => {
                        const p = addable.find((m) => m.id === adding)
                        if (!p) return
                        set("rows", [
                          ...f.rows,
                          { kind: "person", memberId: p.id, name: p.name, email: p.email, access: "member" },
                        ])
                        setAdding("")
                      }}
                    >
                      <Icon name="user-plus" />
                      Add a member
                    </button>
                  </div>
                </div>
              </section>
              <section className="form-section">
                <div className="fs-head">
                  <h2>Default signature</h2>
                  <p>Added to new mail and replies. Members can still edit it per message.</p>
                </div>
                <div className="fs-body">
                  <textarea
                    className="textarea"
                    rows={3}
                    aria-label="Signature"
                    value={f.signature}
                    onChange={(e) => set("signature", e.target.value)}
                  />
                  <span className="hint">
                    {aliases.length ? (
                      <>
                        Aliases that deliver here send with this signature too:{" "}
                        {aliases.map((a, i) => (
                          <span key={a.id}>
                            {i ? (i === aliases.length - 1 ? " and " : ", ") : ""}
                            <span className="mono">{a.address}</span>
                          </span>
                        ))}
                        .
                      </>
                    ) : (
                      "No aliases send as this mailbox."
                    )}
                  </span>
                </div>
              </section>
              <section
                className="form-section"
                data-endpoint={`PATCH /v1/mailboxes/${box.id} { spamThreshold }`}
              >
                <div className="fs-head">
                  <h2>Spam filtering</h2>
                  <p>Mail scoring at or above the threshold goes to Spam. Lower is stricter.</p>
                </div>
                <div className="fs-body">
                  <div className="field">
                    <label className="label" htmlFor="spam-th">
                      Spam threshold <span className="opt">· 1 to 20</span>
                    </label>
                    <div className="cluster">
                      <input
                        className="input"
                        id="spam-th"
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        value={f.spam}
                        style={{ width: 96 }}
                        aria-invalid={spamError ? true : undefined}
                        onChange={(e) => {
                          const n = Number(e.target.value)
                          setSpamError(
                            Number.isInteger(n) && n >= 1 && n <= 20 ? null : "A whole number from 1 to 20.",
                          )
                          set("spam", Number.isFinite(n) ? n : f.spam)
                        }}
                      />
                      <input
                        type="range"
                        min={1}
                        max={20}
                        step={1}
                        value={clampSpam(f.spam)}
                        aria-label="Spam threshold slider"
                        style={{ flex: 1, minWidth: 0, accentColor: "var(--gray-1000)" }}
                        onChange={(e) => {
                          setSpamError(null)
                          set("spam", Number(e.target.value))
                        }}
                      />
                    </div>
                    {spamError ? (
                      <span className="field-error">
                        <Icon name="x-circle" />
                        {spamError}
                      </span>
                    ) : (
                      <span className="hint">
                        {box.spamThresholdIsDefault ? (
                          <>
                            Using the default ({DEFAULT_SPAM}):{" "}
                            <span className="mono">spamThresholdIsDefault: true</span>. Change it to set a
                            custom value.
                          </>
                        ) : (
                          <>
                            Custom value {num(box.spamThreshold)}. The default is {DEFAULT_SPAM}.
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  <div>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      aria-disabled={box.spamThresholdIsDefault || resetSpam.isPending ? true : undefined}
                      onClick={() => {
                        if (!box.spamThresholdIsDefault) resetSpam.mutate()
                      }}
                      data-endpoint={`PATCH /v1/mailboxes/${box.id} { spamThreshold: null }`}
                    >
                      <Icon name="undo" />
                      Reset to default ({DEFAULT_SPAM})
                    </button>
                  </div>
                </div>
              </section>
              <section className="form-section">
                <div className="fs-head">
                  <h2>Auto-reply</h2>
                  <p>Sent once per sender per four days, never to lists or automated mail.</p>
                </div>
                <div className="fs-body">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={f.autoOn}
                      onChange={(e) => set("autoOn", e.target.checked)}
                    />
                    {f.autoFrom || f.autoTo ? "On between these dates" : "On"}
                  </label>
                  <div className="field-row">
                    <div className="field">
                      <label className="label" htmlFor="ar-from">
                        From
                      </label>
                      <input
                        className="input"
                        id="ar-from"
                        type="datetime-local"
                        value={f.autoFrom}
                        onChange={(e) => set("autoFrom", e.target.value)}
                      />
                      <span className="hint">UTC · optional</span>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="ar-to">
                        Until
                      </label>
                      <input
                        className="input"
                        id="ar-to"
                        type="datetime-local"
                        value={f.autoTo}
                        onChange={(e) => set("autoTo", e.target.value)}
                      />
                      <span className="hint">UTC · optional</span>
                    </div>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="ar-subj">
                      Subject
                    </label>
                    <input
                      className="input"
                      id="ar-subj"
                      value={f.autoSubject}
                      onChange={(e) => set("autoSubject", e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="ar-body">
                      Message
                    </label>
                    <textarea
                      className="textarea"
                      id="ar-body"
                      rows={3}
                      value={f.autoBody}
                      onChange={(e) => set("autoBody", e.target.value)}
                    />
                  </div>
                  {f.autoOn && (f.autoFrom || f.autoTo) ? (
                    <div className="callout callout-info">
                      <Icon name="calendar" />
                      <span>
                        Scheduled:
                        {f.autoFrom ? (
                          <>
                            {" "}
                            starts <b>{utcShort(fromLocalInput(f.autoFrom))}</b>
                          </>
                        ) : null}
                        {f.autoFrom && f.autoTo ? " and" : ""}
                        {f.autoTo ? (
                          <>
                            {" "}
                            ends <b>{utcShort(fromLocalInput(f.autoTo))}</b>
                          </>
                        ) : null}
                        .
                      </span>
                    </div>
                  ) : null}
                </div>
              </section>
              <section className="form-section">
                <div className="fs-head">
                  <h2>Forwarding</h2>
                  <p>A copy of every message, sent on to another address.</p>
                </div>
                <div className="fs-body">
                  <label className="switch">
                    <input type="checkbox" checked={f.fwOn} onChange={(e) => set("fwOn", e.target.checked)} />
                    Forward incoming mail
                  </label>
                  <div className="field">
                    <label className="label" htmlFor="fw-to">
                      To
                    </label>
                    <input
                      className="input mono"
                      id="fw-to"
                      value={f.fwTo}
                      aria-invalid={fwError ? true : undefined}
                      onChange={(e) => {
                        const v = e.target.value
                        const bad = v
                          .split(/[\s,]+/)
                          .filter(Boolean)
                          .find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))
                        setFwError(bad ? `${bad} isn’t an email address.` : null)
                        set("fwTo", v)
                      }}
                    />
                    {fwError ? (
                      <span className="field-error">
                        <Icon name="x-circle" />
                        {fwError}
                      </span>
                    ) : (
                      <span className="hint">
                        Separate addresses with commas. An outside address must be verified with Cloudflare
                        first.
                      </span>
                    )}
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={f.fwKeep}
                      onChange={(e) => set("fwKeep", e.target.checked)}
                    />
                    Keep a copy in Mailyard
                  </label>
                </div>
              </section>
            </>
          ) : (
            <section className="form-section">
              <div className="fs-head">
                <h2>Delivers to</h2>
                <p>{KIND_LABEL[box.kind]}es keep no mail of their own.</p>
              </div>
              <div className="fs-body">
                {box.targets.map((t) => (
                  <span key={t.id} className="mono">
                    {t.address ?? t.id}
                  </span>
                ))}
                <span className="hint">Change where it delivers from the list of aliases.</span>
              </div>
            </section>
          )}
        </div>
      </div>
      {save.isError ? <ApiRefusal error={save.error} /> : null}
      <SaveBar
        line={spamError || fwError ? "Fix the highlighted field to save" : unsavedLine(changed)}
        tone={spamError || fwError ? "error" : "muted"}
      >
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() => setF(initial)}
          disabled={!changed.length}
        >
          Discard
        </button>
        <button
          className="btn btn-primary"
          type="button"
          aria-disabled={!canSave ? true : undefined}
          onClick={() => canSave && save.mutate()}
          data-endpoint={`PATCH /v1/mailboxes/${box.id}`}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </SaveBar>
    </>
  )
}

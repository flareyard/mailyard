/**
 * Audience → Fields (design: fields.html, fields-edit.html, fields-readonly.html, fields-empty.html,
 * fields-loading.html, fields-error.html; GAPS-audience A1.3). The registry from `GET /v1/contact-fields`:
 * every key any writer has set, its label and type, and what uses it. `?edit=key` opens the edit sheet, which
 * PATCHes `/v1/contact-fields/{key}` with the label and type (`contacts.write`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { AudienceHead } from "../AudienceHead.tsx"
import { fieldError, fmtDay } from "../kit/format.ts"
import { type ContactField, fieldsQuery } from "../kit/queries.ts"
import { ApiErrorCallout, FieldError, Sheet, SkeletonRows, useCan } from "../kit/ui.tsx"
import {
  type FieldType,
  fieldPatch,
  fieldsMeta,
  isNamed,
  phoneSub,
  TYPE_WORD,
  typeChangeWarning,
} from "./logic.ts"

const ENDPOINT = "GET /v1/contact-fields · PATCH /v1/contact-fields/:key"

export const usedByHref = (u: { type: "segment" | "automation"; id: string }) =>
  u.type === "segment" ? `/audience/segments/${u.id}` : `/automations/${u.id}`

export function FieldsPage({
  edit,
  onEdit,
}: {
  edit: string | undefined
  onEdit: (key: string | undefined) => void
}) {
  const q = useQuery(fieldsQuery)
  const write = useCan("contacts.write", "name and retype fields")
  const editing = edit ? q.data?.find((f) => f.key === edit) : undefined
  const keyName = write.me?.key?.name
  const scopes = write.me?.scopes.join(", ")

  return (
    <>
      <AudienceHead
        current="fields"
        sub="Everyone you can email, what they agreed to, and how they’re engaging."
      />
      {!write.allowed && write.me ? (
        <div className="callout callout-info ro-banner" role="note" data-od-id="fields-readonly">
          <Icon name="lock" />
          <span>
            <b>Read-only for you.</b>{" "}
            {keyName && !write.me.role
              ? `You’re signed in with the ${keyName} key (scopes ${scopes}). Naming a field or correcting its type needs a key with the admin scope. Reading the list needs read.`
              : `${write.who} Reading the list is open to everyone in the workspace.`}
          </span>
        </div>
      ) : null}
      {q.isSuccess && q.data.length ? (
        <div
          className="callout callout-info"
          role="note"
          data-od-id="fields-auto"
          style={{ marginBottom: 16 }}
        >
          <Icon name="info" />
          <span>
            <b>Fields register themselves.</b> Any writer that sets a new key adds it here: an import, a
            hosted form, <code className="mono">POST</code> or{" "}
            <code className="mono">PATCH /v1/contacts</code> from your app, or an automation’s update step.
            Its type comes from the first value written. Name a field so pickers, columns and the profile read
            “Courses completed” rather than <code className="mono">courses_completed</code>.
          </span>
        </div>
      ) : null}
      <Panel
        id="fields"
        title="Contact fields"
        endpoint={ENDPOINT}
        query={q}
        meta={q.data ? fieldsMeta(q.data) : undefined}
        skeleton={<SkeletonRows rows={7} cols={6} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <div className="empty" data-od-id="empty-state">
            <span className="empty-icon">
              <Icon name="list" />
            </span>
            <h3>No custom fields yet</h3>
            <p>
              A field appears here the first time anything writes one: a CSV column you map, a form field, or{" "}
              <code className="mono">fields</code> in an API call. Email and name are built in.
            </p>
            <Link className="btn btn-secondary btn-sm" to={"/audience/imports" as string}>
              <Icon name="upload" />
              Import a CSV
            </Link>
          </div>
        }
      >
        {(fields) => (
          <>
            <div className="table-wrap desk-only">
              <table className="table dt" data-od-id="fields-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Type</th>
                    <th>Used by</th>
                    <th className="r">Created</th>
                    <th className="r">Updated</th>
                    <th className="r">
                      <span className="sr-only">Edit</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f) => (
                    <FieldRow
                      key={f.key}
                      f={f}
                      canEdit={write.allowed}
                      who={write.who}
                      onEdit={() => onEdit(f.key)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="phone-only">
              <ul className="list">
                {fields.map((f) => (
                  <li key={f.key} className="list-row">
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="row-title">
                        {isNamed(f) ? (
                          <>
                            {f.label} <span className="mono-sub">{f.key}</span>
                          </>
                        ) : (
                          f.key
                        )}
                      </span>
                      <span className="row-sub">{phoneSub(f)}</span>
                    </span>
                    {write.allowed ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        onClick={() => onEdit(f.key)}
                        aria-label={`Edit ${f.key}`}
                      >
                        <Icon name="pencil" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </Panel>
      {editing && write.allowed ? <EditSheet f={editing} onClose={() => onEdit(undefined)} /> : null}
      {edit && q.isSuccess && !editing ? (
        <div className="callout callout-warn" role="status" style={{ marginTop: 12 }}>
          <Icon name="warn" />
          <span>
            No field has the key <code className="mono">{edit}</code>.
          </span>
        </div>
      ) : null}
    </>
  )
}

function FieldRow({
  f,
  canEdit,
  who,
  onEdit,
}: {
  f: ContactField
  canEdit: boolean
  who: string
  onEdit: () => void
}) {
  const named = isNamed(f)
  return (
    <tr>
      <td>
        {named ? (
          <>
            <span className="strong">{f.label}</span>
            <span className="cell-sub mono">{f.key}</span>
          </>
        ) : (
          <>
            <span className="mono strong">{f.key}</span>
            <span className="cell-sub">Not named yet: people see the key</span>
          </>
        )}
      </td>
      <td>
        <span className="pill">
          {TYPE_WORD[f.type]} <span className="mono">{f.type}</span>
        </span>
      </td>
      <td>
        {f.usedBy.length ? (
          <span className="used-by">
            {f.usedBy.map((u) => (
              <Link key={`${u.type}-${u.id}`} className="ttag used-chip" to={usedByHref(u)}>
                <Icon name={u.type === "segment" ? "filter" : "automations"} />
                {u.name}
              </Link>
            ))}
          </span>
        ) : (
          <span className="muted">Not used</span>
        )}
      </td>
      <td className="r">{fmtDay(f.createdAt)}</td>
      <td className="r">
        {f.updatedAt === null ? <span className="muted">Never</span> : fmtDay(f.updatedAt)}
      </td>
      <td className="r">
        <Gated allowed={canEdit} reason="You can’t name or retype fields" who={who} side="right">
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${f.key}`}
          >
            <Icon name="pencil" />
            {named ? "Edit" : "Name it"}
          </button>
        </Gated>
      </td>
    </tr>
  )
}

const TYPES: FieldType[] = ["string", "number", "boolean", "date"]

function EditSheet({ f, onClose }: { f: ContactField; onClose: () => void }) {
  const qc = useQueryClient()
  const [label, setLabel] = useState(isNamed(f) ? f.label : "")
  const [type, setType] = useState<FieldType>(f.type)
  const patch = fieldPatch(f, label, type)
  const warning = typeChangeWarning(f, type)
  const save = useMutation({
    mutationFn: () =>
      unwrap(api.PATCH("/v1/contact-fields/{key}", { params: { path: { key: f.key } }, body: patch ?? {} })),
    onSuccess: (updated) => {
      qc.setQueryData(fieldsQuery.queryKey, (list: ContactField[] | undefined) =>
        list?.map((x) => (x.key === f.key && updated ? updated : x)),
      )
      qc.invalidateQueries({ queryKey: ["contact-fields"] })
      onClose()
    },
  })
  const labelErr = fieldError(save.error, "label")
  const typeErr = fieldError(save.error, "type")
  return (
    <Sheet
      title={
        <>
          Edit <span className="mono">{f.key}</span>
        </>
      }
      sub="The key stays: it’s what imports, forms, the API and templates write. Only the label and the type change."
      onClose={onClose}
      odId="field-sheet"
      endpoint={`PATCH /v1/contact-fields/${f.key} {label, type}`}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn btn-primary${save.isPending ? " is-loading" : ""}`}
            type="button"
            disabled={!patch || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            {type !== f.type ? `Change to ${TYPE_WORD[type].toLowerCase()}` : "Save field"}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor="fd-l">
          Label
        </label>
        <input
          className="input"
          id="fd-l"
          value={label}
          placeholder={f.key}
          maxLength={100}
          onChange={(e) => setLabel(e.target.value)}
          {...(labelErr ? { "aria-invalid": true, "aria-describedby": "fd-l-err" } : {})}
        />
        <span className="hint">
          What people see in pickers, columns and the profile. Clear it to show the key again.
        </span>
        {labelErr ? <FieldError id="fd-l-err">{labelErr}</FieldError> : null}
      </div>
      <div className="field">
        <label className="label" htmlFor="fd-t">
          Type
        </label>
        <select
          className="select"
          id="fd-t"
          value={type}
          onChange={(e) => setType(e.target.value as FieldType)}
          aria-describedby={warning ? "fd-warn" : undefined}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_WORD[t]} · {t}
            </option>
          ))}
        </select>
        <span className="hint">
          {f.updatedAt === null ? "It was inferred from the first value written: " : "It’s stored as "}
          <span className="mono">{f.type}</span>.
        </span>
        {typeErr ? <FieldError id="fd-t-err">{typeErr}</FieldError> : null}
      </div>
      {warning ? (
        <div className="callout callout-warn" role="alert" id="fd-warn" data-od-id="type-in-use">
          <Icon name="warn" />
          <span>
            <b>{warning.title}</b> {warning.body}
            {f.usedBy.length ? (
              <ul className="role-list" style={{ marginTop: 8 }}>
                {f.usedBy.map((u) => (
                  <li key={`${u.type}-${u.id}`}>
                    <Icon name={u.type === "segment" ? "filter" : "automations"} />
                    <Link className="link" to={usedByHref(u)}>
                      {u.name}
                    </Link>{" "}
                    · {u.type}
                  </li>
                ))}
              </ul>
            ) : null}
          </span>
        </div>
      ) : null}
      {save.isError && !labelErr && !typeErr ? (
        <ApiErrorCallout error={save.error} what="The field wasn’t saved." />
      ) : null}
    </Sheet>
  )
}

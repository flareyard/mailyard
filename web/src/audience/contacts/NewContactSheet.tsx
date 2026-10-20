/**
 * Add one contact by hand (`POST /v1/contacts { email, name, status, fields }`), then open their page (design:
 * contact-new.html is that page with nothing on the timeline yet). A 400 is shown on the field it names.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useId, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { errorField, fieldError } from "../kit/format.ts"
import { type ContactField, fieldLabel } from "../kit/queries.ts"
import { ApiErrorCallout, FieldError, Sheet } from "../kit/ui.tsx"
import { typedInput } from "./detail.ts"

export function NewContactSheet({ fields, onClose }: { fields: ContactField[]; onClose: () => void }) {
  const ids = useId()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [status, setStatus] = useState<"subscribed" | "unsubscribed">("subscribed")
  const [values, setValues] = useState<Record<string, string>>({})
  const [local, setLocal] = useState<Record<string, string>>({})
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => unwrap(api.POST("/v1/contacts", { body: body as never })),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["contacts"] })
      if (c && "id" in c) navigate({ to: "/audience/contacts/$contactId", params: { contactId: c.id } })
    },
  })
  const submit = () => {
    const errs: Record<string, string> = {}
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      errs.email = "Type an email address, like ada@example.com."
    const out: Record<string, unknown> = {}
    for (const [k, raw] of Object.entries(values)) {
      if (!raw.trim()) continue
      const r = typedInput(fields.find((f) => f.key === k)?.type, raw)
      if ("error" in r) errs[k] = r.error
      else out[k] = r.value
    }
    setLocal(errs)
    if (Object.keys(errs).length) return
    create.mutate({
      email: email.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      status,
      ...(Object.keys(out).length ? { fields: out } : {}),
    })
  }
  const emailErr = local.email ?? fieldError(create.error, "email")
  const named = errorField(create.error)
  return (
    <Sheet
      title="Add a contact"
      sub="One person, by hand. Imports and forms add many; your app adds them with POST /v1/contacts."
      onClose={onClose}
      endpoint="POST /v1/contacts"
      odId="new-contact-sheet"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn btn-primary${create.isPending ? " is-loading" : ""}`}
            type="button"
            disabled={create.isPending}
            onClick={submit}
          >
            {create.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            Add contact
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor={`${ids}-email`}>
          Email
        </label>
        <input
          className="input mono"
          id={`${ids}-email`}
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          {...(emailErr ? { "aria-invalid": true, "aria-describedby": `${ids}-email-e` } : {})}
        />
        {emailErr ? <FieldError id={`${ids}-email-e`}>{emailErr}</FieldError> : null}
      </div>
      <div className="field">
        <label className="label" htmlFor={`${ids}-name`}>
          Name <span className="opt">· optional</span>
        </label>
        <input className="input" id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <fieldset className="stack stack-8" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="label">Status</legend>
        <div className="cluster cluster-16">
          {(["subscribed", "unsubscribed"] as const).map((s) => (
            <label key={s} className="check">
              <input
                type="radio"
                name={`${ids}-status`}
                checked={status === s}
                onChange={() => setStatus(s)}
              />
              <span>{s === "subscribed" ? "Subscribed" : "Unsubscribed (a record only)"}</span>
            </label>
          ))}
        </div>
        <span className="hint">
          An address on the suppression list joins as suppressed, whatever you pick.
        </span>
      </fieldset>
      {fields.length ? (
        <div className="fgrid">
          {fields.map((f) => {
            const err = local[f.key] ?? (named === `fields.${f.key}` ? create.error?.message : null)
            return (
              <div key={f.key} className="field">
                <label className="label" htmlFor={`${ids}-f-${f.key}`}>
                  {fieldLabel(f, f.key)} <span className="opt">· {f.type}</span>
                </label>
                <input
                  className="input"
                  id={`${ids}-f-${f.key}`}
                  value={values[f.key] ?? ""}
                  placeholder={
                    f.type === "date" ? "2026-03-11" : f.type === "boolean" ? "yes or no" : undefined
                  }
                  inputMode={f.type === "number" ? "decimal" : undefined}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  {...(err ? { "aria-invalid": true, "aria-describedby": `${ids}-f-${f.key}-e` } : {})}
                />
                {err ? <FieldError id={`${ids}-f-${f.key}-e`}>{err}</FieldError> : null}
              </div>
            )
          })}
        </div>
      ) : null}
      {create.isError && !emailErr && !(named ?? "").startsWith("fields.") ? (
        <ApiErrorCallout error={create.error} what="The contact wasn’t added." />
      ) : null}
    </Sheet>
  )
}

/**
 * Suppression sheets (design: suppression-add, suppression-edit, suppression-remove, suppression-remove-results).
 * A complaint is never removed; an unsubscribe is always bulk only; push never applies to bulk-only rows.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { utcDate } from "../../ops/format.ts"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { ConfirmInput } from "../keys/KeySheets.tsx"
import { Refusal } from "../keys/ui.tsx"
import {
  bulkOnlyFixed,
  looksLikeEmail,
  REMOVE_RESULT,
  type Reason,
  type RemoveState,
  removeToastSub,
} from "./logic.ts"

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: ["suppressions"] })

export function AddSheet({
  writable,
  onClose,
  onAdded,
}: {
  writable: boolean
  onClose: () => void
  onAdded?: (email: string) => void
}) {
  const qc = useQueryClient()
  const emailId = useId()
  const reasonId = useId()
  const noteId = useId()
  const [email, setEmail] = useState("")
  const [reason, setReason] = useState<Reason>("manual")
  const [note, setNote] = useState("")
  const [bulkOnly, setBulkOnly] = useState(false)
  const [push, setPush] = useState(false)
  const [tried, setTried] = useState(false)
  const forcedBulk = reason === "unsubscribe"
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/suppressions", {
          body: {
            email: email.trim(),
            reason,
            ...(note.trim() ? { note: note.trim() } : {}),
            bulkOnly: forcedBulk || bulkOnly,
            ...(writable && push && !(forcedBulk || bulkOnly) ? { push: true } : {}),
          },
        }),
      ),
    onSuccess: async (r) => {
      await invalidate(qc)
      toast({
        title: r.created
          ? `Suppressed ${r.suppression.email}`
          : `${r.suppression.email} was already on the list`,
        sub: r.created
          ? r.cloudflare
            ? `Cloudflare: ${r.cloudflare.state}${r.cloudflare.message ? ` · ${r.cloudflare.message}` : ""}`
            : "Later sends skip it."
          : "It keeps its reason: adding never downgrades a complaint.",
        tone: r.created ? "ok" : "warn",
      })
      onAdded ? onAdded(r.suppression.email) : onClose()
    },
  })
  const invalid = !looksLikeEmail(email)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (invalid || add.isPending) return
    add.mutate()
  }
  return (
    <Sheet
      wide
      title="Add an address"
      sub="Later sends skip it, and nothing blocked is billed."
      onClose={onClose}
      odId="add-sheet"
      endpoint="POST /v1/suppressions { email, reason?, note?, bulkOnly?, push? } (built, HAL-3372)"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="sup-add" aria-disabled={add.isPending}>
            <Icon name="plus" />
            {add.isPending ? "Adding…" : "Add address"}
          </button>
        </>
      }
    >
      <form id="sup-add" className="stack stack-16" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor={emailId}>
            Address
          </label>
          <input
            className="input mono"
            id={emailId}
            type="email"
            value={email}
            placeholder="name@domain"
            aria-invalid={tried && invalid}
            onChange={(e) => setEmail(e.target.value)}
            data-autofocus=""
          />
          {tried && invalid ? (
            <span className="field-error">Enter an email address, like name@domain.</span>
          ) : null}
        </div>
        <div className="field">
          <label className="label" htmlFor={reasonId}>
            Reason
          </label>
          <select
            className="select"
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value as Reason)}
          >
            <option value="hard_bounce">Hard bounce</option>
            <option value="complaint">Complaint</option>
            <option value="unsubscribe">Unsubscribe</option>
            <option value="manual">Added by hand</option>
          </select>
          <span className="hint">
            An address already on the list keeps its reason: adding never downgrades a complaint.
          </span>
        </div>
        <div className="field">
          <label className="label" htmlFor={noteId}>
            Note <span className="opt">· optional</span>
          </label>
          <input
            className="input"
            id={noteId}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <label className={`check${forcedBulk ? " is-disabled" : ""}`} aria-disabled={forcedBulk || undefined}>
          <input
            type="checkbox"
            checked={forcedBulk || bulkOnly}
            disabled={forcedBulk}
            onChange={(e) => setBulkOnly(e.target.checked)}
          />
          <span>
            Bulk only
            <small className="hint" style={{ display: "block" }}>
              {forcedBulk
                ? "Always on for an unsubscribe: it stops campaigns and automations, never receipts."
                : "Block campaigns and automations; still send receipts and password resets."}
            </small>
          </span>
        </label>
        <label className={`check${writable ? "" : " is-disabled"}`} aria-disabled={!writable || undefined}>
          <input
            type="checkbox"
            checked={writable && push && !(forcedBulk || bulkOnly)}
            disabled={!writable || forcedBulk || bulkOnly}
            onChange={(e) => setPush(e.target.checked)}
          />
          <span>
            Also add it to Cloudflare’s list
            <small className="hint" style={{ display: "block" }}>
              {writable
                ? "Blocks it for every sender on the account, SMTP included. Never with Bulk only."
                : "Unavailable: Cloudflare isn’t connected (no write token). With a token, this blocks it for every sender on the account, SMTP included. Never with Bulk only."}
            </small>
          </span>
        </label>
        <Refusal error={add.error} what="The address wasn’t added." />
      </form>
    </Sheet>
  )
}

type SupRow = {
  email: string
  reason: Reason
  bulkOnly: boolean
  note: string | null
  at: number | string
  contactStatusBefore?: string | null
  cloudflareEntries?: { id: string }[] | null
}

export function EditSheet({ s, onClose }: { s: SupRow; onClose: () => void }) {
  const qc = useQueryClient()
  const noteId = useId()
  const [note, setNote] = useState(s.note ?? "")
  const [bulkOnly, setBulkOnly] = useState(s.bulkOnly || bulkOnlyFixed(s))
  const fixed = bulkOnlyFixed(s)
  const turningOn = bulkOnly && !s.bulkOnly
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/suppressions/{email}", {
          params: { path: { email: s.email } },
          body: { note: note.trim() || null, ...(fixed ? {} : { bulkOnly }) },
        }),
      ),
    onSuccess: async (r) => {
      await invalidate(qc)
      const cf = r.cloudflare
      toast({
        title: `Saved ${s.email}`,
        sub: cf
          ? `Cloudflare: ${cf.state.replace("-", " ")}${cf.message ? ` · ${cf.message}` : ""}`
          : undefined,
        tone:
          cf && (cf.state === "failed" || cf.state === "not-connected" || cf.state === "read-only")
            ? "warn"
            : "ok",
      })
      onClose()
    },
  })
  const entry = s.cloudflareEntries?.[0]
  return (
    <Sheet
      wide
      title={`Edit ${s.email}`}
      sub="PATCH /v1/suppressions/{email} { note?, bulkOnly? }"
      onClose={onClose}
      odId="edit-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            aria-disabled={save.isPending}
            onClick={() => !save.isPending && save.mutate()}
            data-endpoint="PATCH /v1/suppressions/{email} (built, HAL-3372)"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor={noteId}>
          Note
        </label>
        <textarea
          className="textarea"
          id={noteId}
          rows={2}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          data-autofocus=""
        />
      </div>
      <div className="toggle-row">
        <span className="tr-title">Bulk only</span>
        <label className="switch">
          <input
            type="checkbox"
            checked={bulkOnly}
            disabled={fixed}
            onChange={(e) => setBulkOnly(e.target.checked)}
            aria-label="Bulk only"
          />
        </label>
        <span className="tr-sub">
          {fixed
            ? "Always on for an unsubscribe: it only ever stops campaigns and automations."
            : "Turning this on lets transactional mail through again. Cloudflare’s account-wide entry would still block it, so Mailyard removes that entry and tells you how it went."}
        </span>
      </div>
      {turningOn ? (
        <div className="callout callout-info">
          <Icon name="info" />
          <span>
            Saving removes {entry ? <span className="mono">{entry.id}</span> : "any entry"} from Cloudflare,
            and the answer says how it went (<span className="mono">cloudflare.state</span>).
          </span>
        </div>
      ) : null}
      <Refusal error={save.error} what="Nothing was saved." />
    </Sheet>
  )
}

export type RemoveResult = {
  email: string
  contactStatus: string | null
  state: RemoveState
  message: string | null
}

export function RemoveSheet({
  s,
  onClose,
  onRemoved,
}: {
  s: SupRow
  onClose: () => void
  onRemoved: (r: RemoveResult) => void
}) {
  const qc = useQueryClient()
  const [v, setV] = useState("")
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/v1/suppressions/{email}", {
          params: { path: { email: s.email } },
          body: { confirm: true },
        }),
      ),
    onSuccess: async (r) => {
      await invalidate(qc)
      toast({
        title: `Removed ${r.email}`,
        sub: removeToastSub(r.cloudflare.state, r.contactStatus),
        tone: REMOVE_RESULT[r.cloudflare.state].tone === "ok" ? "ok" : "warn",
      })
      onRemoved({
        email: r.email,
        contactStatus: r.contactStatus,
        state: r.cloudflare.state,
        message: r.cloudflare.message,
      })
    },
  })
  const ok = v.trim().toLowerCase() === s.email.toLowerCase() && !remove.isPending
  const entry = s.cloudflareEntries?.[0]
  return (
    <Sheet
      title="Remove this suppression?"
      sub="DELETE /v1/suppressions/{email} { confirm: true }"
      onClose={onClose}
      odId="remove-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            type="button"
            aria-disabled={!ok}
            onClick={() => ok && remove.mutate()}
            data-endpoint="DELETE /v1/suppressions/{email} (built, HAL-3372)"
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </button>
        </>
      }
    >
      <p>
        <span className="mono">{s.email}</span> can receive mail again from the next send.
      </p>
      <ul className="consequences">
        {s.reason === "hard_bounce" ? (
          <li>
            <Icon name="x-circle" />
            <span>
              It hard-bounced on {utcDate(s.at)}. If the address is still dead it will bounce again and count
              against your 2% bounce warning line.
            </span>
          </li>
        ) : (
          <li>
            <Icon name="x-circle" />
            <span>
              Mail goes to it again. If it was suppressed for a reason that still holds, add it back.
            </span>
          </li>
        )}
        {s.contactStatusBefore ? (
          <li className="ok">
            <Icon name="check-circle" />
            <span>
              The contact goes back to <b>{s.contactStatusBefore}</b>, its status before.
            </span>
          </li>
        ) : null}
        <li className="ok">
          <Icon name="check-circle" />
          <span>
            Cloudflare’s entry {entry ? <span className="mono">{entry.id}</span> : null} is removed too, or
            the result says why not.
          </span>
        </li>
      </ul>
      <ConfirmInput match={s.email} verb="remove it" value={v} onChange={setV} />
      <Refusal error={remove.error} what="The suppression wasn’t removed." />
    </Sheet>
  )
}

/** After Remove: what happened on Cloudflare, one callout per `cloudflare.state`. */
export function RemoveResultNote({ r }: { r: RemoveResult }) {
  const res = REMOVE_RESULT[r.state]
  return (
    <div className={`callout callout-${res.tone}`} role="status">
      <Icon name={res.tone === "ok" ? "check-circle" : "warn"} />
      <span>
        <b>Removed {r.email} from Mailyard.</b> <span className="tag">cloudflare.state: {r.state}</span>{" "}
        {res.text}
        {r.message ? <> Cloudflare said: “{r.message}”</> : null}
        {r.contactStatus ? (
          <>
            {" "}
            The contact is back to <b>{r.contactStatus}</b>.
          </>
        ) : null}
      </span>
    </div>
  )
}

/** The last removal's result, handed from the detail page to the list it returns to (read once). */
let lastRemoval: RemoveResult | null = null
export const keepRemoval = (r: RemoveResult) => {
  lastRemoval = r
}
export const takeRemoval = (): RemoveResult | null => {
  const r = lastRemoval
  lastRemoval = null
  return r
}

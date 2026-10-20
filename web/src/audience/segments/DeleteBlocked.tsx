/**
 * Deleting a segment (design: segments-delete-blocked.html; GAPS-audience A3.3). While `usedBy` isn't empty
 * Delete is disabled with its reason; a stale list can still meet `409 Conflict { reason: "in-use" }`, whose
 * message names up to three users, and this sheet shows it with links to each user.
 */
import { Link } from "@tanstack/react-router"
import type { ApiError } from "../../api/client.ts"
import { Icon } from "../../ui/icons.tsx"
import { RequestId } from "../../ui/Panel.tsx"
import { ApiErrorCallout, Sheet } from "../kit/ui.tsx"

export type SegmentUser = { type: "campaign" | "automation"; id: string; name: string }

export const usedByHref = (u: { type: "campaign" | "automation"; id: string }) =>
  u.type === "campaign" ? `/campaigns/${u.id}` : `/automations/${u.id}`

export function DeleteBlockedSheet({
  name,
  error,
  usedBy,
  onClose,
}: {
  name: string
  error: ApiError
  usedBy: readonly SegmentUser[]
  onClose: () => void
}) {
  const first = usedBy[0]
  return (
    <Sheet
      title={`${name} wasn’t deleted`}
      sub="Something started using it after this list loaded."
      onClose={onClose}
      odId="segment-delete-blocked"
      endpoint="DELETE /v1/segments/:id → 409 Conflict {reason: in-use}"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Close
          </button>
          {first ? (
            <Link className="btn btn-primary" to={usedByHref(first)}>
              Open the {first.type}
            </Link>
          ) : null}
        </>
      }
    >
      <div className="callout callout-error" role="alert">
        <Icon name="x-circle" />
        <div className="stack stack-4">
          <span>
            The API refused with <b>409 {error.reason ?? "Conflict"}</b>: “{error.message}”
          </span>
          {error.requestId ? <RequestId id={error.requestId} /> : null}
        </div>
      </div>
      {usedBy.length ? (
        <ul className="list">
          {usedBy.map((u) => (
            <li key={`${u.type}-${u.id}`} className="list-row">
              <span className="grow">
                <Link className="row-title link" to={usedByHref(u)}>
                  {u.name}
                </Link>
                <span className="row-sub">{u.type === "campaign" ? "Campaign" : "Automation"}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="hint">
        The refusal names up to 3 users, then “and N more”; the segment’s <span className="mono">usedBy</span>{" "}
        lists them all. Point them at another segment or topic, then delete this.
      </p>
    </Sheet>
  )
}

export function DeleteConfirmSheet({
  name,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  name: string
  busy: boolean
  error: unknown
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Sheet
      title={`Delete ${name}?`}
      sub="Nothing uses it. Contacts stay as they are; only the saved rules go."
      onClose={onClose}
      odId="segment-delete"
      endpoint="DELETE /v1/segments/:id"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Keep it
          </button>
          <button
            className={`btn btn-danger${busy ? " is-loading" : ""}`}
            type="button"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="trash" />}
            Delete segment
          </button>
        </>
      }
    >
      <p className="t-copy">Campaigns and automations can’t pick it afterwards. This can’t be undone.</p>
      {error ? <ApiErrorCallout error={error} what="The segment wasn’t deleted." /> : null}
    </Sheet>
  )
}

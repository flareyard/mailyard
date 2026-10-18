/**
 * Turn sending off (design: domain-disable-sending): what stops and what's kept, then the domain's name typed
 * exactly before `PATCH /v1/domains/{id} { sending: false }`. Routing is untouched, so mail still arrives.
 */
import { useId, useState } from "react"
import { ApiError } from "../api/client.ts"
import { fmtInt, num } from "../lib/format.ts"
import { Sheet } from "../ops/Overlay.tsx"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"
import type { Domain } from "./logic.ts"
import { useUpdateDomain } from "./queries.ts"

export function DisableSendingSheet({ domain, onClose }: { domain: Domain; onClose: () => void }) {
  const id = useId()
  const update = useUpdateDomain(domain.id)
  const [typed, setTyped] = useState("")
  const ok = typed.trim() === domain.name
  const boxes = num(domain.mailboxCount) ?? domain.mailboxes.length
  const err = update.error instanceof ApiError ? update.error : null
  const off = () =>
    update.mutate(
      { sending: false },
      {
        onSuccess: () => {
          toast({
            title: `Sending off for ${domain.name}`,
            action: { label: "Undo", run: () => update.mutate({ sending: true }) },
          })
          onClose()
        },
      },
    )
  return (
    <Sheet
      title={`Turn off sending for ${domain.name}?`}
      sub={
        domain.receiving
          ? "Routing stays on, so mail still arrives."
          : "Routing is already off for this domain."
      }
      onClose={onClose}
      odId="disable-sheet"
      endpoint={`PATCH /v1/domains/${domain.id} { sending: false }`}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn btn-danger${update.isPending ? " is-loading" : ""}`}
            type="button"
            aria-disabled={!ok || update.isPending}
            onClick={() => {
              if (ok && !update.isPending) off()
            }}
          >
            {update.isPending ? <span className="spinner" /> : null}
            Turn off sending
          </button>
        </>
      }
    >
      <ul className="consequences">
        <li>
          <Icon name="x-circle" />
          <span>
            Every send from <span className="mono">@{domain.name}</span> fails before it’s billed: API and
            automation mail, campaigns
            {boxes ? `, and replies from ${fmtInt(boxes)} mailbox${boxes === 1 ? "" : "es"}` : ""}.
          </span>
        </li>
        <li>
          <Icon name="x-circle" />
          <span>Automations pause at their next send step from this domain.</span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>Records stay in DNS, so turning it back on is instant.</span>
        </li>
      </ul>
      <div className="typed">
        <label className="label" htmlFor={`${id}-confirm`}>
          Type <code>{domain.name}</code> to turn sending off
        </label>
        <input
          className="input mono"
          id={`${id}-confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-autofocus=""
          onKeyDown={(e) => {
            if (e.key === "Enter" && ok && !update.isPending) off()
          }}
        />
      </div>
      {err ? (
        <div className="callout callout-error" role="alert">
          <Icon name="x-circle" />
          <span>
            <b>Sending is still on.</b> {err.message}{" "}
            {err.requestId ? <RequestId id={err.requestId} /> : null}
          </span>
        </div>
      ) : null}
    </Sheet>
  )
}

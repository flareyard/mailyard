/**
 * Pause, resume and cancel (design: campaign-sending.html, -cancel, -paused-*; GAPS-audience A7.12). Pause holds
 * a scheduled or sending campaign where it is; resume picks up where it stopped (after an automatic pause on
 * reputation it's offered as "Resume anyway…" with a warning first, A9.2); cancel ends it for good, and its report
 * stays. The sheet names how many go and how many already went.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { ApiErrorCallout, Sheet } from "../../audience/kit/ui.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { campaignQuery } from "../queries.ts"

export function useCampaignAction(id: string, action: "pause" | "resume" | "cancel") {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => {
      const opts = { params: { path: { id } } }
      if (action === "pause") return unwrap(api.POST("/v1/campaigns/{id}/pause", opts))
      if (action === "resume") return unwrap(api.POST("/v1/campaigns/{id}/resume", opts))
      return unwrap(api.POST("/v1/campaigns/{id}/cancel", opts))
    },
    onSuccess: (res) => {
      if (res && typeof res === "object" && "id" in res && "status" in res)
        qc.setQueryData(campaignQuery(id).queryKey, res)
      qc.invalidateQueries({ queryKey: ["campaigns"] })
      qc.invalidateQueries({ queryKey: ["alerts"] })
    },
  })
}

export function CancelSheet({
  id,
  name,
  sent,
  remaining,
  canPause,
  onClose,
  onPause,
}: {
  id: string
  name: string
  sent: number | string | null | undefined
  remaining: number | string | null | undefined
  canPause: boolean
  onClose: () => void
  onPause: () => void
}) {
  const cancel = useCampaignAction(id, "cancel")
  const s = num(sent) ?? 0
  const r = num(remaining)
  return (
    <Sheet
      title={`Cancel “${name}”?`}
      sub="It can’t be restarted; you’d duplicate it instead."
      onClose={onClose}
      endpoint={`POST /v1/campaigns/${id}/cancel`}
      odId="cancel-sheet"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            {s > 0 ? "Keep sending" : "Keep it"}
          </button>
          {canPause ? (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                onPause()
                onClose()
              }}
            >
              <Icon name="pause" />
              Pause instead
            </button>
          ) : null}
          <button
            className={`btn btn-danger${cancel.isPending ? " is-loading" : ""}`}
            type="button"
            onClick={() => cancel.mutate(undefined, { onSuccess: onClose })}
          >
            {cancel.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            Cancel campaign
          </button>
        </>
      }
    >
      <ul className="role-list">
        <li>
          <Icon name="x" />
          {r === null ? "Nothing more will go out." : `The ${fmtInt(r)} not yet sent won’t go.`}
        </li>
        {s > 0 ? (
          <li>
            <Icon name="check" />
            The {fmtInt(s)} already sent can’t be recalled; their report stays.
          </li>
        ) : null}
      </ul>
      {canPause ? (
        <p className="hint">Want to stop for now and decide later? Pause keeps the rest queued.</p>
      ) : null}
      {cancel.isError ? <ApiErrorCallout error={cancel.error} what="It wasn’t cancelled." /> : null}
    </Sheet>
  )
}

/** "Resume anyway…" after an automatic pause: what resuming risks, before it does. */
export function ResumeAnywaySheet({
  id,
  name,
  reason,
  pausedBy,
  onClose,
}: {
  id: string
  name: string
  reason: string | null
  pausedBy: string
  onClose: () => void
}) {
  const resume = useCampaignAction(id, "resume")
  const [ack, setAck] = useState(false)
  return (
    <Sheet
      title={`Resume “${name}” anyway?`}
      sub="The governor paused it to protect your sending reputation."
      onClose={onClose}
      endpoint={`POST /v1/campaigns/${id}/resume`}
      odId="resume-sheet"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Keep it paused
          </button>
          <button
            className={`btn btn-danger${resume.isPending ? " is-loading" : ""}`}
            type="button"
            disabled={!ack || resume.isPending}
            onClick={() => resume.mutate(undefined, { onSuccess: onClose })}
          >
            {resume.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" />}
            Resume anyway
          </button>
        </>
      }
    >
      <div className="callout callout-warn">
        <Icon name="warn" />
        <span>
          <b>{reason ? `“${reason}”` : "It crossed the governor’s line."}</b>{" "}
          {pausedBy === "complaint_rate"
            ? "More complaints on the rest of the list would cost more reputation than bounces. Cloudflare’s at-risk line for complaints is 0.2% of delivered."
            : "More bounces on the rest of the list push the account toward Cloudflare’s 5% at-risk line, where sending can be suspended."}{" "}
          The governor checks again as it sends and pauses it again if the rate stays over.
        </span>
      </div>
      <label className="check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I’ve checked who it goes to, and I want the rest to go out.</span>
      </label>
      {resume.isError ? <ApiErrorCallout error={resume.error} what="It didn’t resume." /> : null}
    </Sheet>
  )
}

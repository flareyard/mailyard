/**
 * Resend to non-openers (design: campaign-resend.html, campaign-resend-machine.html; GAPS-audience A7.7). The dry
 * run, `GET …/resend-non-openers?countMachineOpensAsOpened=`, is asked again whenever the toggle flips; it is
 * off by default, so people whose only opens were machine prefetches get the resend (they may never have read
 * it). Creating it is `POST …/resend-non-openers { countMachineOpensAsOpened, subject? }`: a new draft, nothing
 * sends. A key with send limits is refused with `409 agent_limit`, shown as the API words it.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fieldError } from "../../audience/kit/format.ts"
import { ApiErrorCallout, FieldError, Sheet, useCan } from "../../audience/kit/ui.tsx"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { PanelError } from "../../ui/Panel.tsx"
import { agentRefusal } from "../logic.ts"
import { type Campaign, type Report, resendDryRunQuery } from "../queries.ts"
import { AGENT_WHO, AgentRefusalCallout } from "../ui.tsx"

export function ResendSheet({
  campaign,
  report,
  onClose,
}: {
  campaign: Campaign
  report: Report | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const write = useCan("campaigns.write", "resend campaigns")
  const [countMachine, setCountMachine] = useState(false)
  const [subject, setSubject] = useState("")
  const dry = useQuery({ ...resendDryRunQuery(campaign.id, countMachine), placeholderData: keepPreviousData })
  const other = useQuery({ ...resendDryRunQuery(campaign.id, !countMachine), enabled: dry.isSuccess })
  const d = dry.data && "recipients" in dry.data ? dry.data : null
  const o = other.data && "recipients" in other.data ? other.data : null
  const [refused, setRefused] = useState<ReturnType<typeof agentRefusal>>(null)
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/campaigns/{id}/resend-non-openers", {
          params: { path: { id: campaign.id } },
          body: {
            countMachineOpensAsOpened: countMachine,
            ...(subject.trim() ? { subject: subject.trim() } : {}),
          },
        }),
      ),
    onSuccess: (res) => {
      setRefused(null)
      qc.invalidateQueries({ queryKey: ["campaigns"] })
      if (
        res &&
        typeof res === "object" &&
        "id" in res &&
        typeof res.id === "string" &&
        res.id !== campaign.id
      )
        void navigate({ to: "/campaigns/$campaignId/content", params: { campaignId: res.id } })
      else onClose()
    },
    onError: (e) => setRefused(agentRefusal(e)),
  })
  const machine = num(report?.machineOnlyOpens)
  const winner = report?.ab?.winner
    ? report.ab.variants.find((v) => v.variant === report.ab?.winner)?.subject
    : null
  const subjErr = fieldError(create.error, "subject")
  const blocked = refused?.reason === "agent_limit"
  const sendable = num(d?.sendable)
  return (
    <Sheet
      title="Resend to non-openers"
      sub="Makes a new draft campaign. Nothing sends until you schedule it."
      onClose={onClose}
      endpoint={`GET/POST /v1/campaigns/${campaign.id}/resend-non-openers`}
      odId="resend-sheet"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <Gated
            allowed={write.allowed && !blocked && sendable !== null && sendable > 0}
            reason={
              !write.allowed
                ? "You can’t resend campaigns"
                : blocked
                  ? "This key can’t create campaigns that send"
                  : "Nobody to resend to"
            }
            who={
              !write.allowed
                ? write.who
                : blocked
                  ? AGENT_WHO
                  : "Everyone who got it opened it, or can’t be mailed now."
            }
            side="up"
          >
            <button
              className={`btn btn-primary${create.isPending ? " is-loading" : ""}`}
              type="button"
              data-endpoint={`POST /v1/campaigns/${campaign.id}/resend-non-openers {countMachineOpensAsOpened, subject}`}
              onClick={() => create.mutate()}
            >
              {create.isPending ? <span className="spinner" aria-hidden="true" /> : null}
              {sendable === null ? "Create the draft" : `Create the draft for ${fmtInt(sendable)}`}
            </button>
          </Gated>
        </>
      }
    >
      <label className="switch rs-toggle" data-od-id="count-machine-opens">
        <input type="checkbox" checked={countMachine} onChange={(e) => setCountMachine(e.target.checked)} />{" "}
        Count machine-only opens as opened
      </label>
      <p className="hint">
        {countMachine ? (
          <>
            <b>On:</b> anyone with a machine open counts as having opened, so{" "}
            {machine !== null
              ? `the ${fmtInt(machine)} people whose only opens were machine prefetches`
              : "people whose only opens were machine prefetches"}{" "}
            don’t get the resend.
          </>
        ) : (
          <>
            <b>Off (the default):</b> {machine !== null ? `the ${fmtInt(machine)} people` : "people"} whose
            only opens were machine prefetches (Apple Mail Privacy Protection, link scanners) get the resend,
            because nobody may have read it. Mailyard goes by the first open a person made.
          </>
        )}
      </p>
      {dry.isError && !d ? (
        <PanelError error={dry.error} onRetry={() => dry.refetch()} what="The dry run didn’t answer" />
      ) : (
        <div
          className="rs-count"
          role="status"
          aria-live="polite"
          aria-busy={dry.isFetching}
          data-od-id="resend-dry-run"
          data-endpoint={`GET /v1/campaigns/${campaign.id}/resend-non-openers?countMachineOpensAsOpened=${countMachine}`}
        >
          <div>
            <span className="bs-l">Didn’t open</span>
            <b>{d ? fmtInt(d.recipients) : "…"}</b>
          </div>
          <div>
            <span className="bs-l">Can receive it</span>
            <b>{d ? fmtInt(d.sendable) : "…"}</b>
          </div>
          <span className="hint">
            A dry run: nothing is created.
            {o ? ` Turn it ${countMachine ? "off" : "on"} and it would be ${fmtInt(o.sendable)}.` : ""} The
            rest since unsubscribed, bounced or were suppressed.
          </span>
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor="rs-subj">
          New subject{" "}
          <span className="opt">
            optional · <code className="mono">subject</code>
          </span>
        </label>
        <input
          className="input"
          id="rs-subj"
          value={subject}
          maxLength={998}
          placeholder={winner ?? campaign.subject}
          onChange={(e) => setSubject(e.target.value)}
          {...(subjErr ? { "aria-invalid": true, "aria-describedby": "rs-subj-err" } : {})}
        />
        {subjErr ? <FieldError id="rs-subj-err">{subjErr}</FieldError> : null}
        <span className="hint">
          Leave it empty to reuse {winner ? "the winning subject" : "the same subject"}. A different subject
          usually does better on a resend.
        </span>
      </div>
      {refused ? <AgentRefusalCallout refusal={refused} what="The resend wasn’t created." /> : null}
      {create.isError && !refused && !subjErr ? (
        <ApiErrorCallout error={create.error} what="The resend wasn’t created." />
      ) : null}
    </Sheet>
  )
}

/**
 * Change the DMARC policy (HAL-3375). Every choice is previewed first with `PATCH …/dmarc?dryRun=1`, which
 * returns the record before and after; only "Write the record" (an explicit confirm on a preview that changes
 * something) calls it without `dryRun`. A refusal shows inline, keeping the preview so the record can be set
 * by hand: production has no zone token (HAL-3418), so `no_dns_token` is the usual answer today.
 */
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useReducer, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { CopyChip } from "../ops/Copy.tsx"
import { Sheet } from "../ops/Overlay.tsx"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"
import { canConfirm, type DmarcP, P_LABEL, type PolicyFlow, policyStep, refusalLine } from "./dmarc.ts"
import { changeDmarcPolicy } from "./queries.ts"
import { TokenNote } from "./ui.tsx"

const POLICIES: readonly DmarcP[] = ["none", "quarantine", "reject"]

function asRefusal(e: unknown) {
  if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
    return {
      reason: typeof e.body.reason === "string" ? e.body.reason : "other",
      message: e.message,
      ...(e.requestId ? { requestId: e.requestId } : {}),
    }
  }
  return null
}

export function DmarcPolicySheet({
  domainId,
  domainName,
  initial,
  onClose,
}: {
  domainId: string
  domainName: string
  initial: { p: DmarcP; pct: number | null }
  onClose: () => void
}) {
  const id = useId()
  const qc = useQueryClient()
  const [p, setP] = useState<DmarcP>(initial.p)
  const [pct, setPct] = useState<string>(initial.pct === null ? "" : String(initial.pct))
  const [flow, dispatch] = useReducer(policyStep, { step: "previewing" } as PolicyFlow)
  const seq = useRef(0)
  const pctNum = pct.trim() === "" ? null : Number(pct)
  const pctValid = pctNum === null || (Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 100)

  // Each choice is previewed; a newer choice supersedes an answer still in flight.
  useEffect(() => {
    if (!pctValid) return
    const n = ++seq.current
    dispatch({ type: "preview" })
    const t = setTimeout(async () => {
      try {
        const change = await changeDmarcPolicy(domainId, { p, pct: pctNum }, true)
        if (n === seq.current) dispatch({ type: "previewed", change })
      } catch (e) {
        if (n !== seq.current) return
        const r = asRefusal(e)
        dispatch(
          r
            ? { type: "refused", refusal: r }
            : { type: "failed", message: e instanceof Error ? e.message : "Mailyard couldn’t be reached." },
        )
      }
    }, 250)
    return () => clearTimeout(t)
  }, [domainId, p, pctNum, pctValid])

  const write = async () => {
    if (!canConfirm(flow)) return
    dispatch({ type: "confirm" })
    try {
      const change = await changeDmarcPolicy(domainId, { p, pct: pctNum }, false)
      dispatch({ type: "applied", change })
      void qc.invalidateQueries({ queryKey: ["domains", domainId] })
      toast({ title: `DMARC policy is now ${p}`, sub: "Receivers pick it up as the record's TTL runs out." })
    } catch (e) {
      const r = asRefusal(e)
      dispatch(
        r
          ? { type: "refused", refusal: r }
          : { type: "failed", message: e instanceof Error ? e.message : "Mailyard couldn’t be reached." },
      )
    }
  }

  const change = "change" in flow ? flow.change : null
  const applied = flow.step === "applied"

  return (
    <Sheet
      title={applied ? "DMARC policy changed" : "Preview the DNS change"}
      sub={`PATCH /v1/domains/${domainId}/dmarc${applied ? "" : "?dryRun=1"}`}
      wide
      onClose={onClose}
      odId="dmarc-policy-sheet"
      endpoint={`PATCH /v1/domains/${domainId}/dmarc?dryRun=1 { p, pct } · then without dryRun`}
      foot={
        applied ? (
          <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
            Done
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className={`btn btn-primary${flow.step === "applying" ? " is-loading" : ""}`}
              type="button"
              aria-disabled={!canConfirm(flow)}
              onClick={write}
              data-endpoint={`PATCH /v1/domains/${domainId}/dmarc { p, pct }`}
            >
              {flow.step === "applying" ? <span className="spinner" /> : <Icon name="check" />}
              {flow.step === "applying" ? "Writing…" : "Write the record"}
            </button>
          </>
        )
      }
    >
      {!applied ? (
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Policy
          </legend>
          {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
          <div className="seg" role="group" aria-label="Policy">
            {POLICIES.map((x) => (
              <button
                key={x}
                type="button"
                aria-pressed={x === p}
                disabled={flow.step === "applying"}
                onClick={() => setP(x)}
              >
                {x}
              </button>
            ))}
          </div>
          <span className="hint">{P_LABEL[p]}</span>
          <div className="field-row" style={{ marginTop: 10 }}>
            <div className="field">
              <label className="label" htmlFor={`${id}-pct`}>
                Apply to <span className="opt">· optional</span>
              </label>
              <div className="input-group">
                <input
                  className="input num"
                  id={`${id}-pct`}
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  value={pct}
                  placeholder="100"
                  aria-invalid={!pctValid || undefined}
                  disabled={flow.step === "applying" || p === "none"}
                  onChange={(e) => setPct(e.target.value)}
                />
                <span className="addon">% of failing mail</span>
              </div>
              {!pctValid ? <span className="field-error">A percentage, 0 to 100.</span> : null}
            </div>
          </div>
        </fieldset>
      ) : null}

      {flow.step === "previewing" ? (
        <p className="cluster muted" role="status">
          <span className="spinner" aria-hidden="true" /> Working out the record…
        </p>
      ) : null}

      {change ? (
        <div className="stack stack-8" data-od-id="dmarc-diff">
          <span className="label">
            <span className="mono">TXT {change.name}</span>
          </span>
          <div className="diff">
            <div className="diff-side is-old">
              <span className="t-small">{applied ? "Was" : "Now"}</span>
              <code>{change.before ?? "No DMARC record"}</code>
            </div>
            <div className="diff-side is-new">
              <span className="t-small">{applied ? "Now" : "Would become"}</span>
              <code>{change.after}</code>
            </div>
          </div>
          {!change.changed && !applied ? (
            <p className="hint">That’s the record already published; choose another policy to change it.</p>
          ) : null}
          {applied ? (
            <p className="hint">
              Written through the zone token. Receivers pick it up as the old record’s TTL runs out.
            </p>
          ) : null}
        </div>
      ) : null}

      {flow.step === "refused" ? (
        <div className="stack stack-12" role="alert">
          <div className="callout callout-warn">
            <Icon name="warn" />
            <span>
              <b>{refusalLine(flow.refusal)}</b> {flow.refusal.message}{" "}
              {flow.refusal.requestId ? <RequestId id={flow.refusal.requestId} /> : null}
            </span>
          </div>
          {flow.refusal.reason === "no_dns_token" ? (
            <TokenNote
              odId="dmarc-token-note"
              lead="Connect a zone token to let Mailyard write this record for you."
            />
          ) : null}
          {change ? (
            <div className="stack stack-4">
              <span className="label">Set it by hand at your DNS provider</span>
              <span className="ns">
                <code>{change.after}</code>
                <CopyChip value={change.after} what="the new DMARC record" />
              </span>
              <span className="hint">
                As a TXT record at <span className="mono">{change.name}</span>, replacing the one for{" "}
                <span className="mono">{domainName}</span>.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {flow.step === "error" ? (
        <div className="callout callout-error" role="alert">
          <Icon name="x-circle" />
          <span>
            <b>Nothing changed.</b> {flow.message}
          </span>
        </div>
      ) : null}
    </Sheet>
  )
}

/**
 * Fix records (design: domain-fix-result, -fix-routing, -fix-no-token, -fix-zone-not-found, -fix-nothing).
 * Runs `POST /v1/domains/{id}/fix` when it opens and shows each action the backend took: done, failed, or left
 * for a person (an existing DMARC record Mailyard won't overwrite, with the record to set and where). Each 409
 * reason gets its own explanation; nothing was changed in any of them.
 */
import { useEffect, useRef } from "react"
import { ApiError } from "../api/client.ts"
import { CopyChip } from "../ops/Copy.tsx"
import { Sheet } from "../ops/Overlay.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelSkeleton, RequestId } from "../ui/Panel.tsx"
import {
  actionTitle,
  type Check,
  checkLabel,
  type Domain,
  type FixAction,
  fixRefusal,
  parentZone,
  TOKEN_PERMISSIONS,
} from "./logic.ts"
import { useFix, useRecheck } from "./queries.ts"
import { StatePill, TokenNote } from "./ui.tsx"

export function FixSheet({ domain, onClose }: { domain: Domain; onClose: () => void }) {
  const fix = useFix(domain.id)
  const recheck = useRecheck(domain.id)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    fix.mutate()
  }, [fix])

  const err = fix.error instanceof ApiError ? fix.error : null
  const refusal = err?.status === 409 ? fixRefusal(err.body) : null
  const endpoint = `POST /v1/domains/${domain.id}/fix`

  const ok = (
    <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
      OK
    </button>
  )

  if (refusal === "no_dns_token")
    return (
      <Sheet
        title="Fix records needs a zone token"
        sub={`${endpoint} → 409 no_dns_token`}
        onClose={onClose}
        odId="fix-sheet"
        foot={ok}
      >
        <p>
          <b>Mailyard can’t change records without a zone token.</b> {err?.message}
        </p>
        <TokenNote
          odId="fix-token-note"
          lead="Connect a zone token to let Fix records repair these for you."
        />
        <p className="hint">
          Until then, each failing row on this page has the exact value to set at your DNS provider, with a
          copy button.
        </p>
      </Sheet>
    )
  if (refusal === "zone_not_found")
    return (
      <Sheet
        title="Zone not found"
        sub={`${endpoint} → 409 zone_not_found`}
        onClose={onClose}
        odId="fix-sheet"
        foot={ok}
      >
        <p>
          <b>
            The zone token can’t see{" "}
            <span className="mono">{domain.zoneName ?? parentZone(domain.name)}</span>.
          </b>{" "}
          {err?.message} The token may be limited to other zones, or the zone moved to another Cloudflare
          account.
        </p>
        <p>Give the token access to this zone ({TOKEN_PERMISSIONS}), then try again. Nothing was changed.</p>
      </Sheet>
    )
  if (refusal === "nothing_to_fix")
    return (
      <Sheet
        title="Every record matches"
        sub={`${endpoint} → 409 nothing_to_fix`}
        onClose={onClose}
        odId="fix-sheet"
        foot={ok}
      >
        <p>
          <b>Nothing to fix.</b> Every record already matches. Re-check if you changed something at your DNS
          provider in the last few minutes.
        </p>
      </Sheet>
    )

  const result = fix.data
  return (
    <Sheet
      title="Fix records"
      sub={
        result
          ? `${endpoint} → ${result.actions.length} action${result.actions.length === 1 ? "" : "s"}`
          : endpoint
      }
      wide
      onClose={onClose}
      odId="fix-sheet"
      endpoint={endpoint}
      foot={
        <>
          <button
            className={`btn btn-secondary${recheck.isPending ? " is-loading" : ""}`}
            type="button"
            disabled={!result || recheck.isPending}
            onClick={() => recheck.mutate()}
            data-endpoint={`POST /v1/domains/${domain.id}/recheck`}
          >
            {recheck.isPending ? <span className="spinner" /> : <Icon name="refresh" />}
            Re-check
          </button>
          <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
            Done
          </button>
        </>
      }
    >
      {fix.isPending || fix.isIdle ? (
        <div className="stack stack-8" role="status">
          <p className="cluster">
            <span className="spinner" aria-hidden="true" /> Asking Cloudflare to re-apply what fails…
          </p>
          <PanelSkeleton rows={2} />
        </div>
      ) : err || fix.error ? (
        <div className="error-block" role="alert">
          <h3>
            <Icon name="warn" />
            Fix records didn’t run
          </h3>
          <p>
            {err ? (
              <>
                The API answered <b>{err.status}</b>: {err.message}
              </>
            ) : (
              "Mailyard couldn’t be reached. Nothing was changed."
            )}
          </p>
          <div className="cluster">
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => fix.mutate()}>
              <Icon name="refresh" />
              Try again
            </button>
            {err?.requestId ? <RequestId id={err.requestId} /> : null}
          </div>
        </div>
      ) : result ? (
        <>
          <ol className="fix-list" data-od-id="fix-actions">
            {result.actions.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: actions have no id and keep their order
              <ActionItem key={i} a={a} domain={result.domain} />
            ))}
          </ol>
          <p className="hint">
            Mailyard re-checked the records after fixing; the list behind this shows what public DNS answers
            now.
          </p>
        </>
      ) : null}
    </Sheet>
  )
}

function ActionItem({ a, domain }: { a: FixAction; domain: Domain }) {
  if (a.action === "manual") {
    const rows = domain.checks.filter((c) => a.checks.includes(c.id))
    return (
      <li className="fix-act is-manual" data-od-id="fix-manual">
        <span className="fa-icon">
          <Icon name="pencil" />
        </span>
        <div className="fa-body">
          <b>{actionTitle(a)}</b>
          <StatePill state={{ tone: "warn", label: "Needs you" }} />
          <p>{a.detail}</p>
          {rows.map((c) => (
            <ManualRecord key={c.id} c={c} />
          ))}
        </div>
      </li>
    )
  }
  return (
    <li className={`fix-act ${a.ok ? "is-ok" : "is-fail"}`}>
      <span className="fa-icon">
        <Icon name={a.ok ? "check-circle" : "x-circle"} className={a.ok ? "status-pass" : "status-fail"} />
      </span>
      <div className="fa-body">
        <b>{actionTitle(a)}</b>
        <StatePill state={a.ok ? { tone: "pass", label: "Done" } : { tone: "fail", label: "Failed" }} />
        <span className="t-small muted">
          Checks: {a.checks.map((c) => checkLabel(c as Check["id"]).toLowerCase()).join(", ")} ·{" "}
          <span className="mono">{a.action}</span>
        </span>
        <p>{a.detail}</p>
      </div>
    </li>
  )
}

function ManualRecord({ c }: { c: Check }) {
  return (
    <dl className="kv dm-kv">
      <dt>Published now</dt>
      <dd>
        {c.actual.length ? (
          <code className="mono">{c.actual.join(" · ")}</code>
        ) : (
          <span className="muted">Nothing</span>
        )}
      </dd>
      <dt>Set it to</dt>
      <dd>
        <span className="ns">
          <code>{c.expected}</code>
          <CopyChip value={c.expected} what={`the ${checkLabel(c.id)} value`} />
        </span>
      </dd>
      <dt>Where</dt>
      <dd>
        <span className="mono">
          {c.type} {c.name}
        </span>
        , at the zone’s DNS
      </dd>
    </dl>
  )
}

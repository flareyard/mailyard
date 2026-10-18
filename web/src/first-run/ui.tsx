/**
 * The parts every first-run step shares, in the designs' classes: the step panel, DNS rows, field errors,
 * copy buttons, timelines, a two-step confirm, and clocks for countdowns.
 */
import { type ReactNode, useEffect, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { Icon, type IconName } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"
import type { RowState } from "./logic.ts"

export function StepPanel({
  id,
  n,
  title,
  lede,
  endpoint,
  children,
  actions,
}: {
  id: string
  n: number
  title: string
  lede: ReactNode
  endpoint: string
  children?: ReactNode
  actions?: ReactNode
}) {
  const h = useRef<HTMLHeadingElement>(null)
  // Moving between steps moves focus to the new step's heading, so a screen reader hears where it landed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the step changes, by design
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      const inStepper = (document.activeElement as HTMLElement).closest?.(".steps")
      if (inStepper) h.current?.focus({ preventScroll: true })
    }
  }, [id])
  return (
    <section className="panel step-panel" data-endpoint={endpoint} data-step={id} aria-labelledby="sp-title">
      <div className="panel-body">
        <div>
          <span className="cluster" style={{ ["--gap" as string]: "8px" }}>
            <span className="t-small muted">Step {n} of 6</span>
          </span>
          <h2 id="sp-title" ref={h} tabIndex={-1} style={{ marginTop: 4 }}>
            {title}
          </h2>
          <p className="lede">{lede}</p>
        </div>
        {children}
        {actions ? (
          <div className="cluster cluster-12" style={{ paddingTop: 4 }}>
            {actions}
          </div>
        ) : null}
      </div>
    </section>
  )
}

const ROW: Record<RowState, { icon: IconName; cls: string; label: string; pill: string }> = {
  pass: { icon: "check-circle", cls: "status-pass", label: "Passing", pill: "pill-pass" },
  warn: { icon: "warn", cls: "status-warn", label: "Warning", pill: "pill-warn" },
  fail: { icon: "x-circle", cls: "status-fail", label: "Failing", pill: "pill-fail" },
  error: { icon: "x-circle", cls: "status-fail", label: "Lookup failed", pill: "pill-fail" },
  checking: { icon: "circle-dash", cls: "status-info", label: "Checking", pill: "pill-info" },
  waiting: { icon: "circle-dash", cls: "status-idle", label: "Waiting", pill: "pill-neutral" },
  idle: { icon: "circle-dash", cls: "status-idle", label: "Will be added", pill: "pill-neutral" },
}

export function DnsRow({
  check,
  type,
  purpose,
  name,
  value,
  actual,
  state,
  idleLabel,
  detail,
}: {
  check: string
  type: string
  purpose: string
  name: string
  value: string
  actual: readonly string[]
  state: RowState
  idleLabel?: string
  detail?: string | undefined
}) {
  const r = ROW[state]
  const label = state === "idle" && idleLabel ? idleLabel : r.label
  const showActual = (state === "fail" || state === "warn") && actual.length > 0
  const showDetail = (state === "fail" || state === "warn" || state === "error") && detail
  return (
    <div className={`dns-row is-${state}`} data-check={check}>
      <span className="dns-state-icon">
        <Icon name={r.icon} className={`status-icon ${r.cls}`} label={label} />
      </span>
      <span className="dns-type">
        {type}
        <span className="purpose">{purpose}</span>
      </span>
      <span className="dns-name">{name}</span>
      <span className="dns-value">
        {value}
        {showActual ? <span className="actual">Found: {actual.join(" · ")}</span> : null}
      </span>
      <span className="dns-state cluster cluster-4">
        <span className={`pill ${r.pill}`}>{label}</span>
        <CopyButton value={value} label={`Copy ${check} value`} />
      </span>
      {showDetail ? <p className="dns-detail">{detail}</p> : null}
    </div>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      className="copy-btn"
      type="button"
      aria-label={done ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(value)
          setDone(true)
        } catch {}
      }}
    >
      <Icon name={done ? "check" : "copy"} />
    </button>
  )
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p className="field-error" id={id} role="alert">
      <Icon name="x-circle" />
      <span>{children}</span>
    </p>
  )
}

/** Props for an input that may carry an error, wired to its hint and error ids. */
export function describe(error: unknown, errId: string, hintId?: string) {
  return error
    ? ({ "aria-invalid": true, "aria-describedby": errId } as const)
    : hintId
      ? ({ "aria-describedby": hintId } as const)
      : {}
}

/** A refusal the API answered, in words, with the request id; or "couldn't reach Mailyard". */
export function ApiErrorCallout({ error, what }: { error: unknown; what?: string }) {
  const e = error instanceof ApiError ? error : null
  return (
    <div className="callout callout-error" role="alert">
      <Icon name="x-circle" />
      <div className="stack stack-4">
        <span>
          {what ? <b>{what} </b> : null}
          {e ? e.message : "Mailyard couldn’t be reached. Check your connection and try again."}
        </span>
        {e?.requestId ? <RequestId id={e.requestId} /> : null}
      </div>
    </div>
  )
}

export function TlItem({ icon, children, time }: { icon: IconName; children: ReactNode; time?: ReactNode }) {
  return (
    <li className="tl-item">
      <Icon name={icon} />
      <span>{children}</span>
      {time !== undefined ? <span className="tl-time">{time}</span> : null}
    </li>
  )
}

/** "17:47:20", the timeline's clock (UTC, as every time on these screens). */
export function clock(ms: number | null | undefined, seconds = true): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—"
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${seconds ? `:${p(d.getUTCSeconds())}` : ""}`
}

/** A clock that ticks, for countdowns and "time left". */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, active])
  return now
}

/**
 * Runs `fn` every `everyMs` while `active`, and says how long until the next run. `fn` is called through a ref,
 * so a new closure each render doesn't restart the timer.
 */
export function useEvery(fn: () => unknown, everyMs: number, active: boolean) {
  const ref = useRef(fn)
  ref.current = fn
  const [nextAt, setNextAt] = useState<number | null>(null)
  useEffect(() => {
    if (!active) {
      setNextAt(null)
      return
    }
    let stopped = false
    let t: ReturnType<typeof setTimeout>
    const schedule = () => {
      setNextAt(Date.now() + everyMs)
      t = setTimeout(async () => {
        try {
          await ref.current()
        } finally {
          if (!stopped) schedule()
        }
      }, everyMs)
    }
    schedule()
    return () => {
      stopped = true
      clearTimeout(t)
    }
  }, [everyMs, active])
  const now = useNow(1000, active)
  return nextAt === null ? null : Math.max(0, Math.ceil((nextAt - now) / 1000))
}

/** A destructive button that asks once more in place, instead of a modal. */
export function ConfirmButton({
  label,
  confirm,
  hint,
  onConfirm,
  busy,
  className = "btn btn-ghost",
}: {
  label: string
  confirm: string
  hint?: string
  onConfirm: () => void
  busy?: boolean
  className?: string
}) {
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (!asking) return
    const t = setTimeout(() => setAsking(false), 8000)
    return () => clearTimeout(t)
  }, [asking])
  if (!asking)
    return (
      <button className={className} type="button" onClick={() => setAsking(true)}>
        {label}
      </button>
    )
  return (
    <span className="cluster" style={{ ["--gap" as string]: "8px" }}>
      <button
        className={`btn btn-danger${busy ? " is-loading" : ""}`}
        type="button"
        onClick={() => {
          setAsking(false)
          onConfirm()
        }}
        // biome-ignore lint/a11y/noAutofocus: the second step of a confirm takes focus so Enter confirms
        autoFocus
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        {confirm}
      </button>
      <button className="btn btn-ghost" type="button" onClick={() => setAsking(false)}>
        Keep it
      </button>
      {hint ? <span className="hint">{hint}</span> : null}
    </span>
  )
}

/** A key-value table, as the step results use: `<KvTable><Kv label="Zone">…</Kv></KvTable>`. */
export function KvTable({ children }: { children: ReactNode }) {
  return (
    <table className="table kv-table">
      <tbody>{children}</tbody>
    </table>
  )
}

export function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <td className="muted">{label}</td>
      <td>{children}</td>
    </tr>
  )
}

export function ZoneTokenHint() {
  return (
    <div className="callout callout-info" data-od-id="zone-token-hint">
      <Icon name="key" />
      <div className="stack stack-4">
        <span>
          <b>No zone token yet.</b> Connect a zone token to pick a domain from your Cloudflare account and see
          its registrar and status here. Until then, type the domain; Mailyard checks it in public DNS.
        </span>
        <span className="t-small muted">
          A zone token is a Cloudflare API token with Zone read and DNS edit. Add it as{" "}
          <code className="mono">CLOUDFLARE_DNS_TOKEN</code> in Flareyard (founder step HAL-3418).
        </span>
      </div>
    </div>
  )
}

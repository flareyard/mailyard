/**
 * Pieces the Integrations, agent and approval screens share: the settings section head, scope tags, the agent
 * status pill, the limits fields (new agent and agent detail) and the "In your repo" marker.
 */
import { type ReactNode, useId, useState } from "react"
import { Icon } from "../../ui/icons.tsx"
import { type AgentStatus, addDomains, type Limits, limitsProblems } from "./logic.ts"

/** The head of a settings page (design: `.spread > div > h2.t-h2 + p.muted`, actions on the right). */
export function SectionHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
      <div>
        <h2 className="t-h2">{title}</h2>
        {sub ? (
          <p className="muted" style={{ marginTop: 4 }}>
            {sub}
          </p>
        ) : null}
      </div>
      <div className="cluster">{actions}</div>
    </div>
  )
}

export function ScopeTags({ scopes }: { scopes: readonly string[] }) {
  return (
    <span className="scope-tags">
      {scopes.map((s) => (
        <span key={s} className="tag">
          {s}
        </span>
      ))}
    </span>
  )
}

export function AgentStatusPill({ status }: { status: AgentStatus }) {
  if (status === "active")
    return (
      <span className="pill pill-pass">
        <span className="dot" />
        Active
      </span>
    )
  return (
    <span className="pill pill-neutral">
      <span className="dot" />
      {status === "removed" ? "Removed" : "Revoked"}
    </span>
  )
}

export function RepoPill() {
  return (
    <span className="pill pill-repo">
      In your repo
      <span className="sr-only">
        . Files in your Mailyard repo, used by your coding agent or a CLI command. The web app doesn’t run
        them, and there’s no API behind this.
      </span>
    </span>
  )
}

export function PlannedTag({ issue }: { issue: string }) {
  return <span className="tag planned-tag">planned · {issue}</span>
}

const RECIPIENTS: { key: Limits["recipients"]; label: string }[] = [
  { key: "any", label: "Anyone" },
  { key: "contacts", label: "Contacts only" },
  { key: "domains", label: "Allowed domains" },
]

/**
 * The limits an agent's key works inside (HAL-3460, live): sends per day (empty for no cap), who it can send
 * to, the allowed domains, and whether every send waits for approval.
 */
export function LimitsFields({
  value,
  onChange,
  showErrors,
  idPrefix,
}: {
  value: Limits
  onChange: (l: Limits) => void
  showErrors: boolean
  idPrefix: string
}) {
  const [typed, setTyped] = useState("")
  const [bad, setBad] = useState<string[]>([])
  const hintId = useId()
  const problems = showErrors ? limitsProblems(value) : {}
  const commit = () => {
    if (!typed.trim()) return
    const r = addDomains(value.allowDomains, typed)
    onChange({ ...value, allowDomains: r.domains })
    setBad(r.invalid)
    setTyped(r.invalid.join(" "))
  }
  return (
    <>
      <div className="field-row">
        <div className={`field${problems.sendsPerDay ? " is-invalid" : ""}`}>
          <label className="label" htmlFor={`${idPrefix}-cap`}>
            Sends per day
          </label>
          <input
            className="input num"
            id={`${idPrefix}-cap`}
            type="number"
            min={0}
            max={100000}
            step={1}
            inputMode="numeric"
            placeholder="No cap"
            value={value.sendsPerDay ?? ""}
            aria-invalid={problems.sendsPerDay ? true : undefined}
            aria-describedby={`${idPrefix}-cap-hint`}
            onChange={(e) =>
              onChange({ ...value, sendsPerDay: e.target.value === "" ? null : Number(e.target.value) })
            }
          />
          <span className={problems.sendsPerDay ? "field-error" : "hint"} id={`${idPrefix}-cap-hint`}>
            {problems.sendsPerDay ?? "Counted per UTC day. Leave it empty for no cap."}
          </span>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Who it can send to
          </legend>
          {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control inside a fieldset */}
          <div className="seg" role="group" aria-label="Recipients">
            {RECIPIENTS.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={value.recipients === r.key}
                onClick={() => onChange({ ...value, recipients: r.key })}
              >
                {r.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <div className={`field${problems.allowDomains ? " is-invalid" : ""}`}>
        <label className="label" htmlFor={`${idPrefix}-dom`}>
          Allowed domains <span className="opt">· with “Allowed domains”</span>
        </label>
        <div className="cluster">
          {value.allowDomains.map((d) => (
            <span className="chip" key={d}>
              <span className="mono">{d}</span>
              <button
                type="button"
                aria-label={`Remove ${d}`}
                onClick={() =>
                  onChange({ ...value, allowDomains: value.allowDomains.filter((x) => x !== d) })
                }
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
          <input
            className="input mono"
            id={`${idPrefix}-dom`}
            style={{ width: 180, maxWidth: "100%", height: 32 }}
            placeholder="Add a domain"
            value={typed}
            aria-describedby={hintId}
            aria-invalid={bad.length || problems.allowDomains ? true : undefined}
            onChange={(e) => {
              setTyped(e.target.value)
              if (bad.length) setBad([])
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault()
                commit()
              } else if (e.key === "Backspace" && !typed && value.allowDomains.length) {
                onChange({ ...value, allowDomains: value.allowDomains.slice(0, -1) })
              }
            }}
          />
        </div>
        <span className={bad.length || problems.allowDomains ? "field-error" : "hint"} id={hintId}>
          {bad.length
            ? `Not a domain: ${bad.join(", ")}.`
            : (problems.allowDomains ??
              "Subdomains count too. Only used when “Allowed domains” is chosen; outside it a send gets 409 recipient_not_allowed.")}
        </span>
      </div>
      <label className="switch">
        <input
          type="checkbox"
          checked={value.requireApproval}
          onChange={(e) => onChange({ ...value, requireApproval: e.target.checked })}
        />
        Require approval for every send
      </label>
      <span className="hint">Held sends wait in the approval queue until a person approves them.</span>
    </>
  )
}

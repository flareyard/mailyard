/**
 * The frame every editor step shares (design: campaign-content.html and siblings, campaign-editor-error.html,
 * campaign-editor-loading.html): the back link, the object header with "Last saved … by the <key> key", the
 * five steps with their states, the phone's read-only note, and the stale-save conflict panel.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import { useKeyName } from "../../audience/kit/queries.ts"
import { BackLink, SampleMarker, StatusPill, useCan, useNow } from "../../audience/kit/ui.tsx"
import { Gated } from "../../auth/NoPermission.tsx"
import { fixturesEnabled } from "../../fixtures/mode.ts"
import { fmtAgo } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import {
  changesAsText,
  checksSummary,
  fmtStamp,
  STEP_LABEL,
  STEPS,
  type Step,
  unsavedChanges,
} from "../logic.ts"
import { checksQuery } from "../queries.ts"
import { useEditor } from "./EditorContext.tsx"

const NEXT: Partial<Record<Step, Step>> = {
  content: "audience",
  audience: "preview",
  preview: "checks",
  checks: "schedule",
}

export function EditorFrame({
  step,
  children,
  actions,
}: {
  step: Step
  children: ReactNode
  /** Extra actions before "Next" (the schedule step's own buttons replace Next). */
  actions?: ReactNode
}) {
  const ed = useEditor()
  const navigate = useNavigate()
  const write = useCan("campaigns.write", "edit campaigns")
  const checks = useQuery(checksQuery(ed.id))
  const c = ed.draft
  const next = NEXT[step]

  const goNext = async () => {
    if (!next) return
    const ok = ed.editable ? await ed.flush() : true
    if (ok) void navigate({ to: `/campaigns/$campaignId/${next}`, params: { campaignId: ed.id } })
  }

  useFixtureSaveProbe()

  const stepState = (s: Step): "" | "is-done" | "is-warn" | "is-fail" => {
    if (s === "content") return c.subject && (c.bodyBlocks || c.bodyHtml || c.templateId) ? "is-done" : ""
    if (s === "audience") return c.segmentId || c.topicId ? "is-done" : ""
    if (s === "preview") return c.lastTest ? "is-done" : ""
    if (s === "checks") {
      if (!checks.data) return ""
      const sum = checksSummary(checks.data.checks)
      return sum.fail ? "is-fail" : sum.warn ? "is-warn" : "is-done"
    }
    return c.status !== "draft" ? "is-done" : ""
  }

  return (
    <>
      <BackLink to="/campaigns">Campaigns</BackLink>
      <div className="obj-head" data-od-id="object-head">
        <div className="oh-main">
          <NameHeading />
          <div className="oh-sub">
            <StatusPill status={c.status} />
            <code className="mono">{c.id}</code>
            <SaveState />
          </div>
        </div>
        <div className="oh-actions">
          <SampleMarker />
          {actions}
          {step !== "preview" && step !== "schedule" && ed.editable ? (
            <Link
              className="btn btn-secondary btn-sm edit-only"
              to="/campaigns/$campaignId/preview"
              params={{ campaignId: ed.id }}
              hash="test"
              data-od-id="send-test"
            >
              <Icon name="send" />
              Send a test
            </Link>
          ) : null}
          {next ? (
            <Gated
              allowed={write.allowed || !ed.editable}
              reason="You can’t edit campaigns"
              who={write.who}
              side="right"
            >
              <button
                className={`btn btn-primary btn-sm edit-only${ed.state === "saving" ? " is-loading" : ""}`}
                type="button"
                onClick={goNext}
                data-od-id="next-step"
              >
                Next: {STEP_LABEL[next].toLowerCase()}
                <Icon name="arrow-right" />
              </button>
            </Gated>
          ) : null}
        </div>
      </div>
      <ol className="hsteps" aria-label="Campaign steps" data-od-id="editor-steps">
        {STEPS.map((s, i) => {
          const st = stepState(s)
          return (
            <li key={s} className={`hstep ${st}`}>
              <Link
                to={`/campaigns/$campaignId/${s}`}
                params={{ campaignId: ed.id }}
                aria-current={s === step ? "step" : undefined}
                onClick={() => {
                  if (ed.editable && ed.state === "dirty") void ed.flush()
                }}
              >
                <span className="hs-ic">
                  {st === "is-done" ? (
                    <Icon name="check" />
                  ) : st === "is-warn" || st === "is-fail" ? (
                    "!"
                  ) : (
                    i + 1
                  )}
                </span>
                {STEP_LABEL[s]}
                {st === "is-fail" && checks.data ? (
                  <span className="hs-badge">{checksSummary(checks.data.checks).fail}</span>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ol>
      {ed.editable ? (
        <div className="ro-note phone-only" role="note" data-od-id="phone-read-only">
          <Icon name="monitor" />
          <span>
            <b>Read-only on a phone.</b> The campaign editor needs a wider screen to edit. Everything here is
            current; open it on a tablet or computer to change it.
          </span>
        </div>
      ) : (
        <div className="ro-note" role="note" data-od-id="locked-note">
          <Icon name="lock" />
          <span>
            <b>This campaign is {c.status}, so it can’t be edited.</b> Once scheduled, a campaign’s content is
            what it is. Cancel it and duplicate it from the list to change it.
          </span>
        </div>
      )}
      <ConflictPanel />
      {children}
    </>
  )
}

function NameHeading() {
  const ed = useEditor()
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(ed.draft.name)
  useEffect(() => setV(ed.draft.name), [ed.draft.name])
  if (!editing)
    return (
      <h1 data-od-id="page-title" className="cluster" style={{ gap: 8, flexWrap: "wrap" }}>
        <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{ed.draft.name}</span>
        {ed.editable ? (
          <button
            className="icon-btn edit-only"
            type="button"
            aria-label="Rename"
            onClick={() => setEditing(true)}
          >
            <Icon name="pencil" />
          </button>
        ) : null}
      </h1>
    )
  const done = () => {
    const t = v.trim()
    if (t && t !== ed.draft.name) ed.set({ name: t.slice(0, 200) })
    setEditing(false)
  }
  return (
    <h1 data-od-id="page-title">
      <label className="sr-only" htmlFor="cmp-name">
        Campaign name
      </label>
      <input
        className="input"
        id="cmp-name"
        value={v}
        maxLength={200}
        // biome-ignore lint/a11y/noAutofocus: rename puts the cursor in the name it opened
        autoFocus
        onChange={(e) => setV(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === "Enter") done()
          if (e.key === "Escape") {
            setV(ed.draft.name)
            setEditing(false)
          }
        }}
      />
    </h1>
  )
}

function SaveState() {
  const ed = useEditor()
  const keyName = useKeyName()
  const now = useNow(30_000)
  const s = ed.server
  let content: ReactNode
  let icon: Parameters<typeof Icon>[0]["name"] = "check"
  if (ed.state === "conflict") {
    icon = "warn"
    content = "Not saved: someone else saved first"
  } else if (ed.state === "error") {
    icon = "x-circle"
    content = "Not saved"
  } else if (ed.state === "saving") {
    icon = "refresh"
    content = "Saving…"
  } else if (ed.state === "dirty") {
    icon = "pencil"
    content = "Unsaved changes"
  } else if (s.updatedAt !== null) {
    content = `Last saved ${fmtAgo(s.updatedAt, now)}${s.updatedBy ? ` by ${keyName(s.updatedBy)}` : ""}`
  } else {
    content = `Created ${fmtAgo(s.createdAt, now)}`
  }
  return (
    <span
      className="savestate"
      data-od-id="last-saved"
      data-endpoint={`GET /v1/campaigns/${s.id} · updatedBy, updatedAt`}
      role="status"
      aria-live="polite"
    >
      <Icon name={icon} />
      {content}
    </span>
  )
}

function ConflictPanel() {
  const ed = useEditor()
  const keyName = useKeyName()
  const [copied, setCopied] = useState(false)
  const [reloading, setReloading] = useState(false)
  if (!ed.conflict) return null
  const changes = unsavedChanges(
    ed.server as unknown as Record<string, unknown>,
    ed.edits as Record<string, unknown>,
  )
  const who = ed.conflict.updatedBy ? ` (${keyName(ed.conflict.updatedBy)})` : ""
  return (
    <section
      className="conflict"
      role="alert"
      aria-labelledby="cf-title"
      data-od-id="save-conflict"
      data-endpoint={`PATCH /v1/campaigns/${ed.id} {ifMatch: updatedAt} → 409 {reason: stale}`}
    >
      <h2 className="t-h3" id="cf-title">
        <Icon name="warn" />
        {ed.conflict.updatedAt !== null
          ? `Someone else saved this at ${fmtStamp(ed.conflict.updatedAt)}${who}`
          : `Someone else saved this first${who}`}
      </h2>
      <p>
        Your save was refused, so nothing was overwritten: “{ed.conflict.message}” Your changes are still here
        in this tab.
      </p>
      {changes.length ? (
        <div className="stack stack-8">
          <span className="label">Your unsaved changes</span>
          <ul className="list">
            {changes.map((c) => (
              <li key={c.field} className="list-row">
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row-title">{c.label}</span>
                  <span className="row-sub" style={{ whiteSpace: "normal" }}>
                    Yours: {c.yours}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="cluster">
        <button
          className={`btn btn-primary btn-sm${reloading ? " is-loading" : ""}`}
          type="button"
          data-endpoint={`GET /v1/campaigns/${ed.id}`}
          onClick={async () => {
            setReloading(true)
            try {
              await ed.reloadTheirs()
            } finally {
              setReloading(false)
            }
          }}
        >
          <Icon name="refresh" />
          Reload their version
        </button>
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          data-od-id="copy-changes"
          onClick={async () => {
            try {
              await navigator.clipboard?.writeText(
                changesAsText(changes, ed.edits as Record<string, unknown>),
              )
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            } catch {}
          }}
        >
          <Icon name={copied ? "check" : "copy"} />
          {copied ? "Copied" : "Copy my changes"}
        </button>
      </div>
      <p className="hint">
        Reload shows what they saved; paste your changes back where you still want them, then save. Saves send{" "}
        <code className="mono">ifMatch</code> with the version you loaded, so one never silently replaces
        another.
      </p>
    </section>
  )
}

/**
 * Fixture mode only: the designed refusal screens (a stale save, a section error, a bad time zone) are the
 * answer to a save, so with `?fx=` naming one of them the editor saves once on open to show it.
 */
const PROBE =
  /^campaign-(editor-error|content-conflict|content-.*-error|audience-.*-error|audience-complex|schedule-timezone)$/
function useFixtureSaveProbe() {
  const ed = useEditor()
  // biome-ignore lint/correctness/useExhaustiveDependencies: once on open
  useEffect(() => {
    if (!fixturesEnabled() || !ed.editable) return
    const fx = new URLSearchParams(window.location.search).get("fx")
    if (!fx || !PROBE.test(fx)) return
    const field = fx.includes("timezone")
      ? { timezone: "Lagos" }
      : fx.includes("audience")
        ? { exclude: ed.draft.exclude }
        : { subject: ed.draft.subject }
    ed.set(field)
    void ed.flush()
  }, [])
}

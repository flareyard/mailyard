/**
 * The API key sheets (design: api-key-create(-public), api-key-created, api-key-rotate, api-key-rotated,
 * api-key-revoke; the limits panel from settings/agent-detail, live since HAL-3460). A secret is shown once,
 * on the step after the call, and never stored.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type FormEvent, useId, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { CodeBlock, Secret } from "../../ops/Copy.tsx"
import { fmtSeconds, utcShort } from "../../ops/format.ts"
import { Time } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import {
  addDomain,
  draftProblem,
  envLine,
  fromApi,
  GRACE_MAX,
  GRACE_PRESETS,
  isUnlimited,
  type KeyDraft,
  type KeyLike,
  keyState,
  type LimitsDraft,
  limitsProblem,
  orderScopes,
  parseGrace,
  type Recipients,
  SCOPES,
  toDraft,
  toggleScope,
  toLimits,
  withKind,
} from "./logic.ts"
import { limitsQuery } from "./queries.ts"
import { prefixed, Refusal } from "./ui.tsx"

const invalidateKeys = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: ["api-keys"] })

function ScopeTags({ scopes }: { scopes: readonly string[] }) {
  return (
    <span className="scope-tags">
      {orderScopes(scopes).map((s) => (
        <span key={s} className={`tag${s === "admin" ? " is-strong" : ""}`}>
          {s}
        </span>
      ))}
    </span>
  )
}

// ── Create ────────────────────────────────────────────────────────────────────────────────────────────────

export function CreateKeySheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const nameId = useId()
  const [d, setD] = useState<KeyDraft>({
    name: "",
    kind: "secret",
    scopes: ["send", "track"],
    purpose: "api",
  })
  const [tried, setTried] = useState(false)
  const create = useMutation({
    mutationFn: (draft: KeyDraft) =>
      unwrap(
        api.POST("/v1/api-keys", {
          body: { name: draft.name.trim(), kind: draft.kind, scopes: draft.scopes, purpose: draft.purpose },
        }),
      ),
    onSuccess: () => invalidateKeys(qc),
  })
  const problem = draftProblem(d)

  if (create.data) {
    const { key, apiKey } = create.data
    return (
      <Sheet
        wide
        title="Key created"
        sub="Copy it before you close this."
        onClose={onClose}
        odId="created-key-sheet"
        foot={
          <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
            <Icon name="check" />
            I’ve stored it
          </button>
        }
      >
        <Secret
          value={key}
          label={apiKey.kind === "public" ? "Your new public key" : "Your new secret key"}
        />
        <dl className="kv">
          <dt>Name</dt>
          <dd>{apiKey.name}</dd>
          <dt>Prefix</dt>
          <dd>
            <span className="mono">{prefixed(apiKey.prefix)}</span> · how it appears in lists and logs
          </dd>
          <dt>Scopes</dt>
          <dd>
            <ScopeTags scopes={apiKey.scopes} />
          </dd>
          <dt>Purpose</dt>
          <dd>
            <span className="tag">{apiKey.purpose}</span>
          </dd>
        </dl>
        <CodeBlock title=".env" code={envLine(key)} />
      </Sheet>
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (problem) return
    create.mutate(d)
  }
  const isPublic = d.kind === "public"
  return (
    <Sheet
      wide
      title="Create an API key"
      sub="The secret is shown once, on the next step."
      onClose={onClose}
      odId="create-key-sheet"
      endpoint="POST /v1/api-keys { name, kind, scopes, purpose }"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            form="create-key-form"
            aria-disabled={create.isPending}
            data-endpoint="POST /v1/api-keys { name, kind, scopes, purpose }"
          >
            <Icon name="key" />
            {create.isPending ? "Creating…" : "Create key"}
          </button>
        </>
      }
    >
      <form id="create-key-form" className="stack stack-16" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor={nameId}>
            Name
          </label>
          <input
            className="input"
            id={nameId}
            value={d.name}
            maxLength={100}
            placeholder="Mobile app"
            aria-invalid={tried && !d.name.trim()}
            onChange={(e) => setD({ ...d, name: e.target.value })}
            data-autofocus=""
          />
          <span className="hint">Who or what uses it. You’ll see this in the audit log.</span>
        </div>
        <fieldset className="field tb-fieldset">
          <legend className="label">Kind</legend>
          {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
          <div className="seg" role="group" aria-label="Key kind">
            <button type="button" aria-pressed={!isPublic} onClick={() => setD(withKind(d, "secret"))}>
              Secret · sk_
            </button>
            <button type="button" aria-pressed={isPublic} onClick={() => setD(withKind(d, "public"))}>
              Public · pk_
            </button>
          </div>
          <span className="hint">
            Secret keys stay on a server. Public keys can sit in a web page and only track.
          </span>
        </fieldset>
        <fieldset className="field tb-fieldset">
          <legend className="label">Scopes</legend>
          <div className="pick-grid">
            {SCOPES.map((s) => {
              const on = d.scopes.includes(s.id)
              const off = isPublic && s.id !== "track"
              return (
                <label key={s.id} className={`pick${on ? " is-on" : ""}${off ? " is-disabled" : ""}`}>
                  <input
                    className="check tb-check"
                    type="checkbox"
                    checked={on}
                    disabled={off}
                    onChange={() => setD(toggleScope(d, s.id))}
                  />
                  <span className="p-name">
                    {s.label} <code className="tag">{s.id}</code>
                  </span>
                  <span className="p-sub">{s.sub}</span>
                </label>
              )
            })}
          </div>
        </fieldset>
        <fieldset className="field tb-fieldset" data-od-id="purpose-choice">
          <legend className="label">Purpose</legend>
          {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
          <div className="seg" role="group" aria-label="Key purpose">
            <button
              type="button"
              aria-pressed={d.purpose === "api"}
              onClick={() => setD({ ...d, purpose: "api" })}
            >
              api
            </button>
            {isPublic ? (
              <span className="has-reason">
                <button
                  type="button"
                  aria-pressed="false"
                  aria-disabled="true"
                  aria-describedby="why-purpose-mcp"
                >
                  <Icon name="lock" className="icon-12" />
                  mcp
                </button>
                <span className="reason-pop" role="tooltip" id="why-purpose-mcp">
                  <b>Public keys can’t be used for MCP</b>
                  <span className="reason-who">
                    The MCP server only takes secret keys. Choose Secret to make an agent key.
                  </span>
                </span>
              </span>
            ) : (
              <button
                type="button"
                aria-pressed={d.purpose === "mcp"}
                onClick={() => setD({ ...d, purpose: "mcp" })}
              >
                mcp
              </button>
            )}
          </div>
          {isPublic ? (
            <>
              <span className="hint purpose-why">
                <Icon name="lock" className="icon-12" />
                <span>
                  <b>mcp is off: public keys can’t be used for MCP.</b> The MCP server only takes secret keys;
                  choose Secret to make an agent key.
                </span>
              </span>
              <span className="hint">
                A public key is always <span className="mono">api</span>. If a request sends{" "}
                <span className="mono">purpose: "mcp"</span> with <span className="mono">kind: "public"</span>
                , the API refuses it: <span className="mono">400 InvalidRequest</span>, “Public keys can’t be
                used for MCP” (<span className="mono">field: purpose</span>).
              </span>
            </>
          ) : (
            <span className="hint">
              A label for finding keys later. <b>It isn’t a permission:</b> scopes and mailboxes decide what
              an agent can do, and an <span className="mono">api</span> key with the right scopes also works
              over MCP. For an agent, <Link to="/settings/integrations">Connect an agent</Link> sets{" "}
              <span className="mono">mcp</span> for you, with its mailboxes.
            </span>
          )}
        </fieldset>
        {tried && problem ? (
          <p className="field-error" role="alert">
            <Icon name="warn" className="icon-12" />
            {problem}
          </p>
        ) : null}
        <Refusal error={create.error} what="The key wasn’t created." />
      </form>
    </Sheet>
  )
}

// ── Rotate ────────────────────────────────────────────────────────────────────────────────────────────────

export function RotateSheet({
  k,
  loading,
  onClose,
}: {
  k: KeyLike | undefined
  loading: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const graceId = useId()
  const [grace, setGrace] = useState(86_400)
  const [raw, setRaw] = useState("86400")
  const rotate = useMutation({
    mutationFn: (v: { id: string; graceSeconds: number }) =>
      unwrap(
        api.POST("/v1/api-keys/{id}/rotate", {
          params: { path: { id: v.id } },
          body: { graceSeconds: v.graceSeconds },
        }),
      ),
    onSuccess: () => invalidateKeys(qc),
  })

  if (!k)
    return (
      <Sheet title="Rotate key" onClose={onClose}>
        {loading ? <PanelSkeleton rows={2} /> : <p>No key with that id. It may have been revoked already.</p>}
      </Sheet>
    )

  if (rotate.data) {
    const { key, apiKey, previous } = rotate.data
    return (
      <Sheet
        wide
        title="Key rotated"
        sub="Copy the new key, deploy it, then let the old one run out."
        onClose={onClose}
        odId="rotated-key-sheet"
        foot={
          <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
            <Icon name="check" />
            I’ve stored it
          </button>
        }
      >
        <Secret
          value={key}
          label="The new key"
          note={
            <>
              <b>This is the only time you’ll see it.</b> Mailyard keeps a hash, not the key.
            </>
          }
        />
        <dl className="kv">
          <dt>New key</dt>
          <dd>
            {apiKey.name} · <span className="mono">{prefixed(apiKey.prefix)}</span>
          </dd>
          <dt>Scopes</dt>
          <dd>
            <ScopeTags scopes={apiKey.scopes} />
          </dd>
          <dt>Purpose</dt>
          <dd>
            <span className="tag">{apiKey.purpose}</span>
          </dd>
          <dt>Old key</dt>
          <dd>
            {(num(previous.revokedAt) ?? 0) > Date.now() ? (
              <>
                <span className="pill pill-warn">
                  <span className="dot" />
                  Rotating
                </span>{" "}
                works until <Time value={previous.revokedAt} mode="full" />
              </>
            ) : (
              <>
                <span className="pill pill-neutral">
                  <span className="dot" />
                  Revoked
                </span>{" "}
                stopped at once
              </>
            )}
          </dd>
          <dt>Copied</dt>
          <dd>Name, scopes, purpose and mailbox memberships</dd>
        </dl>
        <CodeBlock title=".env" code={envLine(key)} />
      </Sheet>
    )
  }

  const until = Date.now() + grace * 1000
  const setSeconds = (s: number) => {
    setGrace(s)
    setRaw(String(s))
  }
  return (
    <Sheet
      wide
      title={`Rotate “${k.name}”`}
      sub="Creates a replacement key; the old one stops when the grace period ends."
      onClose={onClose}
      odId="rotate-key-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            aria-disabled={rotate.isPending}
            onClick={() => !rotate.isPending && rotate.mutate({ id: k.id, graceSeconds: grace })}
            data-endpoint={`POST /v1/api-keys/${k.id}/rotate { graceSeconds: ${grace} }`}
          >
            <Icon name="refresh" />
            {rotate.isPending ? "Rotating…" : "Rotate key"}
          </button>
        </>
      }
    >
      <p>
        A new key replaces <b>{k.name}</b> <span className="mono muted">{prefixed(k.prefix)}</span>. It copies
        the old one’s <b>name, scopes, purpose and mailbox memberships</b>, and is shown once.
      </p>
      <fieldset className="field tb-fieldset" data-od-id="grace-choice">
        <legend className="label">Keep the old key working for</legend>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
        <div className="seg seg-grace" role="group" aria-label="Grace period">
          {GRACE_PRESETS.map((p) => (
            <button
              key={p.seconds}
              type="button"
              aria-pressed={grace === p.seconds}
              onClick={() => setSeconds(p.seconds)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="field-row" style={{ marginTop: 10 }}>
          <div className="field">
            <label className="label" htmlFor={graceId}>
              Or exactly, in seconds
            </label>
            <div className="input-group">
              <input
                className="input num"
                id={graceId}
                type="number"
                min={0}
                max={GRACE_MAX}
                step={60}
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value)
                  const g = parseGrace(e.target.value)
                  if (g !== null) setGrace(g)
                }}
                onBlur={() => setRaw(String(grace))}
              />
              <span className="addon">s · 0 to 604,800</span>
            </div>
          </div>
        </div>
        <span className="hint">
          From now (0) up to 7 days.{" "}
          {grace === 0 ? (
            <>The old key stops at once.</>
          ) : (
            <>
              With {fmtSeconds(grace).toLowerCase()}, the old key stops at <b>{utcShort(until)}</b>, giving
              you time to deploy the new one.
            </>
          )}
        </span>
      </fieldset>
      <ul className="consequences">
        <li className="ok">
          <Icon name="check-circle" />
          <span>
            Until then both keys work, and the old one shows as <b>Rotating</b> in the list.
          </span>
        </li>
        <li>
          <Icon name="x-circle" />
          <span>
            After that, requests with the old key get <span className="mono">401</span> Unauthorized. Choose
            Now to cut it off at once.
          </span>
        </li>
      </ul>
      <Refusal error={rotate.error} what="The key wasn’t rotated." />
    </Sheet>
  )
}

// ── Revoke (and “Stop the old key now”) ───────────────────────────────────────────────────────────────────

export function RevokeSheet({
  k,
  loading,
  onClose,
}: {
  k: KeyLike | undefined
  loading: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [typedV, setTyped] = useState("")
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/v1/api-keys/{id}", { params: { path: { id } } })),
    onSuccess: async () => {
      await invalidateKeys(qc)
      toast({ title: `Revoked ${k?.name ?? "the key"}`, sub: "Requests with it now get 401 Unauthorized." })
      onClose()
    },
  })
  if (!k)
    return (
      <Sheet title="Revoke key" onClose={onClose}>
        {loading ? <PanelSkeleton rows={2} /> : <p>No key with that id.</p>}
      </Sheet>
    )
  const rotating = keyState(k) === "rotating"
  const requests = num(k.requests24h)
  const ok = typedV.trim() === k.name && !revoke.isPending
  return (
    <Sheet
      title={rotating ? `Stop the old “${k.name}” now?` : `Revoke “${k.name}”?`}
      sub={
        rotating
          ? "The rotation’s new key keeps working. Only the old one stops."
          : "This can’t be undone. Create a new key first if something still needs one."
      }
      onClose={onClose}
      odId="revoke-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            type="button"
            aria-disabled={!ok}
            onClick={() => ok && revoke.mutate(k.id)}
            data-endpoint={`DELETE /v1/api-keys/${k.id}`}
          >
            {revoke.isPending ? "Revoking…" : rotating ? "Stop the old key" : "Revoke key"}
          </button>
        </>
      }
    >
      <p>
        <b>{k.name}</b> <span className="mono muted">{prefixed(k.prefix)}</span> stops working at once.
        Requests with it get <span className="mono">401 Unauthorized</span>.
      </p>
      <ul className="consequences">
        <li>
          <Icon name="x-circle" />
          <span>
            {requests !== null ? (
              <>
                It sent <b>{fmtInt(requests)}</b> requests in the last 24 hours
                {k.lastUsedAt ? (
                  <>
                    , the last one <Time value={k.lastUsedAt} />
                  </>
                ) : null}
                . Whatever uses it will start failing.
              </>
            ) : (
              "Whatever uses it will start failing."
            )}
          </span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>Messages it already sent keep their history and stay in the log.</span>
        </li>
      </ul>
      <ConfirmInput
        match={k.name}
        verb={rotating ? "stop it" : "revoke it"}
        value={typedV}
        onChange={setTyped}
      />
      <Refusal error={revoke.error} what="The key wasn’t revoked." />
    </Sheet>
  )
}

/** The typed-confirmation field (`.typed`); the sheet owns the value so its foot can gate the button. */
export function ConfirmInput({
  match,
  verb,
  value,
  onChange,
}: {
  match: string
  verb: string
  value: string
  onChange: (v: string) => void
}) {
  const inputId = useId()
  return (
    <div className="typed">
      <label className="label" htmlFor={inputId}>
        Type <code>{match}</code> to {verb}
      </label>
      <input
        className="input"
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        data-autofocus=""
      />
    </div>
  )
}

// ── Send limits (HAL-3460) ────────────────────────────────────────────────────────────────────────────────

const RECIPIENTS: { id: Recipients; label: string }[] = [
  { id: "any", label: "Anyone" },
  { id: "contacts", label: "Contacts only" },
  { id: "domains", label: "Allowed domains" },
]

export function LimitsSheet({
  k,
  id,
  admin,
  onClose,
}: {
  k: KeyLike | undefined
  id: string
  admin: boolean
  onClose: () => void
}) {
  const q = useQuery(limitsQuery(id))
  return (
    <Sheet
      wide
      title={k ? `Send limits for “${k.name}”` : "Send limits"}
      sub="A daily cap, who it may write to, and whether every send waits for a person’s yes."
      onClose={onClose}
      odId="limits-sheet"
      endpoint={`GET /v1/api-keys/${id}/limits · PUT /v1/api-keys/${id}/limits (built, HAL-3460)`}
    >
      {q.isPending ? (
        <PanelSkeleton rows={4} />
      ) : q.isError ? (
        <PanelError error={q.error} onRetry={() => q.refetch()} what="Limits didn’t load" />
      ) : (
        <LimitsForm id={id} initial={q.data} admin={admin} onDone={onClose} />
      )}
    </Sheet>
  )
}

type LimitsData = NonNullable<
  ReturnType<
    typeof useQuery<Awaited<ReturnType<NonNullable<ReturnType<typeof limitsQuery>["queryFn"]>>>>
  >["data"]
>

function LimitsForm({
  id,
  initial,
  admin,
  onDone,
}: {
  id: string
  initial: LimitsData
  admin: boolean
  onDone: () => void
}) {
  const qc = useQueryClient()
  const capId = useId()
  const domId = useId()
  const [d, setD] = useState<LimitsDraft>(() => toDraft(fromApi(initial.limits)))
  const [domain, setDomain] = useState("")
  const [domainError, setDomainError] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const save = useMutation({
    mutationFn: (draft: LimitsDraft) => {
      const l = toLimits(draft)
      return unwrap(
        api.PUT("/v1/api-keys/{id}/limits", {
          params: { path: { id } },
          body: { limits: isUnlimited(l) ? null : l },
        }),
      )
    },
    onSuccess: (data) => {
      qc.setQueryData(limitsQuery(id).queryKey, data)
      toast({
        title: "Limits saved",
        sub: data.limits ? "They apply from the next send." : "No limits on this key.",
      })
      onDone()
    },
  })
  const sent = num(initial.sentToday) ?? 0
  const cap = fromApi(initial.limits)?.sendsPerDay ?? null
  const problem = limitsProblem(d)
  const add = () => {
    if (!domain.trim()) return
    const r = addDomain(d.allowDomains, domain)
    setDomainError(r.error)
    if (!r.error) {
      setD({ ...d, allowDomains: r.list })
      setDomain("")
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!admin || problem || save.isPending) return
    save.mutate(d)
  }
  return (
    <form className="stack stack-16" onSubmit={submit} noValidate>
      <div className="stack stack-8">
        <div className="stat">
          <span className="stat-label">Sends today</span>
          <span className="stat-value">
            {fmtInt(sent)}{" "}
            {cap !== null ? <span className="t-label muted tb-of">of {fmtInt(cap)}</span> : null}
          </span>
        </div>
        {cap !== null && cap > 0 ? (
          // biome-ignore lint/a11y/useSemanticElements: the design's meter bar; <meter> can't take the ember fill
          <div
            className={`meter${sent >= cap ? " is-full" : sent / cap > 0.8 ? " is-warn" : ""}`}
            style={{ height: 8 }}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={cap}
            aria-valuenow={Math.min(sent, cap)}
            aria-label="Sends today"
          >
            <span style={{ width: `${Math.min(100, (sent / cap) * 100)}%` }} />
          </div>
        ) : null}
        <span className="hint">
          Resets 00:00 UTC. Over the cap, sends are refused with <span className="mono">409 agent_limit</span>
          .
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor={capId}>
          Sends per day <span className="opt">· empty for no cap</span>
        </label>
        <input
          className="input num"
          id={capId}
          type="number"
          min={0}
          max={100000}
          step={1}
          value={d.cap}
          disabled={!admin}
          onChange={(e) => setD({ ...d, cap: e.target.value })}
          data-autofocus=""
        />
      </div>
      <fieldset className="field tb-fieldset">
        <legend className="label">Who it can send to</legend>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
        <div className="seg seg-grace" role="group" aria-label="Recipients">
          {RECIPIENTS.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={d.recipients === r.id}
              disabled={!admin}
              onClick={() => setD({ ...d, recipients: r.id })}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="hint">
          {d.recipients === "any"
            ? "No restriction on recipients."
            : d.recipients === "contacts"
              ? "Only people already in your contacts. Anyone else is refused with 409 recipient_not_allowed."
              : "Only these domains and their subdomains. Anyone else is refused with 409 recipient_not_allowed."}
        </span>
        {d.recipients === "domains" ? (
          <div className="stack stack-8" style={{ marginTop: 8 }}>
            {d.allowDomains.length ? (
              <div className="cluster">
                {d.allowDomains.map((x) => (
                  <span key={x} className="chip">
                    <span className="mono">{x}</span>
                    {admin ? (
                      <button
                        type="button"
                        aria-label={`Remove ${x}`}
                        onClick={() => setD({ ...d, allowDomains: d.allowDomains.filter((y) => y !== x) })}
                      >
                        <Icon name="x" className="icon-12" />
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : null}
            {admin ? (
              <div className="field">
                <label className="label" htmlFor={domId}>
                  Add a domain
                </label>
                <div className="tb-inline">
                  <input
                    className="input mono"
                    id={domId}
                    value={domain}
                    placeholder="coursified.app"
                    aria-invalid={Boolean(domainError)}
                    onChange={(e) => setDomain(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault()
                        add()
                      }
                    }}
                  />
                  <button className="btn btn-secondary" type="button" onClick={add}>
                    Add
                  </button>
                </div>
                {domainError ? <span className="field-error">{domainError}</span> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </fieldset>
      <label className="switch">
        <input
          type="checkbox"
          checked={d.requireApproval}
          disabled={!admin}
          onChange={(e) => setD({ ...d, requireApproval: e.target.checked })}
        />
        Require approval for every send
      </label>
      <span className="hint" style={{ marginTop: -8 }}>
        Held sends wait in <Link to="/settings/integrations">the approval queue</Link> until a person approves
        or rejects them.
      </span>
      {tried && problem ? (
        <p className="field-error" role="alert">
          <Icon name="warn" className="icon-12" />
          {problem}
        </p>
      ) : null}
      <Refusal error={save.error} what="The limits weren’t saved." />
      <div className="cluster tb-end">
        {admin ? (
          <button
            className="btn btn-primary"
            type="submit"
            aria-disabled={save.isPending}
            data-endpoint={`PUT /v1/api-keys/${id}/limits { limits }`}
          >
            {save.isPending ? "Saving…" : "Save limits"}
          </button>
        ) : (
          <span className="has-reason">
            <button
              className="btn btn-primary"
              type="button"
              aria-disabled="true"
              aria-describedby="why-limits"
            >
              Save limits
            </button>
            <span className="reason-pop is-right is-up" role="tooltip" id="why-limits">
              <b>Senders can’t change limits</b>
              <span className="reason-who">Owners and admins set a key’s limits.</span>
            </span>
          </span>
        )}
      </div>
    </form>
  )
}

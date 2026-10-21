/**
 * New agent mailbox (design: agent-new, agent-new-result, agent-new-error; HAL-3460, live). One call,
 * `POST /v1/agents { name, address, displayName?, scopes, limits }`, makes the mailbox, a `purpose: mcp` key
 * that owns it, and its limits. The key and the `claude mcp add` command come back once, here, and live only
 * in this sheet's state: closing it drops them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type FormEvent, useMemo, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { CodeTabs, CopyChip, Secret } from "../../ops/Copy.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { LimitsFields, ScopeTags } from "./common.tsx"
import { MutationError } from "./KeySheets.tsx"
import {
  anyClient,
  DEFAULT_LIMITS,
  describeLimits,
  isHttpsUrl,
  isLocalPart,
  type Limits,
  limitsProblems,
  SCOPE_INFO,
  suggestLocal,
  toLimits,
  toolsFor,
} from "./logic.ts"
import { type Created, domainsQuery } from "./queries.ts"
import { ScopeToolsMore } from "./ScopePicks.tsx"

type AgentScope = "read" | "send" | "track"
const AGENT_SCOPES: AgentScope[] = ["read", "send", "track"]

export function AgentNewSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const domains = useQuery(domainsQuery)
  const sending = useMemo(() => (domains.data?.domains ?? []).filter((d) => d.sending), [domains.data])
  const [name, setName] = useState("")
  const [local, setLocal] = useState("")
  const [localTouched, setLocalTouched] = useState(false)
  const [domain, setDomain] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [wakeUrl, setWakeUrl] = useState("")
  const [scopes, setScopes] = useState<AgentScope[]>(["read", "send"])
  const [withLimits, setWithLimits] = useState(true)
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS)
  const [tried, setTried] = useState(false)
  const [result, setResult] = useState<Created | null>(null)

  const chosenDomain = domain || sending[0]?.name || ""
  const localPart = localTouched ? local : local || suggestLocal(name)
  const address = localPart && chosenDomain ? `${localPart}@${chosenDomain}` : ""

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/agents", {
          body: {
            name: name.trim(),
            address,
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            scopes,
            ...(withLimits ? { limits } : {}),
            ...(wakeUrl.trim() ? { wake: { url: wakeUrl.trim() } } : {}),
          },
        }),
      ),
    onSuccess: async (r) => {
      setResult(r)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["agents"] }),
        qc.invalidateQueries({ queryKey: ["api-keys"] }),
        qc.invalidateQueries({ queryKey: ["mailboxes"] }),
      ])
      toast({ title: `${r.agent.name} is ready`, sub: r.agent.mailbox.address ?? undefined })
    },
  })

  const err = create.error instanceof ApiError ? create.error : null
  const conflict = err?.status === 409
  const fieldErr = err?.status === 400 && typeof err.body.field === "string" ? err.body.field : null

  const problems = {
    name: !name.trim() ? "Give the agent a name." : name.length > 80 ? "At most 80 characters." : null,
    local: !localPart
      ? "Choose an address."
      : !isLocalPart(localPart)
        ? "Letters, digits, dots, dashes and plus only."
        : null,
    domain: !chosenDomain ? "Add a sending domain first." : null,
    scopes: scopes.length === 0 ? "Pick at least one scope." : null,
    limits: withLimits && Object.keys(limitsProblems(limits)).length > 0 ? "Check the limits." : null,
    wake: wakeUrl.trim() && !isHttpsUrl(wakeUrl) ? "An https:// URL the agent’s runtime listens on." : null,
  }
  const blocked = Object.values(problems).some(Boolean)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (blocked || create.isPending) return
    create.mutate()
  }

  if (result) return <Result result={result} onClose={onClose} />

  return (
    <Sheet
      title="New agent mailbox"
      sub="An address, a key and limits for one agent."
      wide
      onClose={onClose}
      odId="agent-new-sheet"
      endpoint="POST /v1/agents { name, address, displayName, scopes, limits, wake } (built, HAL-3460, HAL-3461)"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            form="agent-new-form"
            aria-disabled={create.isPending}
          >
            {create.isPending ? "Creating…" : "Create agent mailbox"}
          </button>
        </>
      }
    >
      <form className="stack stack-16" id="agent-new-form" onSubmit={submit} noValidate>
        <div className="field-row">
          <div className={`field${tried && problems.name ? " is-invalid" : ""}`}>
            <label className="label" htmlFor="ag-name">
              Agent name
            </label>
            <input
              className="input"
              id="ag-name"
              value={name}
              maxLength={80}
              data-autofocus=""
              aria-invalid={tried && problems.name ? true : undefined}
              aria-describedby="ag-name-hint"
              onChange={(e) => setName(e.target.value)}
            />
            <span className={tried && problems.name ? "field-error" : "hint"} id="ag-name-hint">
              {tried && problems.name
                ? problems.name
                : "How it appears in lists, the audit log and the approval queue."}
            </span>
          </div>
          <div
            className={`field${(tried && (problems.local || problems.domain)) || conflict || fieldErr === "address" ? " is-invalid" : ""}`}
          >
            <label className="label" htmlFor="ag-local">
              Address
            </label>
            <div className="input-group">
              <input
                className="input mono"
                id="ag-local"
                value={localPart}
                aria-invalid={(tried && problems.local) || conflict ? true : undefined}
                aria-describedby="ag-addr-hint"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => {
                  setLocalTouched(true)
                  setLocal(e.target.value.trim())
                  if (conflict) create.reset()
                }}
              />
              <span className="addon">@</span>
              <select
                className="select"
                aria-label="Sending domain"
                style={{ width: "auto", minWidth: 0 }}
                value={chosenDomain}
                onChange={(e) => {
                  setDomain(e.target.value)
                  if (conflict) create.reset()
                }}
              >
                {sending.length === 0 ? <option value="">No sending domain</option> : null}
                {sending.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <span
              className={
                (tried && (problems.local || problems.domain)) || conflict || fieldErr === "address"
                  ? "field-error"
                  : "hint"
              }
              id="ag-addr-hint"
            >
              {conflict || fieldErr === "address"
                ? (err?.message ?? `${address} already exists. Pick another address.`)
                : tried && (problems.local || problems.domain)
                  ? (problems.local ?? problems.domain)
                  : domains.isError
                    ? "Domains didn’t load, so the list may be empty. Retry by reopening this sheet."
                    : "Domains you can send from. Mail sent there lands in the agent’s own mailbox."}
            </span>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="ag-display">
            Display name <span className="opt">· optional</span>
          </label>
          <input
            className="input"
            id="ag-display"
            value={displayName}
            maxLength={120}
            placeholder={name || "Shown in the From line"}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className={`field${tried && problems.wake ? " is-invalid" : ""}`}>
          <label className="label" htmlFor="ag-wake">
            Wake URL <span className="opt">· optional</span>
          </label>
          <input
            className="input mono"
            id="ag-wake"
            type="url"
            inputMode="url"
            value={wakeUrl}
            placeholder="https://agent.example.com/mailyard"
            aria-invalid={tried && problems.wake ? true : undefined}
            aria-describedby="ag-wake-hint"
            onChange={(e) => setWakeUrl(e.target.value)}
          />
          <span className={tried && problems.wake ? "field-error" : "hint"} id="ag-wake-hint">
            {tried && problems.wake
              ? problems.wake
              : "Where the agent’s runtime listens. Mailyard posts a signed mail.received event there for each message to this agent’s address, and shows its signing secret once."}
          </span>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Scopes
          </legend>
          <div className="pick-grid">
            {AGENT_SCOPES.map((s) => {
              const on = scopes.includes(s)
              return (
                <label key={s} className={`pick${on ? " is-on" : ""}`}>
                  <input
                    className="check"
                    type="checkbox"
                    checked={on}
                    style={{ appearance: "auto", width: 16, height: 16 }}
                    onChange={(e) =>
                      setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))
                    }
                  />
                  <span className="p-name">
                    {SCOPE_INFO[s].label} <code className="tag">{s}</code>
                  </span>
                  <span className="p-sub">
                    {toolsFor([s])
                      .map((t) => t.name)
                      .join(", ")}
                  </span>
                </label>
              )
            })}
          </div>
          {tried && problems.scopes ? <span className="field-error">{problems.scopes}</span> : null}
          <ScopeToolsMore />
          <span className="hint" style={{ marginTop: 6 }}>
            An agent never gets <span className="mono">admin</span>. Its key is a secret key with{" "}
            <span className="mono">purpose: mcp</span>.
          </span>
        </fieldset>
        <fieldset className="field limits-set sb-limits" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Limits
          </legend>
          <label className="switch">
            <input type="checkbox" checked={withLimits} onChange={(e) => setWithLimits(e.target.checked)} />
            Set limits for this agent
          </label>
          {withLimits ? (
            <LimitsFields value={limits} onChange={setLimits} showErrors={tried} idPrefix="ag" />
          ) : (
            <p className="hint">Without limits the agent is bounded by its scopes and its mailbox only.</p>
          )}
        </fieldset>
        {create.isError && !conflict && fieldErr !== "address" ? (
          <MutationError error={create.error} what="The agent wasn’t created" />
        ) : null}
      </form>
    </Sheet>
  )
}

function Result({ result, onClose }: { result: Created; onClose: () => void }) {
  const a = result.agent
  return (
    <Sheet
      title="Agent mailbox created"
      sub="Copy the key before you close this."
      wide
      onClose={onClose}
      odId="agent-new-sheet"
      foot={
        <>
          <Link className="btn btn-secondary" to="/agents/$id" params={{ id: a.id }}>
            Open the agent
          </Link>
          <button className="btn btn-primary" type="button" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="callout callout-ok">
        <Icon name="check-circle" />
        <span>
          <b>{a.name} has its own address:</b> <span className="mono">{a.mailbox.address}</span>. Mail sent
          there lands in its mailbox, and a person can read it in Mail.
        </span>
      </div>
      <Secret
        value={result.key}
        label="The agent’s key"
        note={
          <>
            <b>This is the only time you’ll see it.</b> Paste it into the agent’s runtime now.
          </>
        }
      />
      <CodeTabs
        label="Connect the agent"
        tabs={[
          { id: "new-claude", label: "Claude Code", code: result.mcp.command },
          { id: "new-any", label: "Any MCP client", code: anyClient(result.mcp.url, result.key) },
        ]}
      />
      <dl className="kv">
        <dt>Address</dt>
        <dd>
          {a.mailbox.address ? (
            <>
              <span className="mono">{a.mailbox.address}</span>
              <CopyChip value={a.mailbox.address} what="the address" />
            </>
          ) : (
            <span className="muted">No address of its own</span>
          )}
        </dd>
        <dt>Key</dt>
        <dd>
          <span className="mono">{a.key?.prefix}…</span> · purpose mcp
        </dd>
        <dt>Scopes</dt>
        <dd>
          <ScopeTags scopes={a.key?.scopes ?? []} />
        </dd>
        <dt>Mailbox</dt>
        <dd>
          <span className="mono">{a.mailbox.address}</span> · owner
        </dd>
        <dt>Limits</dt>
        <dd>{describeLimits(toLimits(a.limits))}</dd>
      </dl>
      {result.wake ? (
        <>
          <Secret
            value={result.wake.secret}
            label="The wake webhook’s signing secret"
            what="secret"
            note={
              <>
                <b>This is the only time you’ll see it.</b> The runtime verifies each delivery’s{" "}
                <span className="mono">webhook-signature</span> with it.
              </>
            }
          />
          <p className="hint">
            Wake endpoint{" "}
            <Link
              className="link mono"
              to="/transactional/webhooks/$id"
              params={{ id: result.wake.endpointId }}
            >
              {result.wake.endpointId}
            </Link>{" "}
            gets <span className="mono">mail.received</span> for this agent’s mailbox only.
          </p>
        </>
      ) : (
        <p className="hint">
          Next: wake the agent on new mail with a webhook to its runtime, or let it long-poll. Both are on the
          agent’s page.
        </p>
      )}
    </Sheet>
  )
}

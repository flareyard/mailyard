/**
 * An agent's page (design: agent-detail, -new, -loading, -error, -no-admin; HAL-3460, live): who it is, what
 * it did (the audit log with its key as the actor), its limits and today's sends, how it hears about new mail,
 * and rotate, remove and (not in the API) pause.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useEffect, useState } from "react"
import { AgentsHead } from "../../agents/ui.tsx"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { useMe } from "../../auth/session.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { CodeBlock, Secret } from "../../ops/Copy.tsx"
import { BuiltPill, Empty, Time, TypedConfirm } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { isAdmin } from "../../ops/roles.ts"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { actionName, diffLines, targetRoute } from "../audit/logic.ts"
import { AgentStatusPill, LimitsFields, ScopeTags } from "./common.tsx"
import { MutationError, RotateKeySheet } from "./KeySheets.tsx"
import {
  activityKind,
  agentStatus,
  capPercent,
  DEFAULT_LIMITS,
  describeLimits,
  isHttpsUrl,
  type Limits,
  limitsProblems,
  readRefs,
  toLimits,
  waitCurl,
} from "./logic.ts"
import { type Agent, type AuditEntry, agentQuery, type Body, keyAuditQuery } from "./queries.ts"
import "./integrations.css"

const route = getRouteApi("/_app/agents/$id")

export function AgentDetail() {
  const { id } = route.useParams()
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const me = useMe().data
  const admin = isAdmin(me)
  const q = useQuery({ ...agentQuery(id), enabled: admin })
  const setSheet = (sheet?: "rotate" | "remove" | "wake") =>
    navigate({
      search: (s) => ({ ...(s.fx ? { fx: s.fx } : {}), ...(sheet ? { sheet } : {}) }),
      replace: !sheet,
    })

  const head = <AgentsHead title={q.data?.name ?? "Agent"} sub={null} crumb />
  if (!admin)
    return (
      <>
        {head}
        <div className="locked">
          <span className="empty-icon">
            <Icon name="lock" />
          </span>
          <h2>Agents need the admin scope</h2>
          <p>
            {me?.key ? (
              <>
                The key you’re signed in with, <b>{me.key.name}</b>, has{" "}
                {me.scopes.join(" and ") || "no scopes"}.{" "}
              </>
            ) : null}
            An agent’s page shows its key, limits and everything it did, so only owners, admins and admin keys
            can open it.
          </p>
          <Link className="btn btn-secondary" to="/agents">
            Back to agents
          </Link>
        </div>
      </>
    )
  if (q.isPending)
    return (
      <>
        {head}
        <div className="stack stack-8" aria-busy="true" style={{ marginBottom: 16 }}>
          <span className="sk sk-title" />
          <span className="sk sk-text" style={{ width: "40%" }} />
        </div>
        <div className="split-2">
          <section className="panel">
            <div className="panel-body">
              <PanelSkeleton rows={5} />
            </div>
          </section>
          <section className="panel">
            <div className="panel-body">
              <PanelSkeleton rows={4} />
            </div>
          </section>
        </div>
      </>
    )
  if (q.isError)
    return (
      <>
        {head}
        <section className="panel is-error" data-endpoint={`GET /v1/agents/${id}`}>
          <div className="panel-body">
            {q.error instanceof ApiError && q.error.status === 404 ? (
              <Empty
                icon="bot"
                title="No agent with this id"
                action={
                  <Link className="btn btn-secondary" to="/agents">
                    Back to agents
                  </Link>
                }
              >
                It may have been created in another workspace, or the link is mistyped.
              </Empty>
            ) : (
              <PanelError error={q.error} onRetry={() => q.refetch()} what="This agent didn’t load" />
            )}
          </div>
        </section>
      </>
    )

  const a = q.data
  const status = agentStatus(a)
  const active = status === "active"
  return (
    <>
      {head}
      <div
        className="spread"
        style={{ alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 12 }}
      >
        <div className="stack stack-4" style={{ minWidth: 0 }}>
          <h2 className="t-h2 agent-title sr-only">{a.name}</h2>
          <span className="muted cluster" style={{ gap: 6 }}>
            {a.mailbox.address ? (
              <span className="mono">{a.mailbox.address}</span>
            ) : (
              <span>No address of its own</span>
            )}
            {a.key ? (
              <>
                · key <span className="mono">{a.key.prefix}…</span>
              </>
            ) : null}
            · <AgentStatusPill status={status} />
          </span>
        </div>
        <div className="cluster">
          <Gated
            allowed={false}
            reason="Pausing isn’t in the API"
            who="Agents can’t be paused yet. Remove the agent to stop it now, or set its daily cap to 0."
            side="right"
          >
            <button className="btn btn-secondary" type="button">
              <Icon name="pause" />
              Pause agent
            </button>
          </Gated>
          {active && a.key ? (
            <button className="btn btn-secondary" type="button" onClick={() => setSheet("rotate")}>
              <Icon name="refresh" />
              Rotate key
            </button>
          ) : null}
          {status !== "removed" ? (
            <button className="btn btn-danger-ghost" type="button" onClick={() => setSheet("remove")}>
              <Icon name="trash" />
              Remove
            </button>
          ) : null}
        </div>
      </div>
      {status === "removed" ? (
        <div className="callout callout-info" style={{ marginBottom: 16 }}>
          <Icon name="info" />
          <span>
            <b>
              Removed <Time value={a.removedAt} />.
            </b>{" "}
            Its key no longer works and its held sends were rejected. Its mailbox and mail stay
            {a.mailbox.address ? (
              <>
                {" "}
                in <span className="mono">{a.mailbox.address}</span>
              </>
            ) : null}
            .
          </span>
        </div>
      ) : null}
      <div className="split-2">
        <div className="stack">
          <Activity agent={a} />
        </div>
        <div className="stack">
          <LimitsPanel agent={a} />
          <WakePanel agent={a} onCreate={() => setSheet("wake")} />
        </div>
      </div>
      {search.sheet === "rotate" && a.key ? (
        <RotateKeySheet keyId={a.key.id} name={a.name} onClose={() => setSheet()} />
      ) : null}
      {search.sheet === "remove" ? <RemoveSheet agent={a} onClose={() => setSheet()} /> : null}
      {search.sheet === "wake" ? <WakeSheet agent={a} onClose={() => setSheet()} /> : null}
    </>
  )
}

function Activity({ agent }: { agent: Agent }) {
  const keyId = agent.key?.id
  const q = useQuery({ ...keyAuditQuery(keyId ?? ""), enabled: Boolean(keyId) })
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/audit?actor=${keyId ?? "…"} · mcp.<read> rows (built, HAL-3461)`}
      aria-labelledby="h-activity"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-activity">
          Activity
        </h2>
        <div className="cluster">
          <BuiltPill issue="HAL-3461" />
          <Link className="panel-link" to="/settings/audit" search={keyId ? { actor: keyId } : {}}>
            Audit log
            <Icon name="chevron-right" />
          </Link>
        </div>
      </header>
      <div className="panel-body">
        {!keyId ? (
          <p className="muted">This agent has no key, so nothing it does is recorded.</p>
        ) : q.isPending ? (
          <PanelSkeleton rows={5} />
        ) : q.isError ? (
          <PanelError error={q.error} onRetry={() => q.refetch()} what="Activity didn’t load" />
        ) : q.data.entries.length === 0 ? (
          <Empty icon="history" title="No activity yet">
            When the agent searches, reads, drafts or sends with its key, each step shows here, newest first.
          </Empty>
        ) : (
          <ol className="ev-tl">
            {q.data.entries.map((e) => (
              <ActivityItem key={e.id} e={e} />
            ))}
          </ol>
        )}
        <p className="hint" style={{ marginTop: 10 }}>
          From the audit log, actor = this agent’s key. Its searches and reads are recorded as ids and
          queries, never the mail’s content; its drafts, sends and changes as they happened.
        </p>
      </div>
    </section>
  )
}

function ActivityItem({ e }: { e: AuditEntry }) {
  const kind = activityKind(e.action)
  const read = e.action.startsWith("mcp.")
  const refs = read ? readRefs(e.after) : {}
  const to = targetRoute(e.target)
  const lines = read ? [] : diffLines(e.before, e.after).slice(0, 2)
  return (
    <li className={`ev ${kind.tone}`}>
      <span className="ev-dot" />
      <span className="ev-title cluster" style={{ gap: 6 }}>
        <Icon name={kind.icon} />
        {kind.label || actionName(e.action)}
      </span>
      <span className="ev-time">
        <Time value={e.at} />
      </span>
      <div className="ev-body">
        {read ? (
          <span>
            {refs.query ? <span className="mono">“{refs.query}”</span> : null}
            {refs.query && refs.mailboxId ? " in " : null}
            {refs.mailboxId ? (
              <Link className="link" to="/mail/$mailboxId" params={{ mailboxId: refs.mailboxId }}>
                <span className="mono">{refs.mailboxId}</span>
              </Link>
            ) : !refs.query && e.action === "mcp.list_mailboxes" ? (
              <span className="muted">Every mailbox its key can read</span>
            ) : null}
            {refs.threadId ? (
              <span className="cell-sub" style={{ display: "block" }}>
                thread <span className="mono">{refs.threadId}</span>
              </span>
            ) : null}
            {refs.messageId ? (
              <span className="cell-sub" style={{ display: "block" }}>
                message <span className="mono">{refs.messageId}</span>
              </span>
            ) : null}
            {refs.attachmentId ? (
              <span className="cell-sub" style={{ display: "block" }}>
                attachment <span className="mono">{refs.attachmentId}</span>
              </span>
            ) : null}
          </span>
        ) : (
          <span>
            {e.target ? (
              to ? (
                <Link className="link" to={to as never}>
                  {e.target.label ?? e.target.id}
                </Link>
              ) : (
                <span className="mono">{e.target.label ?? e.target.id}</span>
              )
            ) : null}
            {lines.map((l) => (
              <span key={l.key} className="cell-sub" style={{ display: "block" }}>
                <span className="mono">{l.key}</span>: {l.from} → {l.to}
              </span>
            ))}
          </span>
        )}
        <span className="ev-meta">
          <span className="mono">{e.action}</span>
          {e.via ? ` · via ${e.via === "mcp" ? "MCP" : "the API"}` : ""}
        </span>
      </div>
    </li>
  )
}

function LimitsPanel({ agent }: { agent: Agent }) {
  const qc = useQueryClient()
  const current = toLimits(agent.limits)
  const [enabled, setEnabled] = useState(current !== null)
  const [limits, setLimits] = useState<Limits>(current ?? DEFAULT_LIMITS)
  const [name, setName] = useState(agent.name)
  const [tried, setTried] = useState(false)
  const status = agentStatus(agent)
  // A refetch after saving resets the form to what the server holds.
  useEffect(() => {
    const l = toLimits(agent.limits)
    setEnabled(l !== null)
    setLimits(l ?? DEFAULT_LIMITS)
    setName(agent.name)
  }, [agent.limits, agent.name])

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/agents/{id}", {
          params: { path: { id: agent.id } },
          body: {
            ...(name.trim() !== agent.name ? { name: name.trim() } : {}),
            limits: enabled ? limits : null,
          },
        }),
      ),
    onSuccess: async (a) => {
      qc.setQueryData(agentQuery(agent.id).queryKey, a)
      await qc.invalidateQueries({ queryKey: ["agents"] })
      toast({ title: "Saved", sub: describeLimits(toLimits(a.limits)) })
    },
  })
  const cap = current?.sendsPerDay ?? null
  const p = capPercent(agent.sentToday, cap)
  const held = num(agent.pendingApprovals) ?? 0
  const problems = enabled ? limitsProblems(limits) : {}
  const nameBad = !name.trim() || name.length > 80
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (Object.keys(problems).length || nameBad || save.isPending) return
    save.mutate()
  }
  return (
    <section
      className="panel"
      data-endpoint={`PATCH /v1/agents/${agent.id} { name, limits } (built, HAL-3460)`}
      aria-labelledby="h-limits"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-limits">
          Limits
        </h2>
        <div className="cluster">
          <BuiltPill issue="HAL-3460" />
        </div>
      </header>
      <div className="panel-body">
        <form className="stack stack-12 sb-limits" onSubmit={submit} noValidate>
          <div className="stat">
            <span className="stat-label">Sends today</span>
            <span className="stat-value">
              {fmtInt(agent.sentToday)}{" "}
              <span className="t-label muted" style={{ fontFamily: "var(--font-sans)" }}>
                {cap === null ? "no cap" : `of ${fmtInt(cap)}`}
              </span>
            </span>
          </div>
          {cap !== null ? (
            // biome-ignore lint/a11y/useSemanticElements: the design's meter bar (.meter > span), styled as a track
            <div
              className="meter"
              style={{ height: 8 }}
              role="meter"
              aria-valuemin={0}
              aria-valuemax={cap}
              aria-valuenow={num(agent.sentToday) ?? 0}
              aria-label="Sends today"
            >
              <span style={{ width: `${p ?? 0}%` }} />
            </div>
          ) : null}
          <span className="hint">
            Resets 00:00 UTC. Over the cap a send gets <span className="mono">409 agent_limit</span>.{" "}
            {held ? (
              <Link className="link" to="/agents/approvals">
                {fmtInt(held)} held for approval
              </Link>
            ) : (
              "Nothing held for approval."
            )}
          </span>
          <div className={`field${tried && nameBad ? " is-invalid" : ""}`}>
            <label className="label" htmlFor="l-name">
              Name
            </label>
            <input
              className="input"
              id="l-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={tried && nameBad ? true : undefined}
            />
            {tried && nameBad ? (
              <span className="field-error">Give the agent a name, up to 80 characters.</span>
            ) : null}
          </div>
          <label className="switch">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Limit what this agent can send
          </label>
          {enabled ? (
            <LimitsFields value={limits} onChange={setLimits} showErrors={tried} idPrefix="l" />
          ) : (
            <p className="hint">
              No limits: the agent is bounded by its scopes and its mailbox only. Saving removes them.
            </p>
          )}
          {save.isError ? <MutationError error={save.error} what="The limits weren’t saved" /> : null}
          <div>
            <Gated
              allowed={status !== "removed"}
              reason="This agent was removed"
              who="Its key no longer works, so its limits no longer apply."
            >
              <button className="btn btn-primary btn-sm" type="submit" aria-disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save limits"}
              </button>
            </Gated>
          </div>
        </form>
      </div>
    </section>
  )
}

function WakePanel({ agent, onCreate }: { agent: Agent; onCreate: () => void }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const removed = agentStatus(agent) === "removed"
  return (
    <section
      className="panel"
      data-endpoint="POST /v1/webhooks { url, preset: { kind: agent-wake, mailboxId } } · GET /v1/mailboxes/{id}/wait (built, HAL-3461) · filter.mailboxIds (built, HAL-3464)"
      aria-labelledby="h-wake"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-wake">
          Wake
        </h2>
        <div className="cluster">
          <BuiltPill issue="HAL-3461" />
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          <p className="muted" style={{ margin: 0 }}>
            How {agent.name} hears about new mail.
          </p>
          <div className="wake-opt">
            <div className="spread">
              <b>Webhook to the agent’s runtime</b>
              <BuiltPill issue="HAL-3461" />
            </div>
            <p className="t-small" style={{ margin: "4px 0 8px" }}>
              Mailyard posts a signed <span className="mono">mail.received</span> event to the agent’s runtime
              for mail to <span className="mono">{agent.mailbox.address ?? agent.mailbox.id}</span> only (the{" "}
              <span className="mono">agent-wake</span> preset filters by{" "}
              <span className="mono">filter.mailboxIds</span>
              ), and the runtime calls the agent.
            </p>
            <Gated
              allowed={!removed}
              reason="This agent was removed"
              who="Its key no longer works, so waking it would do nothing."
            >
              <button className="btn btn-secondary btn-sm" type="button" onClick={onCreate}>
                <Icon name="webhook" />
                Create wake webhook
              </button>
            </Gated>
          </div>
          <div className="wake-opt">
            <div className="spread">
              <b>Long-poll wait</b>
              <BuiltPill issue="HAL-3461" />
            </div>
            <p className="t-small" style={{ margin: "4px 0 8px" }}>
              For agents without a public URL. The request is held open until mail newer than{" "}
              <span className="mono">since</span> is filed (at once if some already is) and answers{" "}
              <span className="mono">200 {"{ cursor, messages, reset }"}</span>, or{" "}
              <span className="mono">204</span> at the timeout (at most 50 s) with the cursor in{" "}
              <span className="mono">x-mailyard-cursor</span>. Pass that cursor as{" "}
              <span className="mono">since</span> next time. Over MCP it’s the{" "}
              <span className="mono">wait_for_mail</span> tool.
            </p>
            <CodeBlock title="Wait for this agent’s mail" code={waitCurl(origin, agent.mailbox.id)} wrap />
          </div>
          {agent.key ? (
            <p className="t-small muted" style={{ margin: 0 }}>
              Its key has <ScopeTags scopes={agent.key.scopes} /> · created{" "}
              <Time value={agent.createdAt} mode="full" />
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}

type Wake = Body<"/v1/webhooks", "post">

function WakeSheet({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const qc = useQueryClient()
  const [url, setUrl] = useState("")
  const [tried, setTried] = useState(false)
  const [done, setDone] = useState<Wake | null>(null)
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/webhooks", {
          body: { url: url.trim(), preset: { kind: "agent-wake", mailboxId: agent.mailbox.id } },
        }),
      ),
    onSuccess: async (r) => {
      setDone(r)
      await qc.invalidateQueries({ queryKey: ["webhooks"] })
      toast({ title: "Wake webhook created", sub: "Copy its signing secret before you close the sheet." })
    },
  })
  const bad = !isHttpsUrl(url)
  if (done)
    return (
      <Sheet
        title="Wake webhook created"
        sub="Copy the signing secret before you close this."
        wide
        onClose={onClose}
        odId="wake-sheet"
        foot={
          <>
            <Link
              className="btn btn-secondary"
              to="/transactional/webhooks/$id"
              params={{ id: done.endpoint.id }}
            >
              Open the webhook
            </Link>
            <button className="btn btn-primary" type="button" onClick={onClose}>
              Done
            </button>
          </>
        }
      >
        <Secret
          value={done.secret}
          label="Signing secret"
          what="secret"
          note={
            <>
              <b>This is the only time you’ll see it.</b> The runtime verifies each delivery’s{" "}
              <span className="mono">webhook-signature</span> with it (Standard Webhooks).
            </>
          }
        />
        <dl className="kv">
          <dt>Endpoint</dt>
          <dd>
            <span className="mono">{done.endpoint.id}</span>
          </dd>
          <dt>URL</dt>
          <dd>
            <span className="mono">{done.endpoint.url}</span>
          </dd>
          <dt>Events</dt>
          <dd>
            <span className="mono">{done.endpoint.events.join(", ") || "—"}</span>
          </dd>
          <dt>Only for</dt>
          <dd>
            <span className="mono">{done.endpoint.filter?.mailboxIds?.join(", ") || agent.mailbox.id}</span>
          </dd>
        </dl>
      </Sheet>
    )
  return (
    <Sheet
      title={`Wake ${agent.name} on new mail`}
      sub="A webhook that fires for this agent’s mailbox only."
      onClose={onClose}
      odId="wake-sheet"
      endpoint={`POST /v1/webhooks { url, preset: { kind: agent-wake, mailboxId: ${agent.mailbox.id} } }`}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="wake-form" aria-disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create wake webhook"}
          </button>
        </>
      }
    >
      <form
        id="wake-form"
        className="stack stack-12"
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault()
          setTried(true)
          if (!bad && !create.isPending) create.mutate()
        }}
      >
        <div className={`field${tried && bad ? " is-invalid" : ""}`}>
          <label className="label" htmlFor="wake-url">
            The agent runtime’s URL
          </label>
          <input
            className="input mono"
            id="wake-url"
            type="url"
            inputMode="url"
            placeholder="https://agent.example.com/mailyard"
            value={url}
            data-autofocus=""
            aria-invalid={tried && bad ? true : undefined}
            aria-describedby="wake-url-hint"
            onChange={(e) => setUrl(e.target.value)}
          />
          <span className={tried && bad ? "field-error" : "hint"} id="wake-url-hint">
            {tried && bad
              ? "An https:// URL the runtime listens on."
              : "Gets a signed mail.received event for each message filed in this mailbox."}
          </span>
        </div>
        {create.isError ? <MutationError error={create.error} what="The webhook wasn’t created" /> : null}
      </form>
    </Sheet>
  )
}

function RemoveSheet({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const held = num(agent.pendingApprovals) ?? 0
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/agents/{id}", { params: { path: { id: agent.id } } })),
    onSuccess: async (a) => {
      qc.setQueryData(agentQuery(agent.id).queryKey, a)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["agents"] }),
        qc.invalidateQueries({ queryKey: ["api-keys"] }),
        qc.invalidateQueries({ queryKey: ["approvals"] }),
      ])
      toast({ title: `Removed ${agent.name}`, sub: "Its key stopped working; its mailbox and mail stay." })
      onClose()
      navigate({ to: "/settings/integrations" })
    },
  })
  return (
    <Sheet
      title={`Remove ${agent.name}?`}
      sub="The agent loses access at once."
      onClose={onClose}
      odId="agent-remove-sheet"
      endpoint={`DELETE /v1/agents/${agent.id}`}
    >
      <ul className="consequences">
        <li>
          <Icon name="x-circle" />
          <span>
            Its key {agent.key ? <span className="mono">{agent.key.prefix}…</span> : null} is revoked now: the
            agent’s next call to <span className="mono">/mcp</span> gets <span className="mono">401</span>.
          </span>
        </li>
        {held ? (
          <li>
            <Icon name="x-circle" />
            <span>
              {fmtInt(held)} held {held === 1 ? "send is" : "sends are"} rejected.
            </span>
          </li>
        ) : null}
        <li className="ok">
          <Icon name="check-circle" />
          <span>
            Its mailbox
            {agent.mailbox.address ? (
              <>
                {" "}
                <span className="mono">{agent.mailbox.address}</span>
              </>
            ) : null}{" "}
            and its mail stay, and the audit log keeps what it did.
          </span>
        </li>
      </ul>
      <TypedConfirm match={agent.name}>
        {(ok) => (
          <>
            {remove.isError ? <MutationError error={remove.error} what="The agent wasn’t removed" /> : null}
            <div className="cluster" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                type="button"
                aria-disabled={!ok || remove.isPending}
                onClick={() => ok && !remove.isPending && remove.mutate()}
              >
                {remove.isPending ? "Removing…" : "Remove agent"}
              </button>
            </div>
          </>
        )}
      </TypedConfirm>
    </Sheet>
  )
}

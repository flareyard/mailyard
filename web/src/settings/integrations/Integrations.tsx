/**
 * Settings → Integrations (design: settings/integrations*.html, HANDOFF-ops §19–21, §32–33), top to bottom:
 * linked apps, agent mailboxes (HAL-3460, live), the MCP server (HAL-3303), apps connected with OAuth
 * (HAL-3462, a proposal), keys for agents (HAL-3410), the tools table, alert channels (HAL-3465), starting
 * automations from mail (HAL-3467) and reshaping Mailyard with your own agent (in your repo).
 *
 * Planned panels say what they'll do and stay disabled with their issue; none of them shows invented rows.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { Gated } from "../../auth/NoPermission.tsx"
import { useMe } from "../../auth/session.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { CopyChip } from "../../ops/Copy.tsx"
import { BuiltPill, Empty, PlannedPill, Time } from "../../ops/kit.tsx"
import { isAdmin } from "../../ops/roles.ts"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { AgentNewSheet } from "./AgentNewSheet.tsx"
import { ConnectSheet } from "./ConnectSheet.tsx"
import { AgentStatusPill, PlannedTag, RepoPill, ScopeTags, SectionHead } from "./common.tsx"
import { RevokeKeySheet, RotateKeySheet } from "./KeySheets.tsx"
import { agentStatus, capPercent, localOf, MCP_PROTOCOLS, mcpUrl } from "./logic.ts"
import { agentsQuery, approvalsQuery, mcpKeysQuery, webhooksQuery } from "./queries.ts"
import { ToolsPanel } from "./ToolsPanel.tsx"
import "./integrations.css"

const route = getRouteApi("/_app/settings/integrations/")

const ADMIN_REASON = "You can’t manage agents"
const ADMIN_WHO =
  "Owners and admins (or a key with the admin scope) can create agents, rotate and revoke keys."

export function Integrations() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const me = useMe().data
  const admin = isAdmin(me)
  const close = () => navigate({ search: (s) => (s.fx ? { fx: s.fx } : {}), replace: true })
  const open = (next: { sheet?: "agent-new" | "connect"; rotate?: string; revoke?: string }) =>
    navigate({ search: (s) => ({ ...(s.fx ? { fx: s.fx } : {}), ...next }) })

  return (
    <>
      <SectionHead title="Integrations" sub="Agents and apps that work with this workspace." />
      <LinkedApps />
      <AgentMailboxes admin={admin} onNew={() => open({ sheet: "agent-new" })} />
      <McpServer admin={admin} onConnect={() => open({ sheet: "connect" })} />
      <OAuthApps />
      <AgentKeys
        admin={admin}
        onRotate={(id) => open({ rotate: id })}
        onRevoke={(id) => open({ revoke: id })}
      />
      <ToolsPanel />
      <AlertChannels />
      <MailTrigger />
      <Reshape />
      {search.sheet === "agent-new" && admin ? <AgentNewSheet onClose={close} /> : null}
      {search.sheet === "connect" && admin ? <ConnectSheet onClose={close} /> : null}
      {search.rotate && admin ? <RotateKeySheet keyId={search.rotate} onClose={close} /> : null}
      {search.revoke && admin ? <RevokeKeySheet keyId={search.revoke} onClose={close} /> : null}
    </>
  )
}

/** Linked apps (HAL-3466 planned): the two cards the built endpoints can fill, and the ones that need it. */
function LinkedApps() {
  const keys = useQuery(mcpKeysQuery)
  const hooks = useQuery(webhooksQuery)
  const live = (keys.data?.keys ?? []).filter((k) => !k.revokedAt || (num(k.revokedAt) ?? 0) > Date.now())
  const last = [...live].sort((a, b) => (num(b.lastUsedAt) ?? 0) - (num(a.lastUsedAt) ?? 0))[0]
  const endpoints = hooks.data?.webhooks ?? []
  const failing = endpoints.filter(
    (w) => (num(w.deadLetters) ?? 0) > 0 || (num(w.lastFailureAt) ?? 0) > (num(w.lastSuccessAt) ?? 0),
  ).length
  const off = endpoints.filter((w) => !w.enabled).length
  const origin = typeof window === "undefined" ? "" : window.location.origin
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/integrations (planned, HAL-3466) · GET /v1/api-keys?purpose=mcp · GET /v1/webhooks (built)"
      aria-labelledby="h-links"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-links">
          Linked apps
        </h2>
        <div className="cluster">
          <PlannedPill issue="HAL-3466" />
        </div>
      </header>
      <div className="panel-body">
        <p className="muted" style={{ margin: "0 0 12px" }}>
          What is linked to this workspace and whether it’s healthy. Read-only: each app is managed where it
          lives.
        </p>
        <div className="lk-grid">
          <article className="lk-card">
            <header>
              <span className="lk-icon">
                <Icon name="plug" />
              </span>
              <h3>MCP server</h3>
            </header>
            <p className="lk-state">
              <b>
                {keys.isPending
                  ? "Checking…"
                  : keys.isError
                    ? "Keys didn’t load"
                    : `${fmtInt(live.length)} ${live.length === 1 ? "key" : "keys"} in use`}
              </b>
            </p>
            <ul className="lk-lines">
              <li>
                {last?.lastUsedAt ? (
                  <>
                    Last call <Time value={last.lastUsedAt} />, by {last.name}
                  </>
                ) : (
                  "No agent has called it yet."
                )}
              </li>
              <li>
                <span className="mono">{mcpUrl(origin).replace(/^https?:\/\//, "")}</span>
              </li>
            </ul>
            <a className="panel-link" href="#h-mcp">
              Keys and tools
            </a>
          </article>
          <article className="lk-card">
            <header>
              <span className="lk-icon">
                <Icon name="webhook" />
              </span>
              <h3>Webhooks</h3>
            </header>
            <p className="lk-state">
              <b>
                {hooks.isPending
                  ? "Checking…"
                  : hooks.isError
                    ? "Endpoints didn’t load"
                    : endpoints.length === 0
                      ? "No endpoints"
                      : failing
                        ? `${failing} of ${endpoints.length} failing`
                        : `${endpoints.length} healthy`}
              </b>
            </p>
            <ul className="lk-lines">
              <li>
                {fmtInt(endpoints.length)} endpoints · {fmtInt(failing)} failing · {fmtInt(off)} disabled
              </li>
              <li>Health from each endpoint’s last delivery and its dead letters.</li>
            </ul>
            <Link className="panel-link" to="/transactional/webhooks">
              Manage webhooks
            </Link>
          </article>
          <article className="lk-card">
            <header>
              <span className="lk-icon">
                <Icon name="bot" />
              </span>
              <h3>Hermes</h3>
            </header>
            <p className="lk-state">
              <b>Unknown until the summary ships</b>
            </p>
            <ul className="lk-lines">
              <li>
                Whether Hermes is linked, its lane and mailboxes come from{" "}
                <span className="mono">GET /v1/integrations</span> <PlannedTag issue="HAL-3466" />.
              </li>
              <li>
                Hermes reads mail events from the mail-events queue, and can run as an agent mailbox below.
              </li>
            </ul>
            <a className="panel-link" href="https://flareyard.dev/apps">
              About Hermes
            </a>
          </article>
          <article className="lk-card">
            <header>
              <span className="lk-icon">
                <Icon name="inbound" />
              </span>
              <h3>Support Inbox</h3>
            </header>
            <p className="lk-state">
              <b>Not linked</b>
            </p>
            <ul className="lk-lines">
              <li>
                A Flareyard app for assignments, SLAs and canned replies. It links over MCP with its own key,
                which shows up under Keys for agents.
              </li>
            </ul>
            <a className="panel-link" href="https://flareyard.dev/apps">
              Install from Flareyard
            </a>
          </article>
        </div>
      </div>
      <footer className="panel-foot">
        <span>
          Until <span className="mono">GET /v1/integrations</span> ships, these cards are built from{" "}
          <span className="mono">GET /v1/api-keys?purpose=mcp</span> and{" "}
          <span className="mono">GET /v1/webhooks</span> (both built); the Hermes card needs the summary.
        </span>
      </footer>
    </section>
  )
}

function AgentMailboxes({ admin, onNew }: { admin: boolean; onNew: () => void }) {
  const q = useQuery(agentsQuery)
  const pending = useQuery({ ...approvalsQuery("pending"), enabled: admin })
  const waiting = pending.data?.approvals.length ?? 0
  const newButton = (
    <Gated allowed={admin} reason={ADMIN_REASON} who={ADMIN_WHO} side="right">
      <button
        className="btn btn-primary btn-sm"
        type="button"
        onClick={onNew}
        data-endpoint="POST /v1/agents"
      >
        New agent mailbox
      </button>
    </Gated>
  )
  return (
    <Panel
      id="agent-mailboxes"
      title="Agent mailboxes"
      endpoint="GET /v1/agents · GET /v1/approvals (built, HAL-3460)"
      query={q}
      meta={
        <span className="cluster">
          <BuiltPill issue="HAL-3460" />
        </span>
      }
      isEmpty={(d) => d.agents.length === 0}
      empty={
        <Empty icon="bot" title="No agent mailboxes yet" action={newButton}>
          Create one to give an agent its own address on your domain, with only the scopes and limits it
          needs.
        </Empty>
      }
    >
      {(d) => (
        <>
          <div className="spread" style={{ margin: "0 0 12px", gap: 12, flexWrap: "wrap" }}>
            <p className="muted" style={{ margin: 0, flex: "1 1 280px" }}>
              Give an agent its own address on your domain. It reads and replies through MCP with its own key,
              inside the limits you set, and a person can read along in Mail.
            </p>
            <span className="cluster">
              {newButton}
              <Link className="panel-link" to="/settings/integrations/approvals">
                Approval queue
                {waiting ? <span className="nav-count">{waiting}</span> : null}
              </Link>
            </span>
          </div>
          <div className="table-wrap rtable-wrap">
            <table className="rtable">
              <thead>
                <tr>
                  <th>Agent, address and scopes</th>
                  <th>Its mailbox</th>
                  <th>Sends today and held</th>
                  <th>Last activity</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.agents.map((a) => {
                  const status = agentStatus(a)
                  const cap = a.limits?.sendsPerDay ?? null
                  const p = capPercent(a.sentToday, cap)
                  const held = num(a.pendingApprovals) ?? 0
                  return (
                    <tr key={a.id} className={status === "active" ? "" : "is-muted"}>
                      <td className="is-head">
                        <div className="cell-main">
                          <span className="agent-name">
                            <Link to="/settings/integrations/agents/$id" params={{ id: a.id }}>
                              {a.name}
                            </Link>
                          </span>
                          <span className="cell-sub">
                            {a.mailbox.address ? (
                              <span className="mono">{a.mailbox.address}</span>
                            ) : (
                              <span className="muted">No address of its own</span>
                            )}
                          </span>
                          {a.key ? (
                            <span style={{ marginTop: 4 }}>
                              <ScopeTags scopes={a.key.scopes} />
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td data-label="Mailbox">
                        {a.mailbox.address ? (
                          <span className="cell-sub" style={{ display: "block" }} title={a.mailbox.address}>
                            <span className="mono">{localOf(a.mailbox.address)}</span> · owner
                          </span>
                        ) : (
                          <span className="muted">None</span>
                        )}
                      </td>
                      <td data-label="Sends today">
                        {status !== "active" ? (
                          <span className="muted">—</span>
                        ) : cap === null ? (
                          <>
                            <span className="num">{fmtInt(a.sentToday)}</span>{" "}
                            <span className="muted">no cap set</span>
                          </>
                        ) : (
                          <>
                            <span className="num">
                              <b>{fmtInt(a.sentToday)}</b> of {fmtInt(cap)}
                            </span>
                            <span
                              className="cap-bar"
                              role="img"
                              aria-label={`${fmtInt(a.sentToday)} of ${fmtInt(cap)} sends today`}
                            >
                              <span style={{ width: `${p ?? 0}%` }} />
                            </span>
                          </>
                        )}
                        <span className="cell-sub" style={{ display: "block", marginTop: 4 }}>
                          {held ? (
                            <Link className="link" to="/settings/integrations/approvals">
                              <b>{fmtInt(held)}</b> held
                            </Link>
                          ) : (
                            <span className="muted">0</span>
                          )}{" "}
                          awaiting approval
                        </span>
                      </td>
                      <td data-label="Last activity">
                        {a.key?.lastUsedAt ? (
                          <Time value={a.key.lastUsedAt} />
                        ) : (
                          <span className="muted">Never</span>
                        )}
                      </td>
                      <td className="is-aside">
                        <AgentStatusPill status={status} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            Each agent is a mailbox and a <span className="mono">purpose: mcp</span> key that owns it.
            Removing an agent revokes its key at once and rejects its held sends; its mailbox and mail stay.
          </p>
        </>
      )}
    </Panel>
  )
}

function McpServer({ admin, onConnect }: { admin: boolean; onConnect: () => void }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const url = mcpUrl(origin)
  return (
    <section className="panel" data-endpoint="POST /mcp (built, HAL-3303)" aria-labelledby="h-mcp">
      <header className="panel-head">
        <h2 className="panel-title" id="h-mcp">
          MCP server
        </h2>
        <div className="cluster">
          <BuiltPill issue="HAL-3303" />
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          <p className="muted">
            Agents such as Claude Code use Mailyard through the Model Context Protocol: they read and search
            mail, draft and send replies, look up contacts and check campaigns, with the same checks as the
            API.
          </p>
          <dl className="kv">
            <dt>Endpoint</dt>
            <dd>
              <span className="ns">
                <code>{url}</code>
                <CopyChip value={url} what="the MCP endpoint" />
              </span>
            </dd>
            <dt>Transport</dt>
            <dd>
              Streamable HTTP, stateless: one <span className="mono">POST</span> per request, no sessions and
              no server stream (<span className="mono">GET</span> and <span className="mono">DELETE</span>{" "}
              answer 405).
            </dd>
            <dt>Protocol versions</dt>
            <dd>
              <span className="scope-tags">
                {MCP_PROTOCOLS.map((v, i) => (
                  <span key={v} className="cluster" style={{ gap: 4 }}>
                    <span className="tag mono">{v}</span>
                    {i === 0 ? <span className="t-small muted">latest</span> : null}
                  </span>
                ))}
              </span>
            </dd>
            <dt>Signs in with</dt>
            <dd>
              A Mailyard API key, as <span className="mono">Authorization: Bearer sk_…</span>. There are no
              separate MCP tokens: connecting an agent creates a key with{" "}
              <span className="mono">purpose: mcp</span>, and its scopes and mailboxes decide what the agent
              can do. The purpose is only a label: an <span className="mono">api</span> key with the right
              scopes works here too.
            </dd>
            <dt>Or, with OAuth</dt>
            <dd>
              <PlannedPill issue="HAL-3462" label="Proposal" /> An MCP client such as Claude or ChatGPT would
              find Mailyard’s sign-in through the two <span className="mono">.well-known</span> documents,
              register itself, and send you to a consent page. Today every agent uses an API key.
            </dd>
            <dt>Public keys</dt>
            <dd>
              Refused. A <span className="mono">pk_</span> key gets <b>403</b> “Public keys can’t use the MCP
              server.” (<span className="mono">reason: public-key</span>), so agents always get a secret key.
            </dd>
          </dl>
          <div className="cluster">
            <Gated allowed={admin} reason={ADMIN_REASON} who={ADMIN_WHO}>
              <button
                className="btn btn-primary"
                type="button"
                onClick={onConnect}
                data-endpoint="POST /v1/api-keys { name, kind: secret, scopes, purpose: mcp } · PUT /v1/mailboxes/{id}/members"
              >
                Connect an agent
              </button>
            </Gated>
            <span className="t-small muted">A key for an agent that uses mailboxes you already have.</span>
          </div>
        </div>
      </div>
    </section>
  )
}

/** OAuth for MCP is a founder proposal (HAL-3462): explained, never shown with rows that don't exist. */
function OAuthApps() {
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/oauth/grants · DELETE /v1/oauth/grants/{id} (proposed, HAL-3462)"
      aria-labelledby="h-oauth"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-oauth">
          Apps connected with OAuth
        </h2>
        <div className="cluster">
          <PlannedPill issue="HAL-3462" label="Proposal" />
        </div>
      </header>
      <div className="panel-body">
        <div className="callout callout-info" style={{ marginBottom: 12 }}>
          <Icon name="info" />
          <span>
            <b>A proposal for the founder.</b> OAuth adds a new way to sign in, so it is designed first and
            built only once it is approved. Until then no app can connect this way, so there is nothing to
            list or revoke.
          </span>
        </div>
        <Empty icon="shield" title="No apps connected with OAuth">
          When an MCP client asks to use Mailyard, you’ll approve it on a consent page and it shows here, with
          what it can do and a Revoke button.
        </Empty>
      </div>
      <footer className="panel-foot">
        <span>
          Revoking will end the app’s tokens at once; its next call to <span className="mono">/mcp</span> gets{" "}
          <span className="mono">401</span>. What it drafted or sent stays.
        </span>
      </footer>
    </section>
  )
}

function AgentKeys({
  admin,
  onRotate,
  onRevoke,
}: {
  admin: boolean
  onRotate: (id: string) => void
  onRevoke: (id: string) => void
}) {
  const q = useQuery(mcpKeysQuery)
  return (
    <Panel
      id="agent-keys"
      title="Keys for agents"
      endpoint="GET /v1/api-keys?purpose=mcp (built, HAL-3410) · POST /v1/api-keys/{id}/rotate · DELETE /v1/api-keys/{id}"
      query={q}
      meta={<BuiltPill issue="HAL-3410" />}
      isEmpty={(d) => d.keys.length === 0}
      empty={
        <Empty icon="key" title="No agents connected yet">
          Connect an agent to create a secret key just for it, with only the scopes and mailboxes it needs.
          The key is shown once, with the line to paste into Claude Code.
        </Empty>
      }
    >
      {(d) => (
        <>
          <p className="purpose-note">
            <Icon name="info" />
            <span>
              <b>Purpose is a label.</b> Scopes and mailboxes decide what an agent can do; an{" "}
              <span className="mono">api</span> key with the right scopes also works over MCP.
            </span>
          </p>
          <div className="table-wrap rtable-wrap">
            <table className="rtable">
              <thead>
                <tr>
                  <th>Agent and key</th>
                  <th>Scopes</th>
                  <th>Last used</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.keys.map((k) => {
                  const revokedAt = num(k.revokedAt)
                  const rotating = revokedAt !== null && revokedAt > Date.now()
                  const revoked = revokedAt !== null && !rotating
                  return (
                    <tr key={k.id} className={revoked ? "is-muted" : rotating ? "is-selected" : ""}>
                      <td className="is-head">
                        <div className="cell-main">
                          <span style={{ fontWeight: 600, color: "var(--my-fg)" }}>{k.name}</span>
                          <span className="cell-sub">
                            <span className="mono">{k.prefix}…</span> · created{" "}
                            <Time value={k.createdAt} mode="full" />
                          </span>
                          {rotating ? (
                            <span className="cell-sub" style={{ color: "var(--amber-900)" }}>
                              Rotating: the old key works until <Time value={revokedAt} mode="full" />
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td data-label="Scopes">
                        <ScopeTags scopes={k.scopes} />
                      </td>
                      <td data-label="Last used">
                        {k.lastUsedAt ? <Time value={k.lastUsedAt} /> : <span className="muted">Never</span>}
                      </td>
                      <td className="actions">
                        {revoked ? (
                          <span className="pill pill-neutral">
                            <span className="dot" />
                            Revoked
                          </span>
                        ) : (
                          <>
                            {rotating ? null : (
                              <Gated allowed={admin} reason={ADMIN_REASON} who={ADMIN_WHO} side="right">
                                <button
                                  className="btn btn-ghost btn-sm"
                                  type="button"
                                  onClick={() => onRotate(k.id)}
                                >
                                  Rotate
                                </button>
                              </Gated>
                            )}
                            <Gated allowed={admin} reason={ADMIN_REASON} who={ADMIN_WHO} side="right">
                              <button
                                className="btn btn-danger-ghost btn-sm"
                                type="button"
                                onClick={() => onRevoke(k.id)}
                              >
                                {rotating ? "Stop the old key now" : "Revoke"}
                              </button>
                            </Gated>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  )
}

function AlertChannels() {
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/settings/alerts · PUT /v1/settings/alerts { channels } · alert.raised event (planned, HAL-3465)"
      aria-labelledby="h-alert-channels"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-alert-channels">
          Alert channels
        </h2>
        <div className="cluster">
          <PlannedPill issue="HAL-3465" />
          <Gated
            allowed={false}
            reason="Alert channels aren’t built yet"
            who="Planned · HAL-3465. Until then alerts show in the bell only."
            side="right"
          >
            <button className="btn btn-secondary btn-sm" type="button">
              Add a channel
            </button>
          </Gated>
        </div>
      </header>
      <div className="panel-body">
        <Empty icon="bell" title="Alerts show only in the app">
          Email addresses and webhooks that hear about alerts when nobody has Mailyard open: each alert sent
          once, and again if it gets worse.
        </Empty>
      </div>
      <footer className="panel-foot">
        <span>
          Webhook endpoints will also be able to subscribe to <span className="mono">alert.raised</span>{" "}
          <PlannedTag issue="HAL-3465" />, with the alert’s kind, severity and title.
        </span>
      </footer>
    </section>
  )
}

function MailTrigger() {
  return (
    <section
      className="panel"
      data-endpoint="automation trigger { type: mail_received, mailboxIds?, senderDomains?, subjectContains? } (planned, HAL-3467)"
      aria-labelledby="h-mail-trigger"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-mail-trigger">
          Start automations from mail
        </h2>
        <div className="cluster">
          <PlannedPill issue="HAL-3467" />
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          <p className="muted" style={{ margin: 0 }}>
            Start an automation from a person’s email: tag the sender, add them to a list, or send a
            follow-up. The trigger will live in the automation canvas, under Audience.
          </p>
          <div className="trigger-card">
            <span className="tc-icon">
              <Icon name="inbound" />
            </span>
            <div className="stack stack-4">
              <b>When mail arrives</b>
              <span className="t-small">
                in a mailbox · from some sender domains · subject contains a phrase
              </span>
              <span className="hint">Automated mail (auto-replies, bounces, lists) never starts it.</span>
            </div>
          </div>
          <div className="cluster">
            <Link className="btn btn-secondary btn-sm" to="/automations">
              Open automations
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}

const SKILLS = [
  {
    name: "add-template",
    desc: "Add an email template to Mailyard's template library (src/templates/library), so it ships with the repo, is proven by `bun run check`, and installs into a running Mailyard. Use when asked for a new email (birthday, receipt, reminder, digest) or to change a shipped one.",
    prompt: "Add a birthday email template",
  },
  {
    name: "add-automation-step",
    desc: 'Add a new step type to Mailyard\'s automations (a node in the graph, like send, wait, branch or webhook), for example "notify Slack", "add a tag" or "call an API". Use when an automation needs to do something no existing step does.',
    prompt: "Add an automation step that posts to a Slack channel",
  },
  {
    name: "add-inbox-rule-action",
    desc: 'Add a new action to Mailyard\'s inbox rules (what a matching rule does to incoming mail, beside label, archive, forward, auto-reply, webhook and assign), for example "set priority", "snooze" or "notify". Use when a mailbox rule needs to do something the existing actions can\'t.',
    prompt: "Add a rule action that sets a priority on incoming mail",
  },
  {
    name: "add-webhook-event",
    desc: "Add a new outgoing webhook event type to Mailyard (like contact.created or mail.received), so endpoints can subscribe to it and receive signed deliveries. Use when something that happens in Mailyard should notify the user's own systems.",
    prompt: "Send a webhook when a campaign is resumed",
  },
  {
    name: "deploy",
    desc: "Deploy a change to a running Mailyard on Cloudflare, by hand with Wrangler or as a Flareyard release: migrations first, then the Worker, then a live check. Use when shipping a merged change, adding a migration, queue, secret or Durable Object, or building flareyard-release.json.",
    prompt: "Deploy main to my Mailyard",
  },
]

function Reshape() {
  const snippet = 'cd mailyard\nclaude "Add a birthday email template"'
  return (
    <section
      className="panel"
      data-endpoint="none: repo content (skills/, linked into .claude/skills; HAL-3304)"
      aria-labelledby="h-reshape"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-reshape">
          Reshape with your agent
        </h2>
        <div className="cluster">
          <RepoPill />
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          <p className="muted">
            Mailyard is yours to change. Its repo ships five skills, instructions your coding agent follows to
            change Mailyard’s own code. They live in <span className="mono">skills/</span> and are linked into{" "}
            <span className="mono">.claude/skills</span>, so Claude Code picks them up when you open the repo.
            Nothing on this screen runs them: you ask your agent, in your repo.
          </p>
          <ul className="skill-list" aria-label="Skills in the repo">
            {SKILLS.map((s) => (
              <li key={s.name}>
                <span className="sk-name">
                  {s.name}
                  <span className="sk-path">skills/{s.name}/SKILL.md</span>
                </span>
                <p className="sk-desc">{s.desc}</p>
                <p className="sk-prompt">“{s.prompt}”</p>
              </li>
            ))}
          </ul>
          <div className="code">
            <div className="code-head">
              <span className="code-title">In your Mailyard repo</span>
              <CopyChip value={snippet} />
            </div>
            <pre>
              <code>
                cd mailyard
                {"\n"}claude <span className="s">"Add a birthday email template"</span>
              </code>
            </pre>
          </div>
          <div className="proof">
            <div>
              <b>
                Proven by <span className="mono">bun run check</span>
              </b>
              <span>
                Typecheck, lint, the manifest and the tests, on every change the agent makes. The library
                templates are rendered by a test, so a broken one fails here.
              </span>
            </div>
            <div>
              <b>
                Shipped by the <span className="mono">deploy</span> skill
              </b>
              <span>
                Migrations first, then the Worker, then a live check, by hand with Wrangler or as a Flareyard
                release. Until it’s deployed, this workspace doesn’t change.
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * Linked apps (design: settings/integrations.html `#h-links`; HAL-3466, live): `GET /v1/integrations`, a
 * read-only summary of what is linked to this workspace and whether it's healthy. The MCP server with its keys
 * (only to callers with `keys.manage`; otherwise `keys: null` and the counts alone), webhooks with the failing
 * endpoints, Hermes, and one card per sibling Flareyard app. Nothing here writes: every action is a link to
 * where the thing is managed; the Hermes lane itself is set in the panel below (HAL-3306).
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { api, unwrap } from "../../api/client.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { CopyChip } from "../../ops/Copy.tsx"
import { BuiltPill, Time } from "../../ops/kit.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { ScopeTags } from "./common.tsx"
import { localOf } from "./logic.ts"
import type { Body } from "./queries.ts"

export type Integrations = Body<"/v1/integrations">

export const integrationsQuery = {
  queryKey: ["integrations"],
  queryFn: () => unwrap(api.GET("/v1/integrations")),
}

export function LinkedApps() {
  const q = useQuery(integrationsQuery)
  return (
    <Panel
      id="links"
      title="Linked apps"
      endpoint="GET /v1/integrations (built, HAL-3466)"
      query={q}
      meta={<BuiltPill issue="HAL-3466" />}
    >
      {(d) => (
        <>
          <p className="muted" style={{ margin: "0 0 12px" }}>
            What is linked to this workspace and whether it’s healthy. Read-only: each app is managed where it
            lives.
          </p>
          <div className="lk-grid">
            <McpCard mcp={d.mcp} />
            <WebhooksCard w={d.webhooks} />
            <HermesCard h={d.hermes} />
            {d.siblings.map((s) => (
              <SiblingCard key={s.app} s={s} />
            ))}
          </div>
          {d.mcp.keys ? <McpKeys keys={d.mcp.keys} /> : null}
        </>
      )}
    </Panel>
  )
}

function McpCard({ mcp }: { mcp: Integrations["mcp"] }) {
  return (
    <article className="lk-card">
      <header>
        <span className="lk-icon">
          <Icon name="plug" />
        </span>
        <h3>MCP server</h3>
      </header>
      <p className="lk-state">
        <b>
          {fmtInt(mcp.keyCount)} {num(mcp.keyCount) === 1 ? "key" : "keys"} · {fmtInt(mcp.agentCount)}{" "}
          {num(mcp.agentCount) === 1 ? "agent" : "agents"}
        </b>
      </p>
      <ul className="lk-lines">
        <li>
          {mcp.lastUsedAt ? (
            <>
              Last call <Time value={mcp.lastUsedAt} />
            </>
          ) : (
            "No agent has called it yet."
          )}
        </li>
        {mcp.endpoint ? (
          <li className="cluster" style={{ gap: 4 }}>
            <span className="mono">{mcp.endpoint.replace(/^https?:\/\//, "")}</span>
            <CopyChip value={mcp.endpoint} what="the MCP endpoint" />
          </li>
        ) : (
          <li className="muted">No public origin is set, so there’s no endpoint to show.</li>
        )}
        {mcp.keys === null ? (
          <li className="muted">
            Key names show to people who can manage keys (keys.manage); you see the counts.
          </li>
        ) : null}
      </ul>
      <span className="cluster" style={{ gap: 12 }}>
        <Link className="panel-link" to="/transactional/keys" search={{ purpose: "mcp" }}>
          API keys
        </Link>
        <a className="panel-link" href="#h-agent-mailboxes">
          Agents
        </a>
      </span>
    </article>
  )
}

function WebhooksCard({ w }: { w: Integrations["webhooks"] }) {
  const failing = num(w.failing) ?? 0
  return (
    <article className="lk-card">
      <header>
        <span className="lk-icon">
          <Icon name="webhook" />
        </span>
        <h3>Webhooks</h3>
      </header>
      <p className="lk-state">
        <b>
          {num(w.count) === 0
            ? "No endpoints"
            : failing
              ? `${fmtInt(failing)} of ${fmtInt(w.count)} failing`
              : `${fmtInt(w.count)} healthy`}
        </b>
      </p>
      <ul className="lk-lines">
        <li>
          {fmtInt(w.enabled)} enabled · {fmtInt(w.paused)} paused · {fmtInt(w.deadLetters)} dead letters
          {num(w.held) ? ` · ${fmtInt(w.held)} held` : ""}
        </li>
        {w.failingEndpoints.map((e) => (
          <li key={e.id}>
            <Link className="link mono" to="/transactional/webhooks/$id" params={{ id: e.id }}>
              {e.url.replace(/^https?:\/\//, "")}
            </Link>
            {num(e.deadLetters) ? (
              <>
                {" · "}
                <Link
                  className="link"
                  to="/transactional/webhooks/$id"
                  params={{ id: e.id }}
                  search={{ status: "dead" }}
                >
                  {fmtInt(e.deadLetters)} dead
                </Link>
              </>
            ) : null}
            {e.lastFailureAt ? (
              <span className="cell-sub" style={{ display: "block" }}>
                failed <Time value={e.lastFailureAt} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <Link className="panel-link" to="/transactional/webhooks">
        Webhooks
      </Link>
    </article>
  )
}

function HermesCard({ h }: { h: Integrations["hermes"] }) {
  return (
    <article className="lk-card">
      <header>
        <span className="lk-icon">
          <Icon name="bot" />
        </span>
        <h3>Hermes</h3>
      </header>
      <p className="lk-state">
        <b>{h.connected ? `Linked${h.lane ? ` · ${h.lane} lane` : ""}` : "Not linked"}</b>
      </p>
      <ul className="lk-lines">
        {h.connected ? (
          <>
            <li>
              Mailboxes:{" "}
              {h.allMailboxes
                ? "All mailboxes"
                : h.mailboxes.map((m, i) => (
                    <span key={m}>
                      {i ? ", " : ""}
                      <span className="mono">{localOf(m)}</span>
                    </span>
                  ))}
            </li>
            {h.since ? (
              <li>
                Since <Time value={h.since} mode="full" />
              </li>
            ) : null}
          </>
        ) : (
          <li>Hermes reads mail events from the mail-events queue once its lane is on.</li>
        )}
        {h.available ? null : (
          <li className="muted">
            The mail-events queue isn’t bound in this deploy, so the lane can’t go on yet.
          </li>
        )}
      </ul>
      <a className="panel-link" href="#h-mail-events">
        {h.connected ? "Lane settings" : "Turn the lane on"}
      </a>
    </article>
  )
}

const VIA: Record<"mcp" | "queue", string> = {
  mcp: "over MCP, with its own key",
  queue: "through the mail-events queue",
}

function SiblingCard({ s }: { s: Integrations["siblings"][number] }) {
  return (
    <article className="lk-card">
      <header>
        <span className="lk-icon">
          <Icon name={s.via === "mcp" ? "plug" : "inbound"} />
        </span>
        <h3>{s.name}</h3>
      </header>
      <p className="lk-state">
        <b>{s.connected ? "Linked" : "Not linked"}</b>
      </p>
      <ul className="lk-lines">
        <li>Links {VIA[s.via]}.</li>
        {s.connected ? (
          <li>
            {s.lastUsedAt ? (
              <>
                Last seen <Time value={s.lastUsedAt} />
              </>
            ) : (
              "Not seen yet."
            )}
          </li>
        ) : null}
        {s.connected && s.via === "mcp" && !s.keyId ? (
          <li className="muted">Its key shows to people who can manage keys.</li>
        ) : null}
      </ul>
      {s.keyId ? (
        <Link className="panel-link" to="/transactional/keys" search={{ purpose: "mcp" }}>
          Its key
        </Link>
      ) : (
        <a className="panel-link" href="https://flareyard.dev/apps">
          {s.connected ? "About it" : "Install from Flareyard"}
        </a>
      )}
    </article>
  )
}

function McpKeys({ keys }: { keys: NonNullable<Integrations["mcp"]["keys"]> }) {
  if (!keys.length) return null
  return (
    <div className="table-wrap rtable-wrap" style={{ marginTop: 16 }}>
      <table className="rtable" aria-label="Keys on the MCP server">
        <thead>
          <tr>
            <th>Key</th>
            <th>Scopes</th>
            <th>Agent</th>
            <th>Last used</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td className="is-head">
                <div className="cell-main">
                  <span style={{ fontWeight: 600, color: "var(--my-fg)" }}>{k.name}</span>
                  <span className="cell-sub mono">{k.prefix}…</span>
                </div>
              </td>
              <td data-label="Scopes">
                <ScopeTags scopes={k.scopes} />
              </td>
              <td data-label="Agent">
                {k.agent ? (
                  <Link className="link" to="/settings/integrations/agents/$id" params={{ id: k.agent.id }}>
                    {k.agent.name}
                  </Link>
                ) : (
                  <span className="muted">No agent</span>
                )}
                {k.agent?.address ? (
                  <span className="cell-sub mono" style={{ display: "block" }}>
                    {k.agent.address}
                  </span>
                ) : null}
              </td>
              <td data-label="Last used">
                {k.lastUsedAt ? <Time value={k.lastUsedAt} /> : <span className="muted">Never</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

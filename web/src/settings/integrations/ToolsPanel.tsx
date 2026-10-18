/** Tools: built and planned (design: settings/integrations.html `#h-mcp-tools`), the MCP contract table. */
import { Fragment } from "react"
import { BuiltPill, PlannedPill } from "../../ops/kit.tsx"
import { PlannedTag } from "./common.tsx"
import { PLANNED_TOOLS, type PlannedTool, TOOLS, type Tool } from "./logic.ts"

export function Effect({ effect }: { effect: Tool["effect"] | PlannedTool["effect"] }) {
  if (effect === "sends")
    return (
      <span className="pill pill-fail">
        <span className="dot" />
        Sends to real people
      </span>
    )
  if (effect === "draft")
    return (
      <span className="pill pill-info">
        <span className="dot" />
        Writes a draft · never sends
      </span>
    )
  if (effect === "writes")
    return (
      <span className="pill pill-info">
        <span className="dot" />
        Writes data
      </span>
    )
  return (
    <span className="pill pill-neutral">
      <span className="dot" />
      {effect === "event" ? "Writes an event" : "Read-only"}
    </span>
  )
}

const GROUPS = ["read", "send", "track"] as const

export function ToolsPanel() {
  return (
    <section
      className="panel"
      data-endpoint="POST /mcp → tools/list (built, HAL-3303, HAL-3459, HAL-3461) · more tools (planned, HAL-3463)"
      aria-labelledby="h-mcp-tools"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-mcp-tools">
          Tools: built and planned
        </h2>
      </header>
      <div className="panel-body">
        <div className="spread" style={{ margin: "0 0 8px" }}>
          <h3 className="t-h4">Built</h3>
          <span className="cluster">
            <BuiltPill issue="HAL-3303" />
            <BuiltPill issue="HAL-3459" />
            <BuiltPill issue="HAL-3461" />
          </span>
        </div>
        <div className="table-wrap rtable-wrap">
          <table className="rtable">
            <thead>
              <tr>
                <th>Tool</th>
                <th>What it does</th>
                <th>Effect</th>
              </tr>
            </thead>
            <tbody>
              {GROUPS.map((g) => {
                const tools = TOOLS.filter((t) => t.scope === g)
                return (
                  <Fragment key={g}>
                    <tr className="rt-group">
                      <th colSpan={3} scope="colgroup">
                        <span className="tag">{g}</span>{" "}
                        <span className="t-small muted">
                          unlocks {tools.length} {tools.length === 1 ? "tool" : "tools"}
                        </span>
                      </th>
                    </tr>
                    {tools.map((t) => (
                      <tr key={t.name}>
                        <td className="is-head">
                          <code className="mono">{t.name}</code>
                          {t.issue ? (
                            <span className="cell-sub" style={{ display: "block" }}>
                              {t.issue}
                            </span>
                          ) : null}
                        </td>
                        <td data-label="What it does">{t.what}</td>
                        <td data-label="Effect">
                          <div className="tool-effect">
                            <Effect effect={t.effect} />
                            {t.effect === "sends" ? (
                              <span className="cell-sub">
                                Reaches the outside world: the agent must pass{" "}
                                <span className="mono">confirm: true</span>
                                {t.name === "send_draft" ? ", then it waits the undo window." : "."}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="tools-split">
          <div className="spread" style={{ margin: "20px 0 8px", flexWrap: "wrap", gap: 8 }}>
            <h3 className="t-h4">Planned</h3>
            <span className="cluster">
              <PlannedPill issue="HAL-3463" />
            </span>
          </div>
          <div className="table-wrap rtable-wrap">
            <table className="rtable">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>What it does</th>
                  <th>Scope</th>
                  <th>Effect</th>
                  <th>Issue</th>
                </tr>
              </thead>
              <tbody>
                {PLANNED_TOOLS.map((t) => (
                  <tr key={t.name} className="is-planned">
                    <td className="is-head">
                      {t.name.includes(" · ") ? (
                        <span className="scope-tags">
                          {t.name.split(" · ").map((n) => (
                            <code key={n} className="mono">
                              {n}
                            </code>
                          ))}
                        </span>
                      ) : (
                        <code className="mono">{t.name}</code>
                      )}
                    </td>
                    <td data-label="What it does">{t.what}</td>
                    <td data-label="Scope">
                      <span className="tag">{t.scope}</span>
                    </td>
                    <td data-label="Effect">
                      <Effect effect={t.effect} />
                    </td>
                    <td className="is-aside">
                      <PlannedTag issue={t.issue} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            The campaign tools follow the send tools’ rule: without{" "}
            <span className="mono">confirm: true</span> they say what would happen and change nothing.
          </p>
        </div>
      </div>
      <footer className="panel-foot">
        <span>
          An agent sees only the tools its key’s scopes allow (<span className="mono">tools/list</span>);{" "}
          <span className="mono">admin</span> unlocks all {TOOLS.length}. Mail tools also need the key to be a
          member of the mailbox. A refusal (no membership, no <span className="mono">confirm</span>) comes
          back as a tool result with <span className="mono">isError</span>, so the agent can read it and ask
          you.
        </span>
      </footer>
    </section>
  )
}

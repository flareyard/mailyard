/** "What each scope lets it do": every built tool, behind a disclosure (design: .tools-more). */
import { TOOLS } from "./logic.ts"

export function ScopeToolsMore() {
  return (
    <details className="tools-more">
      <summary>What each scope lets it do</summary>
      <ul className="tool-list">
        {TOOLS.map((t) => (
          <li key={t.name}>
            <code className={`tag mono${t.effect === "sends" ? " tag-danger" : ""}`}>{t.name}</code>
            <span>{t.what}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

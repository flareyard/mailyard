/**
 * The template source (design: `.src.is-lines > .src-code`): a plain textarea laid exactly over a highlighted
 * copy, so typing, selection, undo and screen readers are the browser's own while tags (`.t`), variables (`.v`)
 * and missing variables (`.v.is-missing`) are coloured underneath. Tab moves focus on, as everywhere else.
 * No editor dependency.
 */
import { Fragment, useId } from "react"
import { tokenizeLine } from "../logic.ts"

export function SourceEditor({
  value,
  onChange,
  missing,
  readOnly,
  labelledBy,
  describedBy,
}: {
  value: string
  onChange: (v: string) => void
  missing: readonly string[]
  readOnly?: boolean
  labelledBy: string
  describedBy?: string
}) {
  const id = useId()
  const lines = value.split("\n")
  return (
    <div className="src is-lines tx-src">
      <pre className="src-code" aria-hidden="true">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a line's position is its identity in the source
          <span className="src-line" key={i}>
            {tokenizeLine(line).map((t, j) =>
              t.kind === "var" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional within a line
                <span key={j} className={`v${t.name && missing.includes(t.name) ? " is-missing" : ""}`}>
                  {t.text}
                </span>
              ) : t.kind === "tag" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional within a line
                <span key={j} className="t">
                  {t.text}
                </span>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional within a line
                <Fragment key={j}>{t.text}</Fragment>
              ),
            )}
            {line === "" ? "​" : null}
          </span>
        ))}
      </pre>
      <textarea
        id={id}
        className="tx-src-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
      />
    </div>
  )
}

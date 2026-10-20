/**
 * A rule tree read, not edited: nested sentences in `ul.rule-text` (design: segment-builder.html at 375 px).
 * The segment builder shows it on a phone; anything else that shows a `SegmentRule` (an automation's branch,
 * a trigger's filter) can render it the same way.
 */
import type { ReactNode } from "react"
import { type Names, type Rule, ruleText, type Sentence } from "./logic.ts"

export function RuleSentence({
  rule,
  names,
  lead = "Contacts who match",
  className = "rule-text",
}: {
  rule: Rule
  names?: Names
  lead?: ReactNode
  className?: string
}) {
  const s = ruleText(rule, names)
  if (!s.children) {
    return (
      <ul className={className} data-od-id="rule-text">
        <li>{s.text}</li>
      </ul>
    )
  }
  return (
    <ul className={className} data-od-id="rule-text">
      <li>
        {lead} <b>{s.text}</b> of these:
        <Children items={s.children} />
      </li>
    </ul>
  )
}

function Children({ items }: { items: Sentence[] }) {
  if (!items.length)
    return (
      <ul>
        <li className="muted">No rules yet: everyone matches.</li>
      </ul>
    )
  return (
    <ul>
      {items.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rules have no ids; order is their identity
        <li key={i}>
          {c.conj ? `${c.conj} ` : ""}
          {c.children ? (
            <>
              <b>{c.text}</b> of:
              <Children items={c.children} />
            </>
          ) : (
            c.text
          )}
        </li>
      ))}
    </ul>
  )
}

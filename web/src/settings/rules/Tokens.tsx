/** A rule's When and Then lines as tokens (`.rule-line > .tok(.is-act)`). */
import { Icon, type IconName } from "../../ui/icons.tsx"
import { ACTION_LABEL, type Action, type Condition, conditionText } from "../logic.ts"
import type { Names } from "./names.ts"

export function ConditionTok({ c }: { c: Condition }) {
  const t = conditionText(c)
  return (
    <span className="tok">
      {t.text}
      {t.value !== null ? (
        <>
          {" "}
          <code className="mono">{t.value}</code>
        </>
      ) : null}
    </span>
  )
}

const ACTION_ICON: Partial<Record<Action["type"], IconName>> = {
  label: "tag",
  forward: "forward",
  assign: "user",
  webhook: "webhook",
  autoReply: "reply",
  trash: "trash",
  star: "zap",
}

export function ActionTok({ a, names }: { a: Action; names: Names }) {
  const icon = ACTION_ICON[a.type]
  const body = (() => {
    switch (a.type) {
      case "label":
        return `Label ${names.label(a.labelId)}`
      case "forward":
        return (
          <>
            Forward to <code className="mono">{a.to.join(", ")}</code>
          </>
        )
      case "assign":
        return (
          <>
            Assign to {names.assignee(a.assignee)} <code className="mono">{a.assignee}</code>
          </>
        )
      case "webhook":
        return `Webhook ${names.webhook(a.endpointId)}`
      case "autoReply":
        return `Auto-reply “${a.subject}”`
      default:
        return ACTION_LABEL[a.type]
    }
  })()
  return (
    <span className="tok is-act">
      {icon ? <Icon name={icon} /> : null}
      {body}
    </span>
  )
}

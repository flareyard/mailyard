/**
 * TEMPORARY. Sections whose screens land in their own PRs (Mail HAL-3308, Audience and campaigns HAL-3310,
 * the ops screens HAL-3309) show this until then, so the shell's navigation is whole and honest. Each route
 * file that renders it is replaced, not edited, when its section ships; none of them may reach a release.
 */
import { Icon, type IconName } from "./icons.tsx"

export function SectionPending({
  title,
  issue,
  icon,
  what,
}: {
  title: string
  issue: string
  icon: IconName
  what: string
}) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="sub">{what}</p>
        </div>
      </div>
      <div className="empty" style={{ marginTop: 24 }}>
        <span className="empty-icon">
          <Icon name={icon} />
        </span>
        <b>{title} is being built</b>
        <p className="t-small muted">
          The screens are designed and the API is live; this section’s web screens land with {issue}.
        </p>
      </div>
    </>
  )
}

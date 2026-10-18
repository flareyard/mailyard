/** Activity: the latest audit entries, alerts and delivery events, each naming its actor and linking its subject. */
import { useQuery } from "@tanstack/react-query"
import { toDate } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { Panel } from "../ui/Panel.tsx"
import { actorLabel, ago, feedIcon, splitOnLabel, subjectHref } from "./logic.ts"
import { activityQuery, type Ok } from "./queries.ts"
import { AppLink, StaleMeta, useOffline } from "./shared.tsx"

type Event = Ok<"/v1/activity">["events"][number]

export function ActivityPanel() {
  const offline = useOffline()
  const q = useQuery(activityQuery)
  return (
    <Panel
      id="activity"
      title="Activity"
      to="/settings/audit"
      linkLabel="Audit log"
      span={4}
      endpoint="GET /v1/activity?cursor=&limit="
      meta={<StaleMeta offline={offline} updatedAt={q.dataUpdatedAt} label="latest" />}
      query={q}
      isEmpty={(a) => a.events.length === 0}
      empty={
        <div className="empty ov-empty-tight">
          <span className="empty-icon">
            <Icon name="pulse" />
          </span>
          <h3>Nothing has happened yet</h3>
          <p>Changes to domains, campaigns and keys, alerts, and bounces show here as they happen.</p>
        </div>
      }
      skeleton={
        <div className="stack stack-12" aria-hidden="true">
          {[100, 86, 92, 70, 80, 60, 75].map((w) => (
            <span key={w} className="sk sk-text" style={{ width: `${w}%` }} />
          ))}
        </div>
      }
    >
      {(a) => (
        <ul className="feed">
          {a.events.map((e) => {
            const at = toDate(e.at)
            return (
              <li key={e.id}>
                <span className="f-icon">
                  <Icon name={feedIcon(e.kind)} />
                </span>
                <span className="f-text">
                  <FeedText e={e} />
                  <span className="row-sub ov-block">{actorLabel(e.actor)}</span>
                </span>
                {at ? <time dateTime={at.toISOString()}>{ago(at)}</time> : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function FeedText({ e }: { e: Event }) {
  if (!e.subject) return <>{e.text}</>
  const href = subjectHref(e.subject)
  const parts = splitOnLabel(e.text, e.subject.label)
  if (!parts) return <AppLink href={href}>{e.text}</AppLink>
  return (
    <>
      {parts[0]}
      <AppLink href={href}>{parts[1]}</AppLink>
      {parts[2]}
    </>
  )
}

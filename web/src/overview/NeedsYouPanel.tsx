/** Needs you: unread, waiting past the reply target, snoozed returning today and assigned to you, per mailbox. */
import { useQuery } from "@tanstack/react-query"
import { useMe } from "../auth/session.ts"
import { fmtInt, num, toDate } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { Panel } from "../ui/Panel.tsx"
import { ago } from "./logic.ts"
import { attentionQuery } from "./queries.ts"
import { AppLink, StaleMeta, settled, useOffline } from "./shared.tsx"

export function NeedsYouPanel() {
  const me = useMe()
  const offline = useOffline()
  const q = useQuery({ ...attentionQuery, enabled: me.data?.role !== "viewer" })
  const viewer = me.data?.role === "viewer"
  const target = num(q.data?.replyTargetHours) ?? 24

  if (viewer) {
    return (
      <Panel
        id="needs-you"
        title="Needs you"
        to="/mail"
        span={4}
        endpoint="GET /v1/mail/attention"
        query={settled(null)}
      >
        {() => (
          <div className="empty ov-empty-tight">
            <span className="empty-icon">
              <Icon name="lock" />
            </span>
            <h3>Mail isn’t part of the viewer role</h3>
            <p>
              Unread, waiting and assigned threads show for people with a mailbox. Owners and admins can give
              you one in Settings → Members.
            </p>
          </div>
        )}
      </Panel>
    )
  }

  return (
    <Panel
      id="needs-you"
      title="Needs you"
      to="/mail"
      linkLabel="Mail"
      span={4}
      endpoint="GET /v1/mail/attention"
      meta={<StaleMeta offline={offline} updatedAt={q.dataUpdatedAt} label={`Reply target ${target} h`} />}
      query={q}
      skeleton={<NeedsYouSkeleton />}
    >
      {(at) => {
        const h = num(at.replyTargetHours) ?? 24
        const oldest = toDate(at.oldestWaitingAt)
        const tiles = [
          { label: "Unread", value: at.unreadTotal, sub: "", href: "/mail?is=unread" },
          {
            label: `Waiting for your reply, older than ${h} h`,
            value: at.waitingForReply,
            sub: oldest ? `oldest ${ago(oldest)}` : "",
            href: "/mail?waiting=1",
          },
          {
            label: "Snoozed, back today",
            value: at.snoozedReturningToday,
            sub: "",
            href: "/mail?folder=snoozed&returns=today",
          },
          { label: "Assigned to you", value: at.assignedToMe, sub: "", href: "/mail?assignee=me" },
        ]
        const addr = new Map(at.unread.map((u) => [u.mailboxId, u.address]))
        return (
          <div className="stack stack-12">
            {at.unavailable.length ? (
              <div className="callout callout-warn" role="status">
                <Icon name="warn" />
                <span>
                  <b>
                    {at.unavailable.length}{" "}
                    {at.unavailable.length === 1 ? "mailbox didn’t" : "mailboxes didn’t"} answer.
                  </b>{" "}
                  The counts cover the others; {at.unavailable.length === 1 ? "it’ll" : "they’ll"} be retried
                  when you come back to the tab.
                </span>
              </div>
            ) : null}
            <div className="attention">
              {tiles.map((t) => (
                <AppLink key={t.href} className="att" href={t.href}>
                  <span className="att-n">{fmtInt(t.value)}</span>
                  <span className="att-l">{t.label}</span>
                  {t.sub ? <span className="att-l">{t.sub}</span> : null}
                </AppLink>
              ))}
            </div>
            {at.mailboxes.length || at.unavailable.length ? (
              <ul className="list" aria-label="Per mailbox">
                {at.mailboxes.map((m) => {
                  const bits: string[] = []
                  if (num(m.waitingForReply)) bits.push(`${fmtInt(m.waitingForReply)} waiting`)
                  if (num(m.assignedToMe)) bits.push(`${fmtInt(m.assignedToMe)} assigned to you`)
                  if (num(m.snoozedReturning)) bits.push(`${fmtInt(m.snoozedReturning)} back today`)
                  return (
                    <li key={m.mailboxId}>
                      <AppLink
                        className="list-row"
                        href={`/mail/${encodeURIComponent(m.mailboxId)}?is=unread`}
                      >
                        <span className="grow">
                          <span className="row-title mono">{m.address}</span>
                          <span className="row-sub">
                            {bits.length ? bits.join(" · ") : "Nothing waiting"}
                          </span>
                        </span>
                        <span className="count">
                          {fmtInt(m.unread)}
                          <span className="sr-only"> unread</span>
                        </span>
                      </AppLink>
                    </li>
                  )
                })}
                {at.unavailable.map((id) => (
                  <li key={id} className="list-row">
                    <span className="grow">
                      <span className="row-title mono">{addr.get(id) ?? id}</span>
                      <span className="row-sub ov-text-warn">
                        Couldn’t be read just now, so its numbers are missing above.
                      </span>
                    </span>
                    <Icon name="warn" className="status-icon status-warn" label="Unavailable" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="t-small muted">
                No mailboxes yet. Mailboxes you can read list here with what’s waiting in each.
              </p>
            )}
          </div>
        )
      }}
    </Panel>
  )
}

function NeedsYouSkeleton() {
  return (
    <div className="stack stack-12" aria-hidden="true">
      <div className="attention">
        {Array.from({ length: 4 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <div key={i} className="att">
            <span className="sk sk-stat" />
            <span className="sk sk-text" style={{ width: "80%" }} />
          </div>
        ))}
      </div>
      <div className="stack stack-12">
        {[100, 86, 92].map((w) => (
          <span key={w} className="sk sk-text" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  )
}

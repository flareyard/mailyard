/**
 * The step log (HANDOFF §4 "Step log"): a dry run's path or a run's steps. Skipped is a dashed, neutral dot
 * and a dashed Skipped pill: no mail went out and the run went on. Failed is a solid red dot, a red title and
 * a Failed pill: the run stopped. A skip is never coloured red. A skipped send links the contact page with
 * `?field=` naming the missing field, read from the detail since steps don't carry it (HAL-3417).
 */
import { useRouter } from "@tanstack/react-router"
import type { MouseEvent, ReactNode } from "react"
import { fmtDay, fmtTime, fmtWeekday } from "../audience/kit/format.ts"
import { Icon } from "../ui/icons.tsx"
import {
  type DryStep,
  dryOutcomeLook,
  type GNode,
  type LogLook,
  logTitle,
  missingField,
  missingKeys,
  type Names,
  type RunStep,
  runOutcomeLook,
} from "./logic.ts"

/** An in-app link to a route another section owns, by its URL (the router resolves it when it exists). */
export function AppLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string
  className?: string
  children: ReactNode
  "data-od-id"?: string
}) {
  const router = useRouter()
  return (
    <a
      className={className}
      href={href}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        router.history.push(href)
      }}
    >
      {children}
    </a>
  )
}

const DOT_ICON: Record<LogLook["cls"], Parameters<typeof Icon>[0]["name"]> = {
  "is-pass": "check",
  "is-wait": "clock",
  "is-warn": "clock",
  "is-skip": "suppress",
  "is-fail": "x",
  "is-neutral": "dot",
}

function Item({
  n,
  look,
  title,
  time,
  children,
}: {
  n: number
  look: LogLook
  title: string
  time: string
  children: ReactNode
}) {
  return (
    <li className={`sl ${look.cls}`}>
      <span className={`tl-dot ${look.cls}`}>
        <Icon name={DOT_ICON[look.cls]} />
      </span>
      <span className="sl-t">
        {n}. {title} {look.pill === "skip" ? <span className="pill pill-skip">Skipped</span> : null}
        {look.pill === "fail" ? <span className="pill pill-fail">Failed</span> : null}
      </span>
      <span className="sl-time">{time}</span>
      <span className="sl-d">{children}</span>
    </li>
  )
}

function SkipFix({
  detail,
  missing,
  contactId,
  who,
}: {
  detail: string
  missing?: readonly string[] | undefined
  contactId: string | null
  who: string
}) {
  const keys = missingKeys(detail, missing)
  const field = missingField(detail, missing)
  const contactKeys = keys.filter((k) => !k.startsWith("trigger."))
  return (
    <>
      {keys.length ? (
        <span className="pill pill-skip" data-od-id="skip-missing">
          missing {keys.join(", ")}
        </span>
      ) : null}{" "}
      {field && contactId && contactKeys.length ? (
        <SkipLink field={field} contactId={contactId} who={who} />
      ) : null}
    </>
  )
}

function SkipLink({ field, contactId, who }: { field: string; contactId: string; who: string }) {
  return (
    <AppLink
      className="link sl-fix"
      href={`/audience/contacts/${encodeURIComponent(contactId)}?field=${encodeURIComponent(field)}`}
      data-od-id="skip-fix"
    >
      Add {who}’s {field}
      <Icon name="chevron-right" />
    </AppLink>
  )
}

export function DryRunLog({
  path,
  graph,
  names,
  contactId,
  who,
}: {
  path: DryStep[]
  graph: GNode[]
  names: Names
  contactId: string | null
  who: string
}) {
  const byId = new Map(graph.map((n) => [n.id, n]))
  return (
    <ol className="steplog">
      {path.map((s, i) => {
        const look = dryOutcomeLook(s.outcome)
        return (
          <Item
            // biome-ignore lint/suspicious/noArrayIndexKey: a node can appear twice (wait, then timed out)
            key={i}
            n={i + 1}
            look={look}
            title={logTitle(
              byId.get(s.nodeId),
              s.outcome === "timed-out",
              { type: s.type, label: s.label },
              names,
            )}
            time={`${fmtWeekday(s.at)}, ${fmtTime(s.at)}`}
          >
            {s.detail}
            {s.outcome === "skipped" ? (
              <>
                {" "}
                <SkipFix detail={s.detail} missing={s.missing} contactId={contactId} who={who} />
              </>
            ) : null}
            {s.send ? (
              <span className="sl-send">
                <span className="mono">{s.send.to}</span> · “{s.send.subject}” · {s.send.preview}
              </span>
            ) : null}
          </Item>
        )
      })}
    </ol>
  )
}

export function RunLog({
  steps,
  graph,
  names,
  contactId,
  who,
}: {
  steps: RunStep[]
  graph: GNode[]
  names: Names
  contactId: string
  who: string
}) {
  const byId = new Map(graph.map((n) => [n.id, n]))
  const sorted = [...steps].sort((a, b) => Number(a.seq) - Number(b.seq))
  return (
    <ol className="steplog">
      {sorted.map((s, i) => {
        const look = runOutcomeLook(s.outcome)
        return (
          <Item
            key={String(s.seq)}
            n={i + 1}
            look={look}
            title={logTitle(byId.get(s.nodeId), s.port === "timeout", { label: s.nodeId }, names)}
            time={fmtDay(s.at)}
          >
            {s.detail}
            {s.messageId ? (
              <>
                {" · "}
                <AppLink
                  className="link mono"
                  href={`/transactional/messages/${encodeURIComponent(s.messageId)}`}
                >
                  {s.messageId}
                </AppLink>
              </>
            ) : null}
            {s.outcome === "skipped" ? (
              <>
                {" "}
                <SkipFix detail={s.detail} missing={s.missing} contactId={contactId} who={who} />
              </>
            ) : null}
          </Item>
        )
      })}
    </ol>
  )
}

/**
 * Small pieces the campaign screens share: links into other sections, the limited-key refusal, the paused and
 * held callouts' words, and the error callout that names its request.
 */
import { useRouter } from "@tanstack/react-router"
import type { MouseEvent, ReactNode } from "react"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"
import type { AgentRefusal } from "./logic.ts"

/**
 * A link into another section of the app by its URL. Sections are built separately, so their routes aren't
 * all in this build's route tree; this navigates in place through the router's history either way.
 */
export function AppLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string
  className?: string
  children: ReactNode
  "aria-label"?: string
  "aria-current"?: "page" | "step" | undefined
  "data-od-id"?: string
  title?: string
}) {
  const router = useRouter()
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    router.history.push(href)
  }
  return (
    <a href={href} className={className} onClick={go} {...rest}>
      {children}
    </a>
  )
}

/** A limited key's refusal (HAL-3460), in the API's words, with what it means and the request id. */
export function AgentRefusalCallout({ refusal, what }: { refusal: AgentRefusal; what: string }) {
  return (
    <div className="callout callout-error" role="alert" data-od-id="agent-limit">
      <Icon name="lock" />
      <div className="stack stack-4">
        <span>
          <b>{what} </b>
          {refusal.message}
          {refusal.notAllowed.length ? (
            <>
              {" "}
              Not allowed:{" "}
              {refusal.notAllowed.map((a, i) => (
                <span key={a}>
                  {i ? ", " : ""}
                  <code className="mono">{a}</code>
                </span>
              ))}
              .
            </>
          ) : null}
        </span>
        <span className="t-small muted">
          <code className="mono">409 {refusal.reason}</code>
          {refusal.reason === "agent_limit"
            ? " · This key has send limits (Settings → Integrations). A person, or a key without limits, can do this."
            : " · This key may only write to the addresses its limits allow."}
        </span>
        {refusal.requestId ? <RequestId id={refusal.requestId} /> : null}
      </div>
    </div>
  )
}

/** "Refused for this key" second line for a control a limited key already had refused. */
export const AGENT_WHO = "Keys with send limits can’t send campaigns; a person schedules those."

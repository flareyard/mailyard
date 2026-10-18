/**
 * Disabled with a reason (design: states/no-permission.html, states/overview-viewer.html, HANDOFF §3): a
 * control you can't use stays visible and focusable, says it's off with `aria-disabled`, and explains on hover
 * and focus in `.reason-pop`, line 1 what's blocked and line 2 who can, or when it unblocks. Never `disabled`,
 * which drops focus and hides the reason.
 *
 *   <Gated allowed={can} reason="You can’t pause campaigns" who="Owners, admins and senders can pause a campaign.">
 *     <button className="btn btn-secondary btn-sm" type="button" onClick={pause}>Pause</button>
 *   </Gated>
 */
import {
  cloneElement,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useId,
} from "react"
import type { Me } from "./session.ts"

type ControlProps = {
  onClick?: (e: MouseEvent<HTMLElement>) => void
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
  "aria-describedby"?: string
  "aria-disabled"?: boolean | "true" | "false"
  className?: string
  disabled?: boolean
}

export function Gated({
  allowed,
  reason,
  who,
  side,
  block = false,
  children,
}: {
  allowed: boolean
  /** What's blocked, in a sentence: “You can’t pause campaigns”. */
  reason: ReactNode
  /** Who can, or when it unblocks: “Owners and admins can.” */
  who?: ReactNode
  /** Where the popover opens: below-left by default, `right` aligns it to the right edge, `up` above. */
  side?: "right" | "up"
  /** Full-width controls (`.btn-block`). */
  block?: boolean
  children: ReactElement<ControlProps>
}) {
  const id = useId()
  if (allowed || !isValidElement(children)) return children
  const original = children.props
  const stop = (e: MouseEvent<HTMLElement>) => {
    // aria-disabled keeps focus and the reason, so the click (and a form's implicit submit) is cancelled here.
    e.preventDefault()
    e.stopPropagation()
  }
  const describedBy = [original["aria-describedby"], id].filter(Boolean).join(" ")
  const control = cloneElement(children, {
    "aria-disabled": "true",
    "aria-describedby": describedBy,
    disabled: false,
    onClick: stop,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter" || e.key === " ") e.preventDefault()
      original.onKeyDown?.(e)
    },
  })
  return (
    <span className="has-reason" style={block ? { display: "flex", width: "100%" } : undefined}>
      {control}
      <span className={`reason-pop${side ? ` is-${side}` : ""}`} id={id} role="tooltip">
        <b>{reason}</b>
        {who ? <span className="reason-who">{who}</span> : null}
      </span>
    </span>
  )
}

export type Role = NonNullable<Me["role"]>

const ROLE_PLURAL: Record<Role, string> = {
  owner: "Owners",
  admin: "admins",
  sender: "senders",
  agent: "agents",
  viewer: "viewers",
}

/** “Owners, admins and senders can pause a campaign.” from the roles a 403 `allowedRoles` names. */
export function whoCan(roles: readonly Role[], action: string): string {
  const names = roles.map((r, i) =>
    i === 0 ? ROLE_PLURAL[r].replace(/^./, (c) => c.toUpperCase()) : ROLE_PLURAL[r],
  )
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
      : (names[0] ?? "Nobody")
  return `${list} can ${action}.`
}

/**
 * Whether the signed-in caller may do something only some roles can. Until people and roles exist (HAL-3361)
 * `role` is null and access comes from the key's scopes, so a null role is judged by `scope` alone.
 */
export function roleAllows(me: Me | undefined, roles: readonly Role[], scope?: string): boolean {
  if (!me) return false
  if (me.role) return roles.includes(me.role)
  if (!scope || me.via === "admin-key") return true
  return (me.scopes as readonly string[]).includes(scope)
}

/** The second line for a refusal by scope rather than role, while roles are still planned. */
export function scopeWho(scope: string): string {
  return `Needs a key with the ${scope} scope, or the admin key. Roles arrive with HAL-3361.`
}

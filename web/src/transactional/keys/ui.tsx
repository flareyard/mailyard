/**
 * Small pieces the keys, webhooks and suppressions screens share: the status pill, an inline refusal with
 * its request id, the admin gate and a few labels.
 */
import type { ReactElement, ReactNode } from "react"
import { ApiError } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { useMe } from "../../auth/session.ts"
import { isAdmin } from "../../ops/roles.ts"
import { Icon } from "../../ui/icons.tsx"
import { RequestId } from "../../ui/Panel.tsx"

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {children}
    </span>
  )
}

/** The API's refusal, inline in a sheet: what it said, and the request id to quote. */
export function Refusal({ error, what }: { error: unknown; what?: string }) {
  if (!error) return null
  const e = error instanceof ApiError ? error : null
  return (
    <div className="callout callout-error" role="alert">
      <Icon name="warn" />
      <span className="stack stack-4">
        <span>
          <b>{what ?? "That didn’t work."}</b>{" "}
          {e ? (
            <>
              The API answered <span className="mono">{e.status}</span>
              {e.body._tag ? <span className="mono"> {String(e.body._tag)}</span> : null}: {e.message}
            </>
          ) : (
            "Mailyard couldn’t be reached. Check your connection and try again."
          )}
        </span>
        {e?.requestId ? <RequestId id={e.requestId} /> : null}
      </span>
    </div>
  )
}

/** Owners and admins only (HANDOFF-ops §3: senders read keys and webhooks, only admins change them). */
export function useIsAdmin() {
  const me = useMe()
  return { admin: isAdmin(me.data), me: me.data }
}

export function AdminOnly({
  allowed,
  reason,
  who = "Owners and admins can.",
  side,
  children,
}: {
  allowed: boolean
  reason: string
  who?: string
  side?: "right" | "up"
  children: ReactElement<{ onClick?: (e: never) => void }>
}) {
  return (
    <Gated allowed={allowed} reason={reason} who={who} {...(side ? { side } : {})}>
      {children as never}
    </Gated>
  )
}

/** "…" after a prefix, the way keys appear in lists and logs. */
export const prefixed = (p: string) => `${p}…`

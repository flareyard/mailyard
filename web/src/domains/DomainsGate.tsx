/** The Domains section frame: the role gate, the toasts, and the page below. */
import type { ReactNode } from "react"
import { useMe } from "../auth/session.ts"
import { Locked, PageHead } from "../ops/kit.tsx"
import { canOpenAdmin } from "../ops/roles.ts"
import { Toaster } from "../ops/toast.tsx"
import { PanelSkeleton } from "../ui/Panel.tsx"

export function DomainsGate({ children }: { children: ReactNode }) {
  const me = useMe()
  if (me.isPending) return <PanelSkeleton rows={4} />
  if (!canOpenAdmin(me.data)) {
    const role = me.data?.role
    return (
      <>
        <PageHead title="Domains" sub="DNS records, routing and sending, DMARC and reputation." />
        <Locked
          title={role ? `Domains isn’t part of the ${role} role` : "Domains needs the admin scope"}
          what="Changing a record or turning sending off affects every mailbox and campaign, so it’s kept to owners and admins. Reputation numbers are in Analytics."
          who={
            role ? (
              <>
                <b>Owners and admins</b> can open it. Ask an owner or admin to change your role in Settings →
                Members.
              </>
            ) : (
              <>
                Sign in with a key that has the <b>admin</b> scope, or the admin key.
              </>
            )
          }
        />
      </>
    )
  }
  return (
    <>
      {children}
      <Toaster />
    </>
  )
}

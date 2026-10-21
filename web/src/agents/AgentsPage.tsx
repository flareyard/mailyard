/** `/agents`: the agent mailboxes, and the sheet that creates one (`?sheet=agent-new`). */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi } from "@tanstack/react-router"
import { useMe } from "../auth/session.ts"
import { isAdmin } from "../ops/roles.ts"
import { AgentNewSheet } from "../settings/integrations/AgentNewSheet.tsx"
import { AgentMailboxes } from "../settings/integrations/Integrations.tsx"
import { approvalsQuery } from "../settings/integrations/queries.ts"
import "../settings/integrations/integrations.css"
import { Icon } from "../ui/icons.tsx"
import { AgentsHead } from "./ui.tsx"

const route = getRouteApi("/_app/agents/")

export function AgentsPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const admin = isAdmin(useMe().data)
  const pending = useQuery({ ...approvalsQuery("pending"), enabled: admin })
  const close = () => navigate({ search: (s) => (s.fx ? { fx: s.fx } : {}), replace: true })
  return (
    <>
      <AgentsHead
        count={pending.data?.approvals.length ?? 0}
        actions={
          <a className="btn btn-secondary" href="/docs/agents">
            <Icon name="file" />
            How agents work
          </a>
        }
      />
      <AgentMailboxes
        admin={admin}
        onNew={() => navigate({ search: (s) => ({ ...s, sheet: "agent-new" }) })}
      />
      {search.sheet === "agent-new" && admin ? <AgentNewSheet onClose={close} /> : null}
    </>
  )
}

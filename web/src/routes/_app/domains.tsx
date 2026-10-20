/**
 * Domains (HAL-3309, HANDOFF-ops §1, §24): owners and admins only. Senders, agents and viewers get the locked
 * section on a direct link (design: domains-sender), since a record change affects every mailbox and campaign.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router"
import { DomainsGate } from "../../domains/DomainsGate.tsx"

export const Route = createFileRoute("/_app/domains")({
  staticData: { title: "Domains" },
  component: () => (
    <div className="ops">
      <DomainsGate>
        <Outlet />
      </DomainsGate>
    </div>
  ),
})

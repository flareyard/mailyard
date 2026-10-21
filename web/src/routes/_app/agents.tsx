/** Agents (founder, 2026-10-21): a section of its own, not a page inside Settings. */
import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/agents")({
  staticData: { title: "Agents" },
  // `?fx=` picks a designed state in fixture mode, as the Settings layout does for its pages.
  validateSearch: (s: Record<string, unknown>): { fx?: string } =>
    typeof s.fx === "string" && s.fx ? { fx: s.fx } : {},
  component: () => (
    <div className="ops">
      <Outlet />
    </div>
  ),
})

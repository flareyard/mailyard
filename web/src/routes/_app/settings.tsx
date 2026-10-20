import { createFileRoute } from "@tanstack/react-router"
import { SettingsLayout } from "../../settings/Layout.tsx"

export type SettingsSearch = {
  /** Fixture mode only: picks a designed state (empty, error, a role) on the page's fixtures. */
  fx?: string
}

export const Route = createFileRoute("/_app/settings")({
  staticData: { title: "Settings" },
  validateSearch: (s: Record<string, unknown>): SettingsSearch =>
    typeof s.fx === "string" && s.fx ? { fx: s.fx } : {},
  component: SettingsLayout,
})

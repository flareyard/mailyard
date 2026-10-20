import { createFileRoute } from "@tanstack/react-router"
import { Builder, type BuilderPanel } from "../../../automations/Builder.tsx"

export type BuilderSearch = {
  /** The side panel: a step's inspector (`node`), the dry run, versions, the publish issues or settings. */
  panel?: BuilderPanel
  node?: string
  /** A run drawn on the canvas: its path, skipped and failed steps. */
  run?: string
  /** Fixture mode's design-screen state (`?fx=`), kept across the builder's own navigation. */
  fx?: string
}

const PANELS: readonly BuilderPanel[] = ["versions", "dry-run", "issues", "publish", "settings"]
const ID = /^[A-Za-z0-9_-]{1,64}$/

export const Route = createFileRoute("/_app/automations/$automationId")({
  staticData: { title: "Automations" },
  validateSearch: (s: Record<string, unknown>): BuilderSearch => ({
    ...(typeof s.panel === "string" && (PANELS as readonly string[]).includes(s.panel)
      ? { panel: s.panel as BuilderPanel }
      : {}),
    ...(typeof s.node === "string" && ID.test(s.node) ? { node: s.node } : {}),
    ...(typeof s.run === "string" && ID.test(s.run) ? { run: s.run } : {}),
    ...(typeof s.fx === "string" && /^[a-z0-9-]{1,80}$/.test(s.fx) ? { fx: s.fx } : {}),
  }),
  component: () => <Builder id={Route.useParams().automationId} search={Route.useSearch()} />,
})

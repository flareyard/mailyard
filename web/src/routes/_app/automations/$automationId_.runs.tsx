import { createFileRoute } from "@tanstack/react-router"
import type { Run } from "../../../automations/logic.ts"
import { Runs } from "../../../automations/Runs.tsx"

export type RunsSearch = {
  status?: Run["status"]
  version?: string
  run?: string
  cursor?: string
  fx?: string
}

const STATUSES: readonly Run["status"][] = ["running", "waiting", "completed", "exited", "failed"]

export const Route = createFileRoute("/_app/automations/$automationId_/runs")({
  staticData: { title: "Runs" },
  validateSearch: (s: Record<string, unknown>): RunsSearch => ({
    ...(typeof s.status === "string" && (STATUSES as readonly string[]).includes(s.status)
      ? { status: s.status as Run["status"] }
      : {}),
    ...(typeof s.version === "string" || typeof s.version === "number"
      ? /^\d{1,6}$/.test(String(s.version))
        ? { version: String(s.version) }
        : {}
      : {}),
    ...(typeof s.run === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s.run) ? { run: s.run } : {}),
    ...(typeof s.cursor === "string" && s.cursor.length < 200 ? { cursor: s.cursor } : {}),
    ...(typeof s.fx === "string" && /^[a-z0-9-]{1,80}$/.test(s.fx) ? { fx: s.fx } : {}),
  }),
  component: () => <Runs id={Route.useParams().automationId} search={Route.useSearch()} />,
})

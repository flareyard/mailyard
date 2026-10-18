import { createFileRoute } from "@tanstack/react-router"
import { FirstRunGate } from "../../first-run/FirstRun.tsx"
import { isStepId, type StepId } from "../../first-run/logic.ts"
import { Overview } from "../../overview/Overview.tsx"

export type Range = "24h" | "7d" | "30d"
export type OverviewSearch = {
  range?: Range
  /** `?setup=1` opens the setup checklist even once setup is done (HANDOFF §2). */
  setup?: 1
  /** Which setup step is open; `complete` is the hand-over. */
  step?: StepId | "complete"
}

export const Route = createFileRoute("/_app/")({
  staticData: { title: "Overview" },
  // 7d is the default and stays out of the URL; 24h and 30d are written so the view can be shared.
  validateSearch: (s: Record<string, unknown>): OverviewSearch => ({
    ...(s.range === "24h" || s.range === "30d" || s.range === "7d" ? { range: s.range } : {}),
    ...(s.setup === 1 || s.setup === "1" || s.setup === true ? { setup: 1 as const } : {}),
    ...(s.step === "complete" || isStepId(s.step) ? { step: s.step } : {}),
  }),
  component: Home,
})

/** `/` is the first-run checklist until the four required steps pass, then the Overview. */
function Home() {
  const { setup, step } = Route.useSearch()
  return <FirstRunGate forced={setup === 1} step={step} overview={<Overview />} />
}

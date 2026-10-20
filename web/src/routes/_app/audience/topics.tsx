import { createFileRoute } from "@tanstack/react-router"
import { isRange, type Range } from "../../../audience/topics/logic.ts"
import { TopicsPage } from "../../../audience/topics/Topics.tsx"

export type TopicsSearch = { range?: Range; edit?: string; new?: 1 }

/** Audience → Topics (HAL-3310). 30d is the default and stays out of the URL. */
export const Route = createFileRoute("/_app/audience/topics")({
  staticData: { title: "Topics" },
  validateSearch: (s: Record<string, unknown>): TopicsSearch => ({
    ...(isRange(s.range) && s.range !== "30d" ? { range: s.range } : {}),
    ...(typeof s.edit === "string" && /^[A-Za-z0-9_]{1,80}$/.test(s.edit) ? { edit: s.edit } : {}),
    ...(s.new === 1 || s.new === "1" ? { new: 1 as const } : {}),
  }),
  component: Topics,
})

function Topics() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const range = search.range ?? "30d"
  const base = range === "30d" ? {} : { range }
  return (
    <TopicsPage
      range={range}
      edit={search.edit}
      isNew={search.new === 1}
      onRange={(r) => navigate({ search: { ...(r === "30d" ? {} : { range: r }) }, replace: true })}
      onEdit={(id) => navigate({ search: { ...base, ...(id ? { edit: id } : {}) }, replace: true })}
      onNew={(open) => navigate({ search: { ...base, ...(open ? { new: 1 as const } : {}) }, replace: true })}
    />
  )
}

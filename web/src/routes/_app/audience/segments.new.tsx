import { createFileRoute } from "@tanstack/react-router"
import { SegmentBuilder } from "../../../audience/segments/Builder.tsx"

export type NewSegmentSearch = { sql?: 1 }

/** A new segment in the builder (HAL-3310); saving it moves to its own URL. */
export const Route = createFileRoute("/_app/audience/segments/new")({
  staticData: { title: "New segment" },
  validateSearch: (s: Record<string, unknown>): NewSegmentSearch =>
    s.sql === 1 || s.sql === "1" ? { sql: 1 } : {},
  component: NewSegment,
})

function NewSegment() {
  const { sql } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <SegmentBuilder
      id={null}
      sql={sql === 1}
      onSql={(on) => navigate({ search: on ? { sql: 1 } : {}, replace: true })}
      onSaved={(id) =>
        navigate({ to: "/audience/segments/$segmentId", params: { segmentId: id }, replace: true })
      }
      onDeleted={() => navigate({ to: "/audience/segments" })}
    />
  )
}

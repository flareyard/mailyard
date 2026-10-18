import { createFileRoute } from "@tanstack/react-router"
import { SegmentBuilder } from "../../../audience/segments/Builder.tsx"

export type SegmentSearch = { sql?: 1 }

/** One segment in the builder (HAL-3310); `?sql=1` shows the compiled SQL. */
export const Route = createFileRoute("/_app/audience/segments/$segmentId")({
  staticData: { title: "Segment" },
  validateSearch: (s: Record<string, unknown>): SegmentSearch =>
    s.sql === 1 || s.sql === "1" ? { sql: 1 } : {},
  component: Segment,
})

function Segment() {
  const { segmentId } = Route.useParams()
  const { sql } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <SegmentBuilder
      id={segmentId}
      sql={sql === 1}
      onSql={(on) => navigate({ search: on ? { sql: 1 } : {}, replace: true })}
      onSaved={(id) => navigate({ to: "/audience/segments/$segmentId", params: { segmentId: id } })}
      onDeleted={() => navigate({ to: "/audience/segments" })}
    />
  )
}

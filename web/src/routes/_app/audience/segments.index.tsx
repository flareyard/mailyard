import { createFileRoute } from "@tanstack/react-router"
import { SegmentsPage } from "../../../audience/segments/Segments.tsx"

/** Audience → Segments (HAL-3310). */
export const Route = createFileRoute("/_app/audience/segments/")({
  staticData: { title: "Segments" },
  component: SegmentsPage,
})

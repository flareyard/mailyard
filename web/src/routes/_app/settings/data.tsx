import { createFileRoute } from "@tanstack/react-router"
import { DataPage } from "../../../settings/data/DataPage.tsx"

export type DataSearch = { export?: string }

export const Route = createFileRoute("/_app/settings/data")({
  staticData: { title: "Import and export" },
  validateSearch: (s: Record<string, unknown>): DataSearch =>
    typeof s.export === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s.export) ? { export: s.export } : {},
  component: DataPage,
})

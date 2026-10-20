import { createFileRoute } from "@tanstack/react-router"
import { TemplateVersions } from "../../../transactional/templates/Versions.tsx"

export type VersionsSearch = { rollback?: number; preview?: number }

const n = (v: unknown) => {
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN
  return Number.isInteger(x) && x > 0 ? x : undefined
}

export const Route = createFileRoute("/_app/transactional/templates/$id/versions")({
  staticData: { title: "Template versions" },
  validateSearch: (s: Record<string, unknown>): VersionsSearch => {
    const rollback = n(s.rollback)
    const preview = n(s.preview)
    return { ...(rollback ? { rollback } : {}), ...(preview ? { preview } : {}) }
  },
  component: TemplateVersions,
})

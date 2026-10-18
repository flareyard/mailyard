import { createFileRoute } from "@tanstack/react-router"
import { TemplateList } from "../../../transactional/templates/TemplateList.tsx"

export type TemplatesSearch = { archived?: true; new?: 1 }

export const Route = createFileRoute("/_app/transactional/templates/")({
  staticData: { title: "Templates" },
  validateSearch: (s: Record<string, unknown>): TemplatesSearch => ({
    ...(s.archived === true || s.archived === "true" ? { archived: true as const } : {}),
    ...(s.new === 1 || s.new === "1" ? { new: 1 as const } : {}),
  }),
  component: TemplateList,
})

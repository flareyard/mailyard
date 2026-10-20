import { createFileRoute } from "@tanstack/react-router"
import { TemplateEditor } from "../../../transactional/templates/TemplateEditor.tsx"

export type EditorSearch = { device?: "phone" | "dark"; test?: 1; publish?: 1 }

export const Route = createFileRoute("/_app/transactional/templates/$id/")({
  staticData: { title: "Template" },
  validateSearch: (s: Record<string, unknown>): EditorSearch => ({
    ...(s.device === "phone" || s.device === "dark" ? { device: s.device } : {}),
    ...(s.test === 1 || s.test === "1" ? { test: 1 as const } : {}),
    ...(s.publish === 1 || s.publish === "1" ? { publish: 1 as const } : {}),
  }),
  component: TemplateEditor,
})

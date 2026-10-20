import { createFileRoute } from "@tanstack/react-router"
import { PhonePreview } from "../../../transactional/templates/PhonePreview.tsx"

export const Route = createFileRoute("/_app/transactional/templates/$id/preview")({
  staticData: { title: "Template preview" },
  component: PhonePreview,
})

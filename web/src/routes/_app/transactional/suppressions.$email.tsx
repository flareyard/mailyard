import { createFileRoute } from "@tanstack/react-router"
import { validateSupSearch } from "../../../transactional/suppressions/queries.ts"
import { SuppressionDetail } from "../../../transactional/suppressions/SuppressionDetail.tsx"

export const Route = createFileRoute("/_app/transactional/suppressions/$email")({
  staticData: { title: "Suppression" },
  validateSearch: validateSupSearch,
  component: SuppressionDetail,
})

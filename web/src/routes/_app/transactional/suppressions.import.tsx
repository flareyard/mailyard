import { createFileRoute } from "@tanstack/react-router"
import { ImportPage } from "../../../transactional/suppressions/ImportPage.tsx"
import { validateImportSearch } from "../../../transactional/suppressions/queries.ts"

export const Route = createFileRoute("/_app/transactional/suppressions/import")({
  staticData: { title: "Import suppressions" },
  validateSearch: validateImportSearch,
  component: ImportPage,
})

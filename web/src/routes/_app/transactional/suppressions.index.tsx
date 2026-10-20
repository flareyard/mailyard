import { createFileRoute } from "@tanstack/react-router"
import { validateSupsSearch } from "../../../transactional/suppressions/queries.ts"
import { SuppressionsPage } from "../../../transactional/suppressions/SuppressionsPage.tsx"

export const Route = createFileRoute("/_app/transactional/suppressions/")({
  staticData: { title: "Suppressions" },
  validateSearch: validateSupsSearch,
  component: SuppressionsPage,
})

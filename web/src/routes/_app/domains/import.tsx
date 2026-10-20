import { createFileRoute } from "@tanstack/react-router"
import { ImportPage } from "../../../domains/Import.tsx"

export const Route = createFileRoute("/_app/domains/import")({
  staticData: { title: "Import a domain" },
  component: ImportPage,
})

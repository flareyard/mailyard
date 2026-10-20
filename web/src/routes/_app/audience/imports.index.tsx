import { createFileRoute } from "@tanstack/react-router"
import { ImportsPage } from "../../../audience/import/ImportsPage.tsx"

export const Route = createFileRoute("/_app/audience/imports/")({
  staticData: { title: "Import contacts" },
  component: ImportsPage,
})

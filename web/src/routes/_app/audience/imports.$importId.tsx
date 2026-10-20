import { createFileRoute } from "@tanstack/react-router"
import { ImportPage } from "../../../audience/import/ImportPage.tsx"

type Search = { cancel?: 1 }

export const Route = createFileRoute("/_app/audience/imports/$importId")({
  staticData: { title: "Import contacts" },
  validateSearch: (s: Record<string, unknown>): Search =>
    s.cancel === 1 || s.cancel === "1" ? { cancel: 1 } : {},
  component: ImportRoute,
})

function ImportRoute() {
  const { importId } = Route.useParams()
  const { cancel } = Route.useSearch()
  return <ImportPage id={importId} cancelOpen={cancel === 1} />
}

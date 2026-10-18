import { createFileRoute } from "@tanstack/react-router"
import { Quickstart } from "../../../transactional/Quickstart.tsx"

export const Route = createFileRoute("/_app/transactional/quickstart")({
  staticData: { title: "Quick start" },
  component: Quickstart,
})

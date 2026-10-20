import { createFileRoute } from "@tanstack/react-router"
import { TransactionalLayout } from "../../transactional/Layout.tsx"

export const Route = createFileRoute("/_app/transactional")({
  staticData: { title: "Transactional" },
  component: TransactionalLayout,
})

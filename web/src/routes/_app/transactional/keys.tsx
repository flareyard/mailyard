import { createFileRoute } from "@tanstack/react-router"
import { KeysPage } from "../../../transactional/keys/KeysPage.tsx"
import { validateKeysSearch } from "../../../transactional/keys/queries.ts"

export const Route = createFileRoute("/_app/transactional/keys")({
  staticData: { title: "API keys" },
  validateSearch: validateKeysSearch,
  component: KeysPage,
})

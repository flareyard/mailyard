import { createFileRoute } from "@tanstack/react-router"
import { validateHooksSearch } from "../../../transactional/webhooks/queries.ts"
import { WebhooksPage } from "../../../transactional/webhooks/WebhooksPage.tsx"

export const Route = createFileRoute("/_app/transactional/webhooks/")({
  staticData: { title: "Webhooks" },
  validateSearch: validateHooksSearch,
  component: WebhooksPage,
})

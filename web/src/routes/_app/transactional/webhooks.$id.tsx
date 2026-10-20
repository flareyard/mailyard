import { createFileRoute } from "@tanstack/react-router"
import { validateHookSearch } from "../../../transactional/webhooks/queries.ts"
import { WebhookDetail } from "../../../transactional/webhooks/WebhookDetail.tsx"

export const Route = createFileRoute("/_app/transactional/webhooks/$id")({
  staticData: { title: "Webhook" },
  validateSearch: validateHookSearch,
  component: WebhookDetail,
})

import { createFileRoute, redirect } from "@tanstack/react-router"

/** /transactional opens the message log. */
export const Route = createFileRoute("/_app/transactional/")({
  beforeLoad: () => {
    throw redirect({ to: "/transactional/messages", replace: true })
  },
})

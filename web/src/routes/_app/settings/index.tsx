import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/settings/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/mailboxes", search, replace: true })
  },
})

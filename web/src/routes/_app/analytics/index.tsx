import { createFileRoute, redirect } from "@tanstack/react-router"

/** /analytics opens on Sending, keeping the range. */
export const Route = createFileRoute("/_app/analytics/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/analytics/sending", search, replace: true })
  },
})

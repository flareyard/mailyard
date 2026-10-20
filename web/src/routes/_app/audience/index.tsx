import { createFileRoute, redirect } from "@tanstack/react-router"

/** `/audience` opens on Contacts. */
export const Route = createFileRoute("/_app/audience/")({
  beforeLoad: () => {
    throw redirect({ to: "/audience/contacts", replace: true })
  },
})

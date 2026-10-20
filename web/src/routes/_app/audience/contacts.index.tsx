import { createFileRoute } from "@tanstack/react-router"
import { ContactsPage } from "../../../audience/contacts/ContactsPage.tsx"
import { type ContactsSearch, parseContactsSearch } from "../../../audience/contacts/logic.ts"

export const Route = createFileRoute("/_app/audience/contacts/")({
  staticData: { title: "Contacts" },
  validateSearch: (s: Record<string, unknown>): ContactsSearch => parseContactsSearch(s),
  component: ContactsRoute,
})

function ContactsRoute() {
  return <ContactsPage search={Route.useSearch()} />
}

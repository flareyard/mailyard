import { createFileRoute } from "@tanstack/react-router"
import { ContactPage, type ContactSearch } from "../../../audience/contacts/ContactPage.tsx"
import { parseKinds } from "../../../audience/contacts/detail.ts"

export const Route = createFileRoute("/_app/audience/contacts/$contactId")({
  staticData: { title: "Contact" },
  validateSearch: (s: Record<string, unknown>): ContactSearch => {
    const kinds = parseKinds(s.kind)
    return {
      ...(kinds.length ? { kind: kinds.join(",") } : {}),
      ...(typeof s.field === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s.field)
        ? { field: s.field }
        : {}),
      ...(s.sheet === "erase" || s.sheet === "edit" || s.sheet === "trigger" ? { sheet: s.sheet } : {}),
    }
  },
  component: ContactRoute,
})

function ContactRoute() {
  const { contactId } = Route.useParams()
  return <ContactPage id={contactId} search={Route.useSearch()} />
}

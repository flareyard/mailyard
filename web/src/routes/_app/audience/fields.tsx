import { createFileRoute } from "@tanstack/react-router"
import { FieldsPage } from "../../../audience/fields/Fields.tsx"

export type FieldsSearch = { edit?: string }

/** Audience → Fields (HAL-3310): the contact-field registry; `?edit=key` opens the edit sheet. */
export const Route = createFileRoute("/_app/audience/fields")({
  staticData: { title: "Fields" },
  validateSearch: (s: Record<string, unknown>): FieldsSearch =>
    typeof s.edit === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s.edit) ? { edit: s.edit } : {},
  component: Fields,
})

function Fields() {
  const { edit } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <FieldsPage edit={edit} onEdit={(key) => navigate({ search: key ? { edit: key } : {}, replace: true })} />
  )
}

import { createFileRoute } from "@tanstack/react-router"
import { FormEditor } from "../../../audience/forms/FormEditor.tsx"

/** One signup form in the editor (HAL-3310). */
export const Route = createFileRoute("/_app/audience/forms/$formId")({
  staticData: { title: "Form" },
  component: Form,
})

function Form() {
  const { formId } = Route.useParams()
  return <FormEditor id={formId} />
}

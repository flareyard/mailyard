import { createFileRoute } from "@tanstack/react-router"
import { FormsPage } from "../../../audience/forms/Forms.tsx"

/** Audience → Forms (HAL-3310). */
export const Route = createFileRoute("/_app/audience/forms/")({
  staticData: { title: "Forms" },
  component: FormsPage,
})

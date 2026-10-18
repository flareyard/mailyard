import { createFileRoute } from "@tanstack/react-router"
import { SendingPage } from "../../../settings/Sending.tsx"

export const Route = createFileRoute("/_app/settings/sending")({
  staticData: { title: "Sending and governor" },
  component: SendingPage,
})

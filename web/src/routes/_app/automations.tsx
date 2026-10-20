import { createFileRoute, Outlet } from "@tanstack/react-router"

/** Automations (HAL-3310): the list, the builder and the runs are nested under this pass-through layout. */
export const Route = createFileRoute("/_app/automations")({
  staticData: { title: "Automations" },
  component: Outlet,
})

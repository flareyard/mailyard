import { createFileRoute, Outlet } from "@tanstack/react-router"

/** Campaigns (HAL-3310): the list, the five-step editor, the sending view and the report. */
export const Route = createFileRoute("/_app/campaigns")({
  staticData: { title: "Campaigns" },
  component: Outlet,
})

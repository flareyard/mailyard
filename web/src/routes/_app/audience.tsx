import { createFileRoute, Outlet } from "@tanstack/react-router"

/** Audience (HAL-3310): contacts, segments, topics, forms, fields and imports, each its own route below. */
export const Route = createFileRoute("/_app/audience")({
  staticData: { title: "Audience" },
  component: Outlet,
})

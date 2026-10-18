import { createFileRoute } from "@tanstack/react-router"
import { BrandPage } from "../../../settings/brand/Brand.tsx"

export const Route = createFileRoute("/_app/settings/brand")({
  staticData: { title: "Brand" },
  component: BrandPage,
})

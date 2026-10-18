import { createFileRoute } from "@tanstack/react-router"
import { MembersPage } from "../../../settings/members/Members.tsx"

export type MembersSearch = { invite?: 1 }

export const Route = createFileRoute("/_app/settings/members")({
  staticData: { title: "Members and roles" },
  validateSearch: (s: Record<string, unknown>): MembersSearch =>
    s.invite === 1 || s.invite === "1" ? { invite: 1 } : {},
  component: MembersPage,
})

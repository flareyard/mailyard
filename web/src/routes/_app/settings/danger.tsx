import { createFileRoute } from "@tanstack/react-router"
import { DangerPage, type DangerSheet } from "../../../settings/danger/DangerPage.tsx"

export type DangerSearch = { sheet?: DangerSheet; mailbox?: string }

export const Route = createFileRoute("/_app/settings/danger")({
  staticData: { title: "Danger zone" },
  validateSearch: (s: Record<string, unknown>): DangerSearch => ({
    ...(s.sheet === "domain" || s.sheet === "mailbox" || s.sheet === "workspace" ? { sheet: s.sheet } : {}),
    ...(typeof s.mailbox === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s.mailbox)
      ? { mailbox: s.mailbox }
      : {}),
  }),
  component: DangerPage,
})

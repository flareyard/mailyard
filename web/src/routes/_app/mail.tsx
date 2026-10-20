import { createFileRoute } from "@tanstack/react-router"
import { MailRoot } from "../../mail/MailRoot.tsx"

export type MailRootSearch = {
  /** `?compose=1` opens the full-window composer: the shell's Compose button and C land here. */
  compose?: 1
  /** With `compose=1`: the draft to open in it. */
  draft?: string
}

export const Route = createFileRoute("/_app/mail")({
  staticData: { title: "Mail" },
  validateSearch: (s: Record<string, unknown>): MailRootSearch => ({
    ...(s.compose === 1 || s.compose === "1" || s.compose === true ? { compose: 1 as const } : {}),
    ...(typeof s.draft === "string" && s.draft ? { draft: s.draft } : {}),
  }),
  component: MailRoot,
})

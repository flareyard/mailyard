import type { IconName } from "../ui/icons.tsx"

/** The sections in the sidebar, the palette's "Jump to" and the g-chords (G then O, G then M, …). */
export const SECTIONS: { to: string; label: string; icon: IconName; chord: string }[] = [
  { to: "/", label: "Overview", icon: "overview", chord: "o" },
  { to: "/mail", label: "Mail", icon: "mail", chord: "m" },
  { to: "/audience", label: "Audience", icon: "audience", chord: "a" },
  { to: "/campaigns", label: "Campaigns", icon: "campaigns", chord: "c" },
  { to: "/automations", label: "Automations", icon: "automations", chord: "u" },
  // Agent mailboxes and their approvals (founder 2026-10-21: agent mail had no screen anyone could find).
  { to: "/agents", label: "Agents", icon: "bot", chord: "i" },
  { to: "/transactional", label: "Transactional", icon: "transactional", chord: "t" },
  { to: "/domains", label: "Domains", icon: "domains", chord: "d" },
  { to: "/analytics", label: "Analytics", icon: "analytics", chord: "n" },
  { to: "/settings", label: "Settings", icon: "settings", chord: "s" },
]

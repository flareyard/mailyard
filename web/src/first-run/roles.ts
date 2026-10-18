/**
 * What each role can do, as the invite and roles designs word it (spec, "States and roles"; HAL-3361).
 */
import type { Role } from "../auth/session.ts"

export type { Role }

export const ROLE_SUMMARY: Record<Role, { can: string[]; cannot: string[]; table: string }> = {
  owner: {
    can: ["Everything, including members, domains and export", "Deleting the workspace"],
    cannot: [],
    table: "Everything, including members, domains, export and deleting the workspace",
  },
  admin: {
    can: ["Everything: members, domains, settings, every mailbox"],
    cannot: ["Removing the owner", "Deleting the workspace"],
    table: "Everything except removing the owner and deleting the workspace",
  },
  sender: {
    can: ["Audience, campaigns, automations and templates", "Their own mailboxes"],
    cannot: ["Domains, members and settings", "Deleting the workspace"],
    table: "Audience, campaigns, automations and templates; Their own mailboxes",
  },
  agent: {
    can: ["The shared mailboxes they’re given", "Contacts, read-only"],
    cannot: ["Campaigns and automations", "Domains, members and settings"],
    table: "The shared mailboxes they’re given; Contacts, read-only",
  },
  viewer: {
    can: ["Overview, Analytics and reports, read-only"],
    cannot: ["Sending, or changing anything"],
    table: "Overview, Analytics and reports, read-only",
  },
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  sender: "Sender",
  agent: "Agent",
  viewer: "Viewer",
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")

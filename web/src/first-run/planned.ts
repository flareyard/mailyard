/**
 * Calls to routes the backend has filed but not built (claim and invites, HAL-3361), so they aren't in the
 * generated schema. Shapes follow GAPS §1.10 and §1.12. Screens check `useCapabilities().has(...)` first and
 * never call these while the route is missing; when HAL-3361 deploys, `bun run api:types` replaces this file's
 * types with generated ones and the compiler points at every call site.
 */
import { ApiError, type ApiErrorBody } from "../api/client.ts"
import { fixtureFetch, fixturesEnabled } from "../fixtures/mode.ts"

export async function plannedCall<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const req = new Request(new URL(path, window.location.origin), {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const res = fixturesEnabled() ? await fixtureFetch(req) : await fetch(req)
  if (!res.ok) {
    let err: ApiErrorBody = {}
    try {
      err = (await res.json()) as ApiErrorBody
    } catch {
      err = { message: res.statusText }
    }
    throw new ApiError(res.status, err)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export type Role = "owner" | "admin" | "sender" | "agent" | "viewer"

/** `GET /v1/invites/{token}` (planned, HAL-3361). */
export type Invite = {
  token: string
  status: "valid" | "expired" | "used"
  workspace: { name: string; host: string | null }
  inviter: { name: string; email: string }
  email: string
  role: Role
  mailboxes: string[]
  expiresAt: string
  acceptedAt: string | null
  signedInAs?: string | null
}

/** What each role can do, as the invite and roles designs word it (spec, "States and roles"). */
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

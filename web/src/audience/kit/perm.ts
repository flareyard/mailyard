/**
 * Who may do what in Audience, Campaigns and Automations (HAL-3361). The API's own table
 * (`src/domain/permissions.ts`) is the authority and `/v1/me.permissions` is read from it, so the screens hide
 * exactly what the API would refuse. A key session whose `permissions` list is empty (sessions before HAL-3361,
 * and the fixture keys) is judged by the scope each permission needs, as the API judges keys.
 */
import type { Me, Role } from "../../auth/session.ts"

type Scope = "send" | "track" | "read" | "admin"

const ALL: readonly Role[] = ["owner", "admin", "sender", "agent", "viewer"]
const MANAGERS: readonly Role[] = ["owner", "admin"]
const SENDERS: readonly Role[] = ["owner", "admin", "sender"]
const READERS: readonly Role[] = ["owner", "admin", "sender", "viewer"]

/** The subset of the API's permission table these sections use, with the same roles and scopes. */
export const PERMISSIONS = {
  "contacts.read": { roles: ALL, scope: "read" },
  "contacts.write": { roles: SENDERS, scope: "admin" },
  "contacts.erase": { roles: MANAGERS, scope: "admin" },
  "campaigns.read": { roles: READERS, scope: "read" },
  "campaigns.write": { roles: SENDERS, scope: "admin" },
  "automations.read": { roles: READERS, scope: "read" },
  "automations.write": { roles: SENDERS, scope: "admin" },
  "templates.read": { roles: READERS, scope: "read" },
  "settings.write": { roles: MANAGERS, scope: "admin" },
  "domains.manage": { roles: MANAGERS, scope: "admin" },
} as const satisfies Record<string, { roles: readonly Role[]; scope: Scope }>

export type Permission = keyof typeof PERMISSIONS

/** Whether the signed-in caller holds a permission: by `/v1/me.permissions`, else by role, else by key scope. */
export function can(me: Me | undefined, p: Permission): boolean {
  if (!me) return false
  if (me.permissions.length) return me.permissions.includes(p)
  if (me.role) return (PERMISSIONS[p].roles as readonly Role[]).includes(me.role)
  if (me.via === "admin-key") return true
  return (me.scopes as readonly string[]).includes(PERMISSIONS[p].scope)
}

const PLURAL: Record<Role, string> = {
  owner: "owners",
  admin: "admins",
  sender: "senders",
  agent: "agents",
  viewer: "viewers",
}

/** “Owners, admins and senders can import contacts.”, or the scope a key needs while it signs in as a key. */
export function whoCanDo(me: Me | undefined, p: Permission, action: string): string {
  const rule = PERMISSIONS[p]
  if (me && !me.role && me.via !== "session-member") {
    return `Needs a key with the ${rule.scope} scope, or a person who is ${listRoles(rule.roles, "or")}.`
  }
  const names = listRoles(rule.roles, "and")
  return `${names.replace(/^./, (c) => c.toUpperCase())} can ${action}.`
}

function listRoles(roles: readonly Role[], joiner: "and" | "or"): string {
  const names = roles.map((r) => PLURAL[r])
  if (joiner === "or") {
    const singular = roles.map((r) => (r === "admin" ? "an admin" : `a${r === "owner" ? "n" : ""} ${r}`))
    return singular.length > 1
      ? `${singular.slice(0, -1).join(", ")} or ${singular[singular.length - 1]}`
      : (singular[0] ?? "")
  }
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : (names[0] ?? "")
}

/** The name a refusal uses for the caller: the key's name, or the person's role. */
export function callerName(me: Me | undefined): string {
  if (!me) return "you"
  if (me.user) return me.user.name
  if (me.key) return `the ${me.key.name} key`
  return "this key"
}

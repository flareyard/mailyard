/**
 * Who can open which ops section (HANDOFF-ops §1, §3): senders get Transactional but not Domains or Settings;
 * agents and viewers get Analytics only. Keys without a role are judged by scope (`roleAllows`).
 */
import { type Role, roleAllows } from "../auth/NoPermission.tsx"
import type { Me } from "../auth/session.ts"

export const TRANSACTIONAL: readonly Role[] = ["owner", "admin", "sender"]
export const ADMINS: readonly Role[] = ["owner", "admin"]
export const OWNER: readonly Role[] = ["owner"]

export const canOpenTransactional = (me: Me | undefined) => roleAllows(me, TRANSACTIONAL, "read")
export const canOpenAdmin = (me: Me | undefined) => roleAllows(me, ADMINS, "admin")
export const isAdmin = (me: Me | undefined) => roleAllows(me, ADMINS, "admin")
export const isOwner = (me: Me | undefined) =>
  me ? (me.role ? me.role === "owner" : me.via === "admin-key") : false
const ROLE_SCOPES: Record<Role, readonly string[]> = {
  owner: ["send", "track", "read", "admin"],
  admin: ["send", "track", "read", "admin"],
  sender: ["send", "track", "read"],
  agent: ["send", "read"],
  viewer: ["read"],
}

/**
 * Whether the caller holds a key scope. A person is judged by their role; a key by its own scopes, literally:
 * `admin` doesn't imply `read` (the CSV exports check `read` themselves, HANDOFF-ops §25).
 */
export function hasScope(me: Me | undefined, scope: "send" | "track" | "read" | "admin"): boolean {
  if (!me) return false
  if (me.via === "admin-key") return true
  if (me.role) return ROLE_SCOPES[me.role].includes(scope)
  return (me.scopes as readonly string[]).includes(scope)
}

import type { Caller, Scope } from "./apiKeys.ts"

/**
 * Who may do what (HAL-3361). Keys are checked by their scopes, exactly as before; people are
 * checked by their role. Every endpoint names both: the scope a key needs (unchanged) and the
 * permission a person needs. This table is the only place a role's rights are written down, and
 * `/v1/me.permissions` is read from it, so the app hides what the API would refuse.
 */

export const ROLES = ["owner", "admin", "sender", "agent", "viewer"] as const
export type Role = (typeof ROLES)[number]

const ALL: ReadonlyArray<Role> = ROLES
const MANAGERS: ReadonlyArray<Role> = ["owner", "admin"]
const SENDERS: ReadonlyArray<Role> = ["owner", "admin", "sender"]
const READERS: ReadonlyArray<Role> = ["owner", "admin", "sender", "viewer"]

/** Each permission: the roles that hold it, and the scope that gives it to a key. */
export const PERMISSIONS = {
  /** Read the mailboxes you can see (agents: only the ones they're given). */
  "mail.read": { roles: ALL, scope: "read" },
  /** Send and reply from the mailboxes you're given. */
  "mail.send": { roles: ["owner", "admin", "sender", "agent"], scope: "send" },
  /** Create and remove mailboxes, and choose who's in them. */
  "mail.manage": { roles: MANAGERS, scope: "admin" },
  /** Contacts, topics, forms, segments, suppressions, imports and exports: read. */
  "contacts.read": { roles: ALL, scope: "read" },
  /** …edit, import, export, bulk actions, entering automations. */
  "contacts.write": { roles: SENDERS, scope: "admin" },
  /** …erase a person, or lift a suppression. */
  "contacts.erase": { roles: MANAGERS, scope: "admin" },
  "campaigns.read": { roles: READERS, scope: "read" },
  "campaigns.write": { roles: SENDERS, scope: "admin" },
  "automations.read": { roles: READERS, scope: "read" },
  "automations.write": { roles: SENDERS, scope: "admin" },
  "templates.read": { roles: READERS, scope: "read" },
  "templates.write": { roles: SENDERS, scope: "admin" },
  /** The overview's charts, insights, the message log and sending health. */
  "analytics.read": { roles: READERS, scope: "read" },
  /** Domains, webhooks, alerts, brand, compliance and sending settings: read. */
  "settings.read": { roles: READERS, scope: "read" },
  /** …change them. */
  "settings.write": { roles: MANAGERS, scope: "admin" },
  "domains.manage": { roles: MANAGERS, scope: "admin" },
  "webhooks.manage": { roles: MANAGERS, scope: "admin" },
  "keys.manage": { roles: MANAGERS, scope: "admin" },
  /** Transactional sends through `/v1/send` and test sends. */
  "email.send": { roles: SENDERS, scope: "send" },
  "events.track": { roles: SENDERS, scope: "track" },
  /** The whole workspace in one export, settings and audit log included. */
  "exports.workspace": { roles: MANAGERS, scope: "admin" },
  /** Create agents (a mailbox and an MCP key) and set any key's send limits (HAL-3460). */
  "agents.manage": { roles: MANAGERS, scope: "admin" },
  /** Approve or reject sends held for approval (HAL-3460). */
  "approvals.manage": { roles: MANAGERS, scope: "admin" },
  /** Invite people, change roles, remove people. */
  "members.manage": { roles: MANAGERS, scope: "admin" },
  /** Hand ownership on; delete the workspace. */
  "workspace.owner": { roles: ["owner"], scope: "admin" },
} as const satisfies Record<string, { readonly roles: ReadonlyArray<Role>; readonly scope: Scope }>

export type Permission = keyof typeof PERMISSIONS

/** The scopes that stand in for a role where code still asks a caller for a scope. */
export const ROLE_SCOPES: Record<Role, ReadonlyArray<Scope>> = {
  owner: ["send", "track", "read", "admin"],
  admin: ["send", "track", "read", "admin"],
  sender: ["send", "track", "read"],
  agent: ["send", "read"],
  viewer: ["read"],
}

/** Roles that see every mailbox without being given it. Agents see only theirs. */
export const SEES_ALL_MAILBOXES: ReadonlySet<Role> = new Set(["owner", "admin", "sender", "viewer"])

/** Whether a caller holds a permission: a person by role, a key by the permission's scope. */
export const can = (caller: Caller, permission: Permission) => {
  const rule = PERMISSIONS[permission]
  if (caller.member) return (rule.roles as ReadonlyArray<Role>).includes(caller.member.role)
  return caller.scopes.includes(rule.scope)
}

export const allowedRoles = (permission: Permission): ReadonlyArray<Role> => PERMISSIONS[permission].roles

/** Every permission the caller holds, sorted: `/v1/me.permissions`. */
export const permissionsOf = (caller: Caller) =>
  (Object.keys(PERMISSIONS) as Array<Permission>).filter((p) => can(caller, p)).sort()

/** Whether the caller manages everything (the old "admin key" test): owner, admin, or an admin key. */
export const isManager = (caller: Caller) =>
  caller.member ? MANAGERS.includes(caller.member.role) : caller.scopes.includes("admin")

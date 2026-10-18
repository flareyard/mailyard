/**
 * Pure logic for Settings → Integrations: the MCP tools each scope unlocks, the connect snippets, agent status
 * and limits, and the mailbox-membership merge (PUT /v1/mailboxes/{id}/members replaces the whole list, so a
 * new key is added to what's there). Tested in logic.test.ts.
 */
import { num } from "../../lib/format.ts"

export type Scope = "send" | "track" | "read" | "admin"
export type Limits = {
  sendsPerDay: number | null
  recipients: "any" | "contacts" | "domains"
  allowDomains: string[]
  requireApproval: boolean
}

export type Tool = {
  name: string
  what: string
  scope: Exclude<Scope, "admin">
  effect: "read" | "draft" | "sends" | "event" | "writes"
  /** The issue that shipped it, when it came after the first ten (HAL-3303). */
  issue?: string
}

/**
 * The built MCP tools, from the server's tools/list (src/mcp/tools.ts): the first ten (HAL-3303), the agent tools
 * (HAL-3459) and wait_for_mail (HAL-3461), grouped by the scope that unlocks them.
 */
export const TOOLS: readonly Tool[] = [
  {
    name: "list_mailboxes",
    scope: "read",
    effect: "read",
    what: "The mailboxes this key can read: ids and addresses.",
  },
  {
    name: "search_mail",
    scope: "read",
    effect: "read",
    what: "Words, “phrases” and operators (from:, subject:, is:unread, before:…) in one mailbox or every readable one.",
  },
  {
    name: "read_thread",
    scope: "read",
    effect: "read",
    what: "A conversation with every message’s text, oldest first.",
  },
  {
    name: "preview_segment",
    scope: "read",
    effect: "read",
    what: "Who a segment filter matches: the count and a sample.",
  },
  {
    name: "campaign_stats",
    scope: "read",
    effect: "read",
    what: "A campaign’s report: sent, delivered, opened, clicked, bounced, complained, unsubscribed.",
  },
  {
    name: "contact_lookup",
    scope: "read",
    effect: "read",
    what: "A contact by email: status, fields, topics and recent activity.",
  },
  {
    name: "draft_reply",
    scope: "send",
    effect: "draft",
    what: "Writes a reply, reply-all or forward as a draft. Never sends.",
  },
  {
    name: "send_draft",
    scope: "send",
    effect: "sends",
    what: "Sends a draft from a mailbox after the undo window (10 s by default), so it can still be cancelled in the app.",
  },
  {
    name: "send_email",
    scope: "send",
    effect: "sends",
    what: "Sends one transactional email from an address on a sending domain. Not for newsletters.",
  },
  {
    name: "read_attachment",
    scope: "read",
    effect: "read",
    issue: "HAL-3459",
    what: "An attachment’s text: text, CSV and JSON as they are; PDF and Office documents converted to Markdown. Images aren’t read.",
  },
  {
    name: "wait_for_mail",
    scope: "read",
    effect: "read",
    issue: "HAL-3461",
    what: "Waits up to 50 s for new mail in a mailbox and returns it as soon as it arrives; pass the last cursor as since.",
  },
  {
    name: "mark_read",
    scope: "read",
    effect: "writes",
    issue: "HAL-3459",
    what: "Marks conversations read (or unread) in a mailbox this key can change.",
  },
  {
    name: "archive",
    scope: "read",
    effect: "writes",
    issue: "HAL-3459",
    what: "Moves conversations out of the inbox into the archive.",
  },
  {
    name: "label",
    scope: "read",
    effect: "writes",
    issue: "HAL-3459",
    what: "Adds a label to conversations (or removes it); a label that doesn’t exist yet is created.",
  },
  {
    name: "snooze",
    scope: "read",
    effect: "writes",
    issue: "HAL-3459",
    what: "Hides conversations until a time, when they come back to the inbox.",
  },
  {
    name: "move",
    scope: "read",
    effect: "writes",
    issue: "HAL-3459",
    what: "Moves conversations to a folder: inbox, archive, spam or trash.",
  },
  {
    name: "compose_message",
    scope: "send",
    effect: "draft",
    issue: "HAL-3459",
    what: "Writes a new message as a draft in a mailbox, with optional attachments. Nothing is sent: send_draft does that.",
  },
  {
    name: "track_event",
    scope: "track",
    effect: "event",
    what: "Records an event a contact did (signed_up, upgraded…), which segments and automations act on.",
  },
]

export type PlannedTool = {
  name: string
  what: string
  scope: Scope
  effect: "read" | "draft" | "sends" | "writes"
  issue: string
}

/** Tools filed but not built: HAL-3463 (more tools). Shown tagged, never offered. */
export const PLANNED_TOOLS: readonly PlannedTool[] = [
  {
    name: "list_templates",
    scope: "read",
    effect: "read",
    issue: "HAL-3463",
    what: "Templates with their published version and last edit.",
  },
  {
    name: "render_template",
    scope: "read",
    effect: "read",
    issue: "HAL-3463",
    what: "A template rendered with sample data: subject, HTML and text.",
  },
  {
    name: "list_segments",
    scope: "read",
    effect: "read",
    issue: "HAL-3463",
    what: "Saved segments and how many contacts each matches now.",
  },
  {
    name: "message_status",
    scope: "read",
    effect: "read",
    issue: "HAL-3463",
    what: "Where one sent message is: delivered, deferred, bounced, complained, with its events.",
  },
  {
    name: "list_alerts",
    scope: "read",
    effect: "read",
    issue: "HAL-3463",
    what: "Open alerts by severity, the same list as the bell.",
  },
  {
    name: "search_contacts",
    scope: "read",
    effect: "read",
    issue: "HAL-3463",
    what: "Contacts by email, name, field or topic.",
  },
  {
    name: "schedule_campaign",
    scope: "send",
    effect: "sends",
    issue: "HAL-3463",
    what: "Schedules a campaign. Without confirm: true it answers what would happen and sends nothing.",
  },
  {
    name: "pause_campaign",
    scope: "send",
    effect: "sends",
    issue: "HAL-3463",
    what: "Pauses a sending campaign. Without confirm: true it answers what would happen.",
  },
  {
    name: "audience writes",
    scope: "admin",
    effect: "writes",
    issue: "HAL-3463",
    what: "Create and update contacts and their topics. Admin scope for now; tool names not fixed.",
  },
]

export const SCOPE_INFO: Record<Scope, { label: string; sub: string }> = {
  read: { label: "Read", sub: "Read mail, search, contacts, segments and campaign reports." },
  send: { label: "Send", sub: "Draft replies and send. The two send tools need confirm: true." },
  track: { label: "Track", sub: "Record contact events." },
  admin: {
    label: "Admin",
    sub: "Every tool and every mailbox, whatever its memberships. Give it to people, not code.",
  },
}

/** The built tools a set of scopes unlocks: admin unlocks every one. */
export function toolsFor(scopes: readonly string[]): Tool[] {
  if (scopes.includes("admin")) return [...TOOLS]
  return TOOLS.filter((t) => scopes.includes(t.scope))
}

export const MCP_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const

export const mcpUrl = (origin: string) => `${origin.replace(/\/$/, "")}/mcp`

export const claudeAdd = (url: string, key: string) =>
  `claude mcp add --transport http mailyard ${url} --header "Authorization: Bearer ${key}"`

export const anyClient = (url: string, key: string) => `URL     ${url}\nHeader  Authorization: Bearer ${key}`

/** After a rotation the agent swaps its server entry: remove the old one, add the new key. */
export const claudeSwap = (url: string, key: string) => `claude mcp remove mailyard\n${claudeAdd(url, key)}`

/** Limits as the wire carries them (numbers may arrive as strings). */
export type WireLimits = {
  sendsPerDay: number | string | null
  recipients: Limits["recipients"]
  allowDomains: readonly string[]
  requireApproval: boolean
}

export function toLimits(l: WireLimits | null | undefined): Limits | null {
  if (!l) return null
  return {
    sendsPerDay: num(l.sendsPerDay),
    recipients: l.recipients,
    allowDomains: [...l.allowDomains],
    requireApproval: l.requireApproval,
  }
}

export type AgentLike = {
  key: { revoked: boolean } | null
  removedAt: number | string | null
}

export type AgentStatus = "active" | "removed" | "revoked"

/**
 * An agent is removed when `removedAt` is set, revoked when its key is (or it has none), otherwise active.
 * Pausing isn't in the API (no field, no route), so there's no paused state to read.
 */
export function agentStatus(a: AgentLike): AgentStatus {
  if (a.removedAt !== null && a.removedAt !== undefined) return "removed"
  if (!a.key || a.key.revoked) return "revoked"
  return "active"
}

/** How far through its daily cap an agent is, 0–100, or null when it has no cap. */
export function capPercent(
  sentToday: number | string,
  sendsPerDay: number | string | null | undefined,
): number | null {
  const cap = num(sendsPerDay ?? null)
  if (cap === null) return null
  if (cap === 0) return 100
  return Math.min(100, Math.round(((num(sentToday) ?? 0) / cap) * 100))
}

export const DEFAULT_LIMITS: Limits = {
  sendsPerDay: 50,
  recipients: "contacts",
  allowDomains: [],
  requireApproval: true,
}

/** A domain as the allow-list wants it: lower case, no scheme, no leading @ or dot, no path. */
export function normaliseDomain(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^[@.]+/, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "")
}

export const isDomain = (v: string) =>
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v)

/** Adds the domains typed into the chip input (commas, spaces or newlines between them), deduplicated. */
export function addDomains(
  current: readonly string[],
  typed: string,
): { domains: string[]; invalid: string[] } {
  const out = [...current]
  const invalid: string[] = []
  for (const raw of typed.split(/[\s,;]+/)) {
    if (!raw) continue
    const d = normaliseDomain(raw)
    if (!isDomain(d)) invalid.push(raw)
    else if (!out.includes(d)) out.push(d)
  }
  return { domains: out, invalid }
}

/** The limits form's problems, by field, or an empty object when it can be sent. */
export function limitsProblems(l: Limits): Partial<Record<keyof Limits, string>> {
  const p: Partial<Record<keyof Limits, string>> = {}
  if (
    l.sendsPerDay !== null &&
    (!Number.isInteger(l.sendsPerDay) || l.sendsPerDay < 0 || l.sendsPerDay > 100_000)
  )
    p.sendsPerDay = "A whole number from 0 to 100,000, or leave it empty for no cap."
  if (l.recipients === "domains" && l.allowDomains.length === 0)
    p.allowDomains = "Add at least one domain, or choose who else it can send to."
  if (l.allowDomains.length > 100) p.allowDomains = "At most 100 domains."
  return p
}

/** “50 sends a day, contacts only, approval on”. */
export function describeLimits(l: Limits | null): string {
  if (!l) return "No limits: bounded by its scopes and mailboxes only"
  const cap = l.sendsPerDay === null ? "no daily cap" : `${l.sendsPerDay.toLocaleString("en")} sends a day`
  const who =
    l.recipients === "any"
      ? "anyone"
      : l.recipients === "contacts"
        ? "contacts only"
        : `only ${l.allowDomains.join(", ") || "listed domains"}`
  return `${cap}, ${who}, approval ${l.requireApproval ? "on" : "off"}`
}

export type Access = "none" | "viewer" | "member"
type KeyMember = { apiKeyId: string; role: "owner" | "member" | "viewer" }
type PersonMember = { memberId: string; access: "owner" | "member" | "viewer" }
export type MemberEntry = KeyMember | PersonMember

/**
 * The body for PUT /v1/mailboxes/{id}/members that gives `keyId` the chosen access and leaves every other key
 * and person exactly as they were. `none` removes the key. Returns null when nothing changes.
 */
export function mergeMembers(
  current: { members: readonly KeyMember[]; people?: readonly PersonMember[] | null },
  keyId: string,
  access: Access,
): MemberEntry[] | null {
  const had = current.members.find((m) => m.apiKeyId === keyId)
  if (access === "none" && !had) return null
  if (had && access !== "none" && had.role === access) return null
  const keys: MemberEntry[] = current.members
    .filter((m) => m.apiKeyId !== keyId)
    .map((m) => ({ apiKeyId: m.apiKeyId, role: m.role }))
  if (access !== "none") keys.push({ apiKeyId: keyId, role: access })
  const people: MemberEntry[] = (current.people ?? []).map((p) => ({
    memberId: p.memberId,
    access: p.access,
  }))
  return [...keys, ...people]
}

/** The local part an agent's address starts with, suggested from its name: “Enrolment helper” → “enrolment-helper”. */
export function suggestLocal(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

export const isLocalPart = (v: string) => /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/i.test(v)

/** The short form a mailbox address takes in tight cells: “support@”. */
export const localOf = (address: string | null | undefined) => (address ? `${address.split("@")[0]}@` : "")

/** The long-poll an agent without a public URL runs (HAL-3461): wait up to `timeout` s for new mail. */
export const waitCurl = (origin: string, mailboxId: string) =>
  `curl -s "${origin.replace(/\/$/, "")}/v1/mailboxes/${mailboxId}/wait?timeout=50&since=$CURSOR" \\\n  -H "Authorization: Bearer $MAILYARD_KEY"`

export type ActivityKind = {
  label: string
  icon:
    | "mailbox"
    | "search"
    | "mail"
    | "paperclip"
    | "clock"
    | "send"
    | "pencil"
    | "check-circle"
    | "x-circle"
    | "pause"
    | "history"
  tone: "is-pass" | "is-warn" | "is-fail" | "is-info"
}

/** What an agent did, by audit action: its reads (`mcp.<tool>`, HAL-3461), its drafts, sends and holds. */
export function activityKind(action: string): ActivityKind {
  switch (action) {
    case "mcp.list_mailboxes":
      return { label: "Listed its mailboxes", icon: "mailbox", tone: "is-info" }
    case "mcp.search_mail":
      return { label: "Searched mail", icon: "search", tone: "is-info" }
    case "mcp.read_thread":
      return { label: "Read a thread", icon: "mail", tone: "is-info" }
    case "mcp.read_attachment":
      return { label: "Read an attachment", icon: "paperclip", tone: "is-info" }
    case "mcp.wait_for_mail":
      return { label: "Waited for mail", icon: "clock", tone: "is-info" }
  }
  if (/approval\.(request|hold|pending)/.test(action))
    return { label: "Held for approval", icon: "pause", tone: "is-warn" }
  if (action === "approval.approve") return { label: "Send approved", icon: "check-circle", tone: "is-pass" }
  if (action === "approval.reject") return { label: "Send rejected", icon: "x-circle", tone: "is-fail" }
  if (/refus|limit|not_allowed/.test(action)) return { label: "Refused", icon: "x-circle", tone: "is-fail" }
  if (/draft/.test(action)) return { label: "Drafted a reply", icon: "pencil", tone: "is-info" }
  if (/send|sent/.test(action)) return { label: "Sent", icon: "send", tone: "is-pass" }
  return { label: "", icon: "history", tone: "is-info" }
}

/** The ids and query an audited read carries in `after` (never content). */
export function readRefs(after: unknown): {
  mailboxId?: string
  threadId?: string
  messageId?: string
  attachmentId?: string
  query?: string
} {
  if (!after || typeof after !== "object") return {}
  const a = after as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const k of ["mailboxId", "threadId", "messageId", "attachmentId", "query"])
    if (typeof a[k] === "string" && a[k]) out[k] = a[k] as string
  return out
}

/** An https URL a webhook can post to (the API refuses anything else). */
export function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v.trim())
    return u.protocol === "https:" && Boolean(u.hostname)
  } catch {
    return false
  }
}

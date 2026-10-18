/**
 * Pure logic for the audit log (HAL-3376): the URL filters and the API query they become, the families the
 * action filter offers, a readable name for each action, where a target lives in the app, and the
 * before → after lines. Tested in logic.test.ts.
 */

export type AuditSearch = {
  actor?: string
  action?: string
  target?: string
  /** UTC dates, YYYY-MM-DD, inclusive. The API takes epoch ms. */
  from?: string
  to?: string
  cursor?: string
  open?: string
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const str = (v: unknown, max = 200) =>
  typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined

export function validateAudit(s: Record<string, unknown>): AuditSearch {
  const out: AuditSearch = {}
  const actor = str(s.actor)
  const action = str(s.action)
  const target = str(s.target)
  const from = str(s.from)
  const to = str(s.to)
  const cursor = str(s.cursor)
  const open = str(s.open)
  if (actor) out.actor = actor
  if (action) out.action = action
  if (target) out.target = target
  if (from && DATE.test(from)) out.from = from
  if (to && DATE.test(to)) out.to = to
  if (cursor) out.cursor = cursor
  if (open) out.open = open
  return out
}

/** A date's first millisecond, UTC. */
export const dayStart = (d: string) => Date.parse(`${d}T00:00:00.000Z`)
/** A date's last millisecond, UTC, so `to` includes the whole day. */
export const dayEnd = (d: string) => Date.parse(`${d}T23:59:59.999Z`)

/** The query GET /v1/audit takes for these filters (JSON or CSV). */
export function apiQuery(s: AuditSearch, format?: "csv"): Record<string, string> {
  const q: Record<string, string> = {}
  if (s.actor) q.actor = s.actor
  if (s.action) q.action = s.action
  if (s.target) q.target = s.target
  if (s.from) q.from = String(dayStart(s.from))
  if (s.to) q.to = String(dayEnd(s.to))
  if (s.cursor && !format) q.cursor = s.cursor
  if (!format) q.limit = "50"
  if (format) q.format = format
  return q
}

/** The filters as the shareable query string, without paging or the open drawer. */
export function viewString(s: AuditSearch): string {
  const u = new URLSearchParams()
  for (const k of ["actor", "action", "target", "from", "to"] as const) if (s[k]) u.set(k, s[k] as string)
  const v = u.toString()
  return v ? `?${v}` : "(every entry)"
}

export const FAMILIES: readonly { value: string; label: string }[] = [
  { value: "settings.", label: "Settings · every settings.* change" },
  { value: "key.", label: "API keys · key.*" },
  { value: "agent.", label: "Agents · agent.*" },
  { value: "approval.", label: "Approvals · approval.*" },
  { value: "member.", label: "Members · member.*" },
  { value: "invite.", label: "Invites · invite.*" },
  { value: "workspace.", label: "Workspace · workspace.*" },
  { value: "campaign.", label: "Campaigns · campaign.*" },
  { value: "automation.", label: "Automations · automation.*" },
  { value: "mailbox.", label: "Mailboxes · mailbox.*" },
  { value: "rule.", label: "Rules · rule.*" },
  { value: "domain.", label: "Domains · domain.*" },
  { value: "contact.", label: "Contacts · contact.*" },
  { value: "suppression.", label: "Suppressions · suppression.*" },
  { value: "segment.", label: "Segments · segment.*" },
  { value: "topic.", label: "Topics · topic.*" },
  { value: "form.", label: "Forms · form.*" },
  { value: "import.", label: "Mail imports · import.*" },
]

const NAMES: Readonly<Record<string, string>> = {
  "settings.brand": "Changed the brand",
  "settings.compliance": "Changed tracking and compliance",
  "settings.sending": "Changed sending settings",
  "key.limits": "Changed a key’s limits",
  "agent.create": "Created an agent",
  "agent.update": "Changed an agent",
  "agent.remove": "Removed an agent",
  "approval.approve": "Approved a held send",
  "approval.reject": "Rejected a held send",
  "workspace.claim": "Claimed the workspace",
  "workspace.transfer": "Transferred ownership",
  "workspace.export": "Exported the workspace",
  "workspace.delete.request": "Asked to delete the workspace",
  "workspace.delete.restore": "Restored the workspace",
  "member.update": "Changed a member",
  "member.remove": "Removed a member",
  "invite.create": "Drafted an invite",
  "invite.send": "Sent an invite",
  "invite.revoke": "Withdrew an invite",
  "invite.accept": "Accepted an invite",
  "mailbox.created": "Created a mailbox",
  "mailbox.updated": "Changed a mailbox",
  "mailbox.deleted": "Deleted a mailbox",
  "mailbox.members": "Changed a mailbox’s members",
  "domain.created": "Added a domain",
  "domain.updated": "Changed a domain",
  "domain.deleted": "Removed a domain",
  "domain.fixed": "Fixed a domain’s records",
  "campaign.create": "Created a campaign",
  "campaign.update": "Changed a campaign",
  "campaign.schedule": "Scheduled a campaign",
  "campaign.pause": "Paused a campaign",
  "campaign.resume": "Resumed a campaign",
  "campaign.cancel": "Cancelled a campaign",
  "campaign.delete": "Deleted a campaign",
  "campaign.resend": "Resent a campaign to non-openers",
  "message.send": "Sent a message",
  "test_send.start": "Started a test send",
  "export.started": "Started an export",
  "contacts.export": "Exported contacts",
  "contacts.import": "Imported contacts",
  "suppression.add": "Suppressed an address",
  "suppression.remove": "Removed a suppression",
  "rule.created": "Created a rule",
  "rule.updated": "Changed a rule",
  "rule.deleted": "Deleted a rule",
  "rule.reordered": "Reordered rules",
  "rule.applied": "Applied a rule to existing mail",
}

/** A sentence for an action: known ones by name, others from their words (“segment.create” → “Segment create”). */
export function actionName(action: string): string {
  const known = NAMES[action]
  if (known) return known
  const words = action.replace(/[._]+/g, " ").trim()
  return words ? words[0]?.toUpperCase() + words.slice(1) : action
}

/** Where a target lives in the app, from its type and id; null when the app has no page for it. */
export function targetRoute(target: { type: string | null; id: string } | null | undefined): string | null {
  if (!target) return null
  const { type, id } = target
  switch (type) {
    case "campaign":
      return `/campaigns/${id}`
    case "automation":
      return `/automations/${id}`
    case "domain":
      return `/domains/${id}`
    case "mailbox":
      return `/settings/mailboxes/${id}`
    case "segment":
      return `/audience/segments/${id}`
    case "import":
      return `/audience/imports/${id}`
    case "export":
      return `/audience/exports/${id}`
    case "message":
      return `/transactional/messages/${id}`
    case "template":
      return `/transactional/templates/${id}`
    case "webhook":
      return `/transactional/webhooks/${id}`
    case "agent":
      return `/settings/integrations/agents/${id}`
    case "settings":
      return id === "brand"
        ? "/settings/brand"
        : id === "compliance"
          ? "/settings/tracking"
          : "/settings/sending"
    default:
      return null
  }
}

const show = (v: unknown) => (v === undefined ? "new" : JSON.stringify(v))

/**
 * The fields that changed, each as before → after, for the row's one-line diff. Objects compare key by key;
 * anything else is one line under “value”. `before` absent reads “new”, `after` absent reads “removed”.
 */
export function diffLines(before: unknown, after: unknown): { key: string; from: string; to: string }[] {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v)
  if (before === undefined && after === undefined) return []
  if ((before === null || before === undefined) && (after === null || after === undefined)) return []
  if (isObj(before) || isObj(after)) {
    const b = isObj(before) ? before : {}
    const a = isObj(after) ? after : {}
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    return keys
      .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
      .map((k) => ({
        key: k,
        from: k in b ? show(b[k]) : "new",
        to: k in a ? show(a[k]) : "removed",
      }))
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  return [
    {
      key: "value",
      from: before === undefined || before === null ? "new" : show(before),
      to: after === undefined || after === null ? "removed" : show(after),
    },
  ]
}

/** Pretty JSON for the drawer's before and after, or a dash for nothing. */
export const pretty = (v: unknown) => (v === undefined || v === null ? "—" : JSON.stringify(v, null, 2))

/** Who acted, in words: a key by name, the admin key, or Mailyard itself. */
export function actorLabel(actor: { type: "key" | "root" | "system"; id: string; name: string }): {
  name: string
  sub: string
} {
  if (actor.type === "root") return { name: "Admin key", sub: "the deploy’s ADMIN_KEY" }
  if (actor.type === "system") return { name: "System", sub: "Mailyard itself" }
  return { name: actor.name || actor.id, sub: `key · ${actor.id}` }
}

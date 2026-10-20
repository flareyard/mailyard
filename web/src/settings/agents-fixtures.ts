/**
 * Fixture-mode overrides for Settings' integrations, agents, approvals, data, audit and danger zone (S-B),
 * registered in src/fixtures/overrides.ts and typed against the generated schema, so a contract change breaks
 * them at compile time. Bodies are the designs' sample data (settings/agent-*, integrations*, export-*,
 * audit*, danger*) in the live shapes.
 *
 * The Settings layout's `?fx=` picks a designed state, so every one is reachable by URL:
 *   integrations          empty · error · loading (the agent list); no-keys (the summary without keys.manage)
 *   integrations (lane)   mail-events-bad (saving answers 400 on mailboxIds) · lane-unavailable (no queue bound)
 *   alerts                empty · error · bad-target (saving answers 400 on the first webhook row)
 *   integrations/agents/… error · loading · new; the id `agt_missing` answers 404
 *   new agent sheet       the address `hermes@…` answers 409 (taken)
 *   approvals             empty · error · loading
 *   audit                 empty · error; paging with Older; `?actor=` filters
 *   data                  `?export=exp_running|exp_gaps|exp_failed|exp_ready`
 *   danger                aliases · export · catch-all (the 409 a mailbox delete answers); `?deleting=1` or
 *                         deleting the workspace makes /v1/workspace/deletion answer `scheduled`
 *   any page              owner · admin · sender (S-A's /v1/me override)
 */
import type { Answer, Json, Override } from "../fixtures/overrides.ts"
import { setFixtureDeleting } from "../ops/deletion.ts"

const fx = () =>
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("fx")
const here = () => (typeof window === "undefined" ? "" : window.location.pathname)
const on = (...pages: string[]) => pages.some((p) => here() === p || here().startsWith(`${p}/`))
const ok = (body: unknown, status = 200): Answer => ({ status, body })
const refusal = (
  status: number,
  tag: string,
  message: string,
  extra: Record<string, unknown> = {},
): Answer => ({
  status,
  body: { _tag: tag, message, requestId: "8d4c1f2a7b3e9d06-LHR", ...extra },
})
const hang = () => new Promise<Answer>(() => {}) as unknown as Answer
/** A pattern that only matches while `when()` holds, so another section's override for the same route wins elsewhere. */
class Scoped extends RegExp {
  constructor(
    re: RegExp,
    private readonly when: () => boolean,
  ) {
    super(re.source, re.flags)
  }
  override exec(s: string) {
    return this.when() ? super.exec(s) : null
  }
}

const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const ORIGIN = typeof window === "undefined" ? "https://mail.coursified.app" : window.location.origin

type Agent = Json<"/v1/agents/{id}", "get">
type Agents = Json<"/v1/agents", "get">
type Created = Json<"/v1/agents", "post">
type Approval = Json<"/v1/approvals", "get">["approvals"][number]
type AuditEntry = Json<"/v1/audit", "get">["entries"][number]
type Audit = Json<"/v1/audit", "get">
type Export = Json<"/v1/exports/{id}", "get">
type Exports = Json<"/v1/exports", "get">
type Draft = Json<"/v1/mailboxes/{id}/drafts/{draftId}", "get">
type MailImports = Json<"/v1/mailboxes/{id}/imports", "get">
type Imports = Json<"/v1/imports", "get">
type Deletion = Json<"/v1/workspace/deletion", "get">
type MailboxExports = Json<"/v1/mailboxes/{id}/exports", "get">

// ── Agents (HAL-3460) ────────────────────────────────────────────────────────────────────────────────────────
const AGENTS: Agent[] = [
  {
    id: "agt_hermes",
    name: "Hermes",
    mailbox: { id: "mbx_hermes", address: "hermes@coursified.app" },
    key: {
      id: "key_01JAH7HM",
      prefix: "sk_Hm4pQ8x",
      scopes: ["read", "send"],
      lastUsedAt: NOW - 4 * MIN,
      revoked: false,
    },
    limits: {
      sendsPerDay: 50,
      recipients: "domains",
      allowDomains: ["coursified.app", "gmail.com", "outlook.com", "yahoo.com"],
      requireApproval: true,
    },
    sentToday: 12,
    pendingApprovals: 2,
    createdAt: NOW - 15 * DAY,
    removedAt: null,
  },
  {
    id: "agt_enrol",
    name: "Enrolment helper",
    mailbox: { id: "mbx_enrol", address: "enrol@coursified.app" },
    key: {
      id: "key_01JAHAEN",
      prefix: "sk_En6tR3w",
      scopes: ["read", "send"],
      lastUsedAt: NOW - HOUR,
      revoked: false,
    },
    limits: { sendsPerDay: null, recipients: "contacts", allowDomains: [], requireApproval: false },
    sentToday: 3,
    pendingApprovals: 0,
    createdAt: NOW - 2 * DAY,
    removedAt: null,
  },
  {
    id: "agt_invoices",
    name: "Invoice bot",
    mailbox: { id: "mbx_invoices", address: "invoices@coursified.app" },
    key: {
      id: "key_01JAH8IB",
      prefix: "sk_Ib2wN5r",
      scopes: ["send"],
      lastUsedAt: NOW - 2 * DAY,
      revoked: false,
    },
    limits: { sendsPerDay: 20, recipients: "contacts", allowDomains: [], requireApproval: false },
    sentToday: 0,
    pendingApprovals: 0,
    createdAt: NOW - 30 * DAY,
    removedAt: null,
  },
  {
    id: "agt_summariser",
    name: "Old summariser",
    mailbox: { id: "mbx_summary", address: "summary@coursified.app" },
    key: {
      id: "key_01JA9OLD",
      prefix: "sk_Os7kL1p",
      scopes: ["read"],
      lastUsedAt: NOW - 22 * DAY,
      revoked: true,
    },
    limits: null,
    sentToday: 0,
    pendingApprovals: 0,
    createdAt: NOW - 60 * DAY,
    removedAt: NOW - 21 * DAY,
  },
]

const NEW_AGENT: Agent = {
  id: "agt_new",
  name: "Admissions helper",
  mailbox: { id: "mbx_admit", address: "admit@coursified.app" },
  key: {
    id: "key_01JAHNEW",
    prefix: "sk_Ad9kP2m",
    scopes: ["read", "send"],
    lastUsedAt: null,
    revoked: false,
  },
  limits: { sendsPerDay: 50, recipients: "contacts", allowDomains: [], requireApproval: true },
  sentToday: 0,
  pendingApprovals: 0,
  createdAt: NOW - 2 * MIN,
  removedAt: null,
}

const agentById = (id: string) =>
  id === NEW_AGENT.id || fx() === "new" ? { ...NEW_AGENT, id } : AGENTS.find((a) => a.id === id)

const created = (b: Record<string, unknown>): Created => {
  const address = String(b.address ?? "agent@coursified.app")
  const scopes = (Array.isArray(b.scopes) ? b.scopes : ["read", "send"]) as Agent["key"] extends infer K
    ? K extends { scopes: infer S }
      ? S
      : never
    : never
  const key = "sk_En6tR3wY8mQ2vK9pL4xB7cZd"
  const url = `${ORIGIN}/mcp`
  return {
    agent: {
      id: "agt_new",
      name: String(b.name ?? "Agent"),
      mailbox: { id: "mbx_new", address },
      key: { id: "key_01JAHAEN", prefix: "sk_En6tR3w", scopes, lastUsedAt: null, revoked: false },
      limits: (b.limits as Agent["limits"]) ?? null,
      sentToday: 0,
      pendingApprovals: 0,
      createdAt: Date.now(),
      removedAt: null,
    },
    key,
    mcp: {
      url,
      command: `claude mcp add --transport http mailyard ${url} --header "Authorization: Bearer ${key}"`,
    },
    // A posted wake URL makes an agent-wake webhook (HAL-3461), whose secret is shown once.
    wake:
      b.wake && typeof b.wake === "object" && "url" in b.wake
        ? { endpointId: "whk_wake_new", secret: "whsec_Wk7pR2mQ9xVt4LcN8bZs3HdFy6Jq" }
        : null,
  }
}

// ── Approvals ────────────────────────────────────────────────────────────────────────────────────────────────
const PENDING: Approval[] = [
  {
    id: "apr_01JAH9A1",
    keyId: "key_01JAH7HM",
    kind: "draft",
    mailboxId: "mbx_hermes",
    draftId: "drf_01JAH9A1",
    recipients: ["new.student@gmail.com"],
    subject: "Re: Can I pay in instalments?",
    from: "Hermes <hermes@coursified.app>",
    status: "pending",
    createdAt: NOW - 4 * MIN,
    decidedAt: null,
    decidedBy: null,
    reason: null,
    result: null,
  },
  {
    id: "apr_01JAH9A0",
    keyId: "key_01JAH7HM",
    kind: "transactional",
    mailboxId: null,
    draftId: null,
    recipients: ["kemi.b@outlook.com"],
    subject: "Your certificate name is updated",
    from: "Hermes <hermes@coursified.app>",
    status: "pending",
    createdAt: NOW - 31 * MIN,
    decidedAt: null,
    decidedBy: null,
    reason: null,
    result: null,
  },
]

const decided = (status: "approved" | "rejected" | "failed"): Approval[] => [
  {
    ...(PENDING[0] as Approval),
    id: `apr_${status}`,
    subject: status === "rejected" ? "Re: Discount for my cousin?" : "Re: Refund for Data foundations",
    recipients: [status === "rejected" ? "tunde.a@gmail.com" : "ada.okafor@gmail.com"],
    status,
    createdAt: NOW - 3 * HOUR,
    decidedAt: NOW - 2 * HOUR,
    decidedBy: "Halleluyah Oludele",
    reason: status === "rejected" ? "Don’t offer discounts; link the pricing page instead." : null,
    result: status === "failed" ? null : {},
  },
]

const DRAFTS: Record<string, string> = {
  drf_01JAH9A1:
    "Hi Tunde, yes: Data foundations can be paid in two instalments of ₦45,000, the first at enrolment and the second four weeks later. Reply here and I’ll send the link.",
}

const draft = (id: string): Draft =>
  ({
    id,
    threadId: "thr_01JAH9",
    inReplyTo: null,
    references: [],
    from: "Hermes <hermes@coursified.app>",
    to: [{ name: "Tunde", address: "new.student@gmail.com" }],
    cc: [],
    bcc: [],
    subject: "Re: Can I pay in instalments?",
    bodyText: DRAFTS[id] ?? "",
    bodyHtml: null,
    attachments: [],
    sendAt: null,
    status: "draft",
    createdAt: NOW - 5 * MIN,
    updatedAt: NOW - 4 * MIN,
  }) as unknown as Draft

// ── Audit log (HAL-3376) ─────────────────────────────────────────────────────────────────────────────────────
const ops = { type: "key" as const, id: "key_01JAE4OPS", name: "Ops laptop" }
const claude = { type: "key" as const, id: "key_01JAG2C5", name: "Claude Code (Halleluyah)" }
const hermes = { type: "key" as const, id: "key_01JAH7HM", name: "Hermes" }
const entry = (
  id: string,
  ago: number,
  actor: AuditEntry["actor"],
  via: AuditEntry["via"],
  action: string,
  target: AuditEntry["target"],
  before: unknown,
  after: unknown,
): AuditEntry => ({ id, at: NOW - ago, actor, via, ip: null, location: null, action, target, before, after })

const AUDIT: AuditEntry[] = [
  entry(
    "aud_0425",
    3 * MIN,
    hermes,
    "mcp",
    "mcp.wait_for_mail",
    { type: "mailbox", id: "mbx_hermes", label: "hermes@coursified.app" },
    undefined,
    { mailboxId: "mbx_hermes" },
  ),
  entry(
    "aud_0424",
    5 * MIN,
    hermes,
    "mcp",
    "mcp.read_attachment",
    { type: "mailbox", id: "mbx_hermes", label: "hermes@coursified.app" },
    undefined,
    { mailboxId: "mbx_hermes", messageId: "msg_01JAH8Q2", attachmentId: "att_01JAH8Q3" },
  ),
  entry(
    "aud_0423",
    5 * MIN + 20_000,
    hermes,
    "mcp",
    "mcp.read_thread",
    { type: "mailbox", id: "mbx_hermes", label: "hermes@coursified.app" },
    undefined,
    { mailboxId: "mbx_hermes", threadId: "thr_01JAH9" },
  ),
  entry(
    "aud_0422",
    6 * MIN,
    hermes,
    "mcp",
    "mcp.search_mail",
    { type: "mailbox", id: "mbx_hermes", label: "hermes@coursified.app" },
    undefined,
    { mailboxId: "mbx_hermes", query: "is:unread in:inbox" },
  ),
  entry(
    "aud_0421",
    7 * MIN,
    hermes,
    "mcp",
    "mcp.list_mailboxes",
    { type: "workspace", id: "workspace", label: null },
    undefined,
    {},
  ),
  entry(
    "aud_0420",
    4 * MIN,
    hermes,
    "mcp",
    "approval.request",
    { type: "message", id: "apr_01JAH9A1", label: "Re: Can I pay in instalments?" },
    undefined,
    { to: ["new.student@gmail.com"] },
  ),
  entry(
    "aud_0419",
    9 * MIN,
    { type: "root", id: "root", name: "" },
    null,
    "agent.update",
    { type: "agent", id: "agt_hermes", label: "Hermes" },
    { sendsPerDay: 30 },
    { sendsPerDay: 50 },
  ),
  entry(
    "aud_0418",
    14 * MIN,
    ops,
    "api",
    "settings.compliance",
    { type: "settings", id: "compliance", label: "Tracking and compliance" },
    { trackClicksDefault: null },
    { trackClicksDefault: true },
  ),
  entry(
    "aud_0417",
    38 * MIN,
    claude,
    "mcp",
    "message.send",
    { type: "message", id: "msg_01JAF017", label: "Re: Payment didn’t go through" },
    undefined,
    { to: "ada.okafor@gmail.com", from: "support@coursified.app" },
  ),
  entry(
    "aud_0416",
    55 * MIN,
    ops,
    "api",
    "settings.brand",
    { type: "settings", id: "brand", label: "Brand" },
    { "colors.indigo": "#2f5bd8" },
    { "colors.indigo": "#2E5BFF" },
  ),
  entry(
    "aud_0415",
    2 * HOUR,
    hermes,
    "mcp",
    "message.send",
    { type: "message", id: "msg_01JAF012", label: "Re: Refund for Data foundations" },
    undefined,
    { to: "ada.okafor@gmail.com", from: "hermes@coursified.app" },
  ),
  entry(
    "aud_0414",
    3 * HOUR,
    ops,
    "api",
    "campaign.schedule",
    { type: "campaign", id: "cmp_01JAE7", label: "Data foundations: enrolment opens" },
    { status: "draft" },
    { status: "scheduled", sendAt: "2026-10-20T08:00:00Z" },
  ),
  entry(
    "aud_0413",
    5 * HOUR,
    ops,
    "api",
    "key.limits",
    { type: "apiKey", id: "key_01JAH8IB", label: "Invoice bot" },
    null,
    { sendsPerDay: 20, recipients: "contacts" },
  ),
  entry(
    "aud_0412",
    9 * HOUR,
    { type: "system", id: "system", name: "" },
    null,
    "domain.updated",
    { type: "domain", id: "dom_01", label: "coursified.app" },
    { checkStatus: "warn" },
    { checkStatus: "pass" },
  ),
  entry(
    "aud_0411",
    20 * HOUR,
    ops,
    "api",
    "mailbox.members",
    { type: "mailbox", id: "mbx_support", label: "support@coursified.app" },
    { members: 2 },
    { members: 3 },
  ),
]
const AUDIT_OLDER: AuditEntry[] = [
  entry(
    "aud_0410",
    2 * DAY,
    ops,
    "api",
    "agent.create",
    { type: "agent", id: "agt_enrol", label: "Enrolment helper" },
    undefined,
    { address: "enrol@coursified.app" },
  ),
  entry(
    "aud_0409",
    3 * DAY,
    ops,
    "api",
    "workspace.export",
    { type: "export", id: "exp_ready", label: "Workspace export" },
    undefined,
    { kind: "workspace" },
  ),
  entry(
    "aud_0408",
    5 * DAY,
    { type: "root", id: "root", name: "" },
    null,
    "invite.send",
    { type: "invite", id: "inv_01JA9T", label: "tolu@coursified.app" },
    undefined,
    { sendCount: 1 },
  ),
]

function audit(url: URL): Answer {
  const s = fx()
  if (s === "error") return refusal(500, "InternalError", "The audit log couldn’t be read.")
  if (s === "empty") return ok({ entries: [], nextCursor: null } satisfies Audit)
  if (s === "loading") return hang()
  const q = url.searchParams
  const older = q.get("cursor") === "aud_0410"
  let list = [...(older ? AUDIT_OLDER : AUDIT)].sort((a, b) => Number(b.at) - Number(a.at))
  const actor = q.get("actor")
  const action = q.get("action")
  const target = q.get("target")
  const from = Number(q.get("from") ?? Number.NaN)
  const to = Number(q.get("to") ?? Number.NaN)
  if (actor) list = list.filter((e) => e.actor.id === actor)
  if (action)
    list = list.filter((e) =>
      action.endsWith(".") || action.endsWith(".*")
        ? e.action.startsWith(action.replace(/\*$/, ""))
        : e.action === action,
    )
  if (target) list = list.filter((e) => e.target?.id === target)
  if (Number.isFinite(from)) list = list.filter((e) => Number(e.at) >= from)
  if (Number.isFinite(to)) list = list.filter((e) => Number(e.at) <= to)
  const body: Audit = { entries: list, nextCursor: older || actor || action || target ? null : "aud_0410" }
  return ok(body)
}

// ── Exports (HAL-3451) ───────────────────────────────────────────────────────────────────────────────────────
const PARTS: NonNullable<Export["parts"]> = [
  ["mail", "mbox", "mail/support@coursified.app.mbox", 51, 325_000, "mbx_support"],
  ["mail", "mbox", "mail/hello@coursified.app.mbox", 34, 212_000, "mbx_hello"],
  ["mail", "mbox", "mail/halleluyah@coursified.app.mbox", 19, 141_000, "mbx_founder"],
  ["mail", "mbox", "mail/admissions@coursified.app.mbox", 8, 46_000, "mbx_admissions"],
  ["mail", "mbox", "mail/billing@coursified.app.mbox", 5, 21_000, "mbx_billing_box"],
  ["contacts", "csv", "contacts.csv", 5, 1_900, null],
  ["templates", "json", "templates.json", 8, 38_000, null],
  ["lists", "json", "lists.json", 11, 4_200, null],
  ["settings", "json", "settings.json", 1, 6_800, null],
  ["audit", "json", "audit.json", 45, 29_000, null],
  ["manifest", "json", "manifest.json", 11, 2_100, null],
].map(([kind, format, filename, items, bytes, mailboxId]) => ({
  kind: kind as NonNullable<Export["parts"]>[number]["kind"],
  format: format as NonNullable<Export["parts"]>[number]["format"],
  filename: filename as string,
  items: items as number,
  bytes: bytes as number,
  status: "complete" as const,
  error: null,
  mailboxId: mailboxId as string | null,
  url: `${ORIGIN}/v1/exports/exp_01JAH4WS/parts/${filename}?expires=${Math.round((NOW + DAY) / 1000)}&sig=fixture`,
}))

function workspaceExport(id: string): Export {
  const base: Export = {
    id,
    kind: "workspace",
    status: "completed",
    rows: 0,
    processed: 11,
    total: 11,
    createdBy: "usr_01JA3Q9C4T",
    fields: [],
    filename: "manifest.json",
    url: PARTS[10]?.url ?? null,
    error: null,
    createdAt: NOW - 7 * MIN,
    finishedAt: NOW - 7 * MIN + 124_000,
    parts: PARTS,
  }
  if (id === "exp_running")
    return {
      ...base,
      status: "running",
      processed: 4,
      url: null,
      createdAt: NOW - 20_000,
      finishedAt: null,
      parts: PARTS.map((p, i) =>
        i < 4 ? { ...p, url: null } : { ...p, status: "pending" as const, bytes: 0, url: null },
      ),
    }
  if (id === "exp_gaps")
    return {
      ...base,
      error: "2 parts failed: mail/support@coursified.app.mbox, audit.json",
      parts: PARTS.map((p) =>
        p.filename === "mail/support@coursified.app.mbox"
          ? {
              ...p,
              status: "failed" as const,
              bytes: 0,
              url: null,
              error: "Reading the mailbox store timed out after 30 s.",
            }
          : p.filename === "audit.json"
            ? {
                ...p,
                status: "failed" as const,
                bytes: 0,
                url: null,
                error: "D1 query timed out reading the audit log.",
              }
            : p,
      ),
    }
  if (id === "exp_failed")
    return {
      ...base,
      status: "failed",
      processed: 0,
      url: null,
      finishedAt: NOW - 7 * MIN + 9_000,
      error: "The export stopped before any part was written: the exports bucket refused the write (R2 403).",
      parts: PARTS.map((p) => ({ ...p, status: "pending" as const, bytes: 0, url: null })),
    }
  return base
}

const EXPORTS: Exports = {
  exports: [
    { ...workspaceExport("exp_ready"), url: null, parts: PARTS.map((p) => ({ ...p, url: null })) },
    {
      id: "exp_01JAF1CT",
      kind: "contacts",
      status: "completed",
      rows: 4812,
      processed: 4812,
      total: 4812,
      createdBy: "key_01JA4B7Q2M",
      fields: [],
      filename: "contacts-2026-10-14.csv",
      url: null,
      error: null,
      createdAt: NOW - 3 * DAY,
      finishedAt: NOW - 3 * DAY + 8_000,
      parts: null,
    },
  ],
  nextCursor: null,
}

const folder = {
  name: "INBOX",
  folder: "INBOX",
  label: null,
  uidValidity: 1,
  source: 0,
  imported: 0,
  duplicates: 0,
  failed: 0,
  lastUid: 0,
  batches: 1,
  batchesDone: 1,
  lastError: null,
  retryable: 0,
}
const mailImport = (mailboxId: string): MailImports => {
  const base = {
    source: "imap" as const,
    mode: "full" as const,
    port: 993,
    username: null,
    accountedFor: true,
    ratePerMinute: null,
    etaAt: null,
    pausedAt: null,
    catchupOf: null,
    since: null,
    retryOf: null,
    credentialsHeld: false,
  }
  if (mailboxId === "mbx_hello")
    return {
      imports: [
        {
          ...base,
          id: "imp_hello",
          host: "imap.hostinger.com",
          status: "complete",
          error: null,
          folders: [{ ...folder, source: 3226, imported: 3214, duplicates: 12 }],
          totals: { source: 3226, imported: 3214, duplicates: 12, failed: 0, skipped: 0 },
          startedAt: NOW - DAY - 21 * HOUR,
          createdAt: NOW - DAY - 21 * HOUR,
          finishedAt: NOW - DAY - 20 * HOUR,
        },
      ],
    } as unknown as MailImports
  if (mailboxId === "mbx_founder")
    return {
      imports: [
        {
          ...base,
          id: "imp_founder",
          host: "imap.gmail.com",
          status: "failed",
          error: "Gmail rejected the app password after folder “Archive”.",
          folders: [{ ...folder, source: 2400, imported: 1906, failed: 12, retryable: 12 }],
          totals: { source: 2400, imported: 1906, duplicates: 0, failed: 12, skipped: 0 },
          startedAt: NOW - 2 * DAY,
          createdAt: NOW - 2 * DAY,
          finishedAt: NOW - 2 * DAY + HOUR,
        },
      ],
    } as unknown as MailImports
  return { imports: [] }
}

const IMPORTS = {
  imports: [
    {
      id: "imp_03",
      uploadId: "upl_01J9X2",
      fileName: "plunk-export.csv",
      fileSize: 412_000,
      status: "completed",
      mapping: { Email: "email" },
      topicIds: [],
      onConflict: "update",
      defaultStatus: "subscribed",
      headers: ["Email"],
      rows: 4612,
      created: 4540,
      updated: 41,
      skipped: 0,
      invalid: 31,
      duplicates: 0,
      suppressed: 0,
      errors: [],
      errorsTotal: 31,
      processed: 4612,
      bytesRead: 412_000,
      size: 412_000,
      ratePerMinute: null,
      etaAt: null,
      consent: null,
      error: null,
      createdAt: NOW - 20 * DAY,
      startedAt: NOW - 20 * DAY,
      finishedAt: NOW - 20 * DAY + 60_000,
    },
  ],
  nextCursor: null,
} satisfies Imports

// ── Danger zone (HAL-3376, HAL-3448) ─────────────────────────────────────────────────────────────────────────
const DELETING_KEY = "mailyard-fixture-deleting"
const deletesAt = () => {
  try {
    const v = Number(sessionStorage.getItem(DELETING_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

function deletion(): Deletion {
  const at = deletesAt()
  if (!at) return { status: "none", deletion: null, files: [] }
  return {
    status: "scheduled",
    deletion: {
      requestedAt: at - 7 * DAY,
      requestedBy: "Halleluyah Oludele",
      deletesAt: at,
      exportId: "exp_ready",
    },
    files: [],
  }
}

const MAILBOX_EXPORTS: MailboxExports = {
  exports: [
    {
      id: "mbe_01",
      status: "complete",
      format: "both",
      messageCount: 1906,
      size: 261_000_000,
      zipSize: 248_000_000,
      error: null,
      downloads: { mbox: `${ORIGIN}/v1/files/fixture-mbox`, zip: `${ORIGIN}/v1/files/fixture-zip` },
      downloadsExpireAt: NOW + DAY,
      createdAt: NOW - 4 * MIN,
      completedAt: NOW - 2 * MIN,
    },
  ],
}

const MAILBOX_409: Record<string, Answer> = {
  aliases: refusal(
    409,
    "Conflict",
    "team@coursified.app still delivers to halleluyah@coursified.app; change it first.",
    {
      reason: "alias-targets",
      aliasIds: ["mbx_team"],
    },
  ),
  export: refusal(
    409,
    "Conflict",
    "halleluyah@coursified.app holds 1906 messages that no export covers yet. Export it (POST /v1/mailboxes/mbx_founder/exports), then remove it.",
    { reason: "no-recent-export" },
  ),
  "catch-all": refusal(
    409,
    "Conflict",
    "coursified.app keeps unknown mail in halleluyah@coursified.app; set its catch-all policy to bounce first.",
    {
      reason: "catch-all-keeps",
    },
  ),
}

// ── Alerts (HAL-3465) ────────────────────────────────────────────────────────────────────────────────────────
type AlertSettings = Json<"/v1/settings/alerts", "get">
type AlertChannel = AlertSettings["channels"][number]
const OWNER_EMAIL = "halleluyah@coursified.app"
let alertChannels: AlertChannel[] = [
  { kind: "email", target: "ops@coursified.app", minSeverity: "warning" },
  {
    kind: "webhook",
    target: "whk_01",
    kinds: ["reputation_at_risk", "reputation_warning", "quota_100", "webhook_dead_letter"],
    minSeverity: "critical",
  },
]
let alertDefault: string | null = null
const alertSettings = (channels: AlertChannel[], defaultEmail: string | null): AlertSettings => ({
  channels,
  defaultEmail,
  effective: {
    criticalEmail: defaultEmail ?? OWNER_EMAIL,
    note: channels.length
      ? null
      : `No channels yet: critical alerts go to ${defaultEmail ?? `the owner, ${OWNER_EMAIL}`}; everything else stays in the bell.`,
  },
})
const ALERT_PAGES = ["/settings/alerts", "/settings/integrations"]

// ── Hermes lane (HAL-3306) ───────────────────────────────────────────────────────────────────────────────────
type MailEvents = Json<"/v1/settings/mail-events", "get">
let mailEvents: MailEvents = {
  enabled: true,
  mailboxIds: ["mbx_support", "mbx_hermes"],
  types: null,
  since: NOW - 16 * DAY,
  queue: "mailyard-mail-events",
  version: 3,
  available: true,
}

// ── Linked apps (HAL-3466) ───────────────────────────────────────────────────────────────────────────────────
type Integrations = Json<"/v1/integrations", "get">
const integrations = (withKeys: boolean): Integrations => ({
  mcp: {
    endpoint: `${ORIGIN}/mcp`,
    keyCount: 4,
    agentCount: 3,
    lastUsedAt: NOW - 4 * MIN,
    keys: withKeys
      ? [
          {
            id: "key_01JAH7HM",
            name: "Hermes",
            prefix: "sk_Hm4pQ8x",
            scopes: ["read", "send"],
            lastUsedAt: NOW - 4 * MIN,
            createdAt: NOW - 15 * DAY,
            agent: {
              id: "agt_hermes",
              name: "Hermes",
              mailboxId: "mbx_hermes",
              address: "hermes@coursified.app",
            },
          },
          {
            id: "key_01JAHAEN",
            name: "Enrolment helper",
            prefix: "sk_En6tR3w",
            scopes: ["read", "send"],
            lastUsedAt: NOW - HOUR,
            createdAt: NOW - 2 * DAY,
            agent: {
              id: "agt_enrol",
              name: "Enrolment helper",
              mailboxId: "mbx_enrol",
              address: "enrol@coursified.app",
            },
          },
          {
            id: "key_01JAH8IB",
            name: "Invoice bot",
            prefix: "sk_Ib2wN5r",
            scopes: ["send"],
            lastUsedAt: NOW - 2 * DAY,
            createdAt: NOW - 30 * DAY,
            agent: {
              id: "agt_invoices",
              name: "Invoice bot",
              mailboxId: "mbx_invoices",
              address: "invoices@coursified.app",
            },
          },
          {
            id: "key_01JAG2C5",
            name: "Claude Code (Halleluyah)",
            prefix: "sk_Q4n8rWz",
            scopes: ["read", "send"],
            lastUsedAt: NOW - HOUR,
            createdAt: NOW - 3 * DAY,
            agent: null,
          },
        ]
      : null,
  },
  // MCP clients that signed in with OAuth (HAL-3462): each grant is backed by a key it minted.
  oauth: {
    authorizationServer: ORIGIN,
    grants: withKeys
      ? [
          {
            id: "grt_01JAH7Q2",
            client: { id: "https://claude.ai/oauth/mcp", name: "Claude", host: "claude.ai", registration: "cimd" },
            grantedBy: { id: "mem_01JAOWNR", name: "Tolu Adeyemi", email: "tolu@coursified.app" },
            apiKeyId: "key_01JAG2C5",
            scopes: ["read", "send"],
            mailboxIds: ["mbx_support"],
            createdAt: NOW - 3 * DAY,
            lastUsedAt: NOW - HOUR,
          },
        ]
      : [],
  },
  webhooks: {
    count: 3,
    enabled: 3,
    paused: 0,
    failing: 1,
    deadLetters: 3,
    held: 0,
    failingEndpoints: [
      {
        id: "whk_01",
        url: "https://api.coursified.app/hooks/mail",
        deadLetters: 3,
        lastFailureAt: NOW - 11 * MIN,
        lastSuccessAt: NOW - 4 * HOUR,
      },
    ],
  },
  hermes: {
    connected: true,
    lane: "email",
    mailboxes: ["support@coursified.app", "hermes@coursified.app"],
    allMailboxes: false,
    available: true,
    since: NOW - 16 * DAY,
  },
  siblings: [
    { app: "hermes", name: "Hermes", via: "queue", connected: true, keyId: null, lastUsedAt: NOW - 4 * MIN },
    {
      app: "support-inbox",
      name: "Support Inbox",
      via: "mcp",
      connected: false,
      keyId: null,
      lastUsedAt: null,
    },
  ],
})

const AGENT_PAGES = ["/settings/integrations"]
const DATA = ["/settings/data"]
const DANGER = ["/settings/danger"]
const AUDIT_PAGES = ["/settings/audit", "/settings/integrations/agents"]

export const SETTINGS_AGENTS_OVERRIDES: readonly Override[] = [
  // Hermes lane
  {
    method: "GET",
    path: new Scoped(/^\/v1\/settings\/mail-events$/, () => on(...AGENT_PAGES)),
    answer: () => {
      const s = fx()
      if (s === "error") return refusal(500, "InternalError", "The mail-events settings couldn’t be read.")
      if (s === "lane-unavailable")
        return ok({ ...mailEvents, enabled: false, since: null, available: false })
      return ok(mailEvents)
    },
  },
  {
    method: "PUT",
    path: new Scoped(/^\/v1\/settings\/mail-events$/, () => on(...AGENT_PAGES)),
    answer: (_, body) => {
      const b = (body ?? {}) as {
        enabled?: boolean
        mailboxIds?: string[] | null
        types?: MailEvents["types"]
      }
      if (fx() === "mail-events-bad")
        return refusal(400, "InvalidRequest", `No mailbox ${(b.mailboxIds ?? ["mbx_gone"]).at(-1)}.`, {
          field: "mailboxIds",
        })
      mailEvents = {
        ...mailEvents,
        enabled: Boolean(b.enabled),
        mailboxIds: b.mailboxIds ?? null,
        types: b.types ?? null,
        since: b.enabled ? (mailEvents.enabled ? mailEvents.since : Date.now()) : null,
        version: Number(mailEvents.version) + 1,
      }
      return ok(mailEvents)
    },
  },
  // Linked apps
  {
    method: "GET",
    path: new Scoped(/^\/v1\/integrations$/, () => on(...AGENT_PAGES)),
    answer: () => {
      const s = fx()
      if (s === "error") return refusal(500, "InternalError", "The integrations summary couldn’t be read.")
      if (s === "loading") return hang()
      return ok(integrations(s !== "no-keys"))
    },
  },
  // Alerts
  {
    method: "GET",
    path: new Scoped(/^\/v1\/settings\/alerts$/, () => on(...ALERT_PAGES)),
    answer: () => {
      const s = fx()
      if (s === "error") return refusal(500, "InternalError", "The alert settings couldn’t be read.")
      if (s === "loading") return hang()
      if (s === "empty") return ok(alertSettings([], null))
      return ok(alertSettings(alertChannels, alertDefault))
    },
  },
  {
    method: "PUT",
    path: new Scoped(/^\/v1\/settings\/alerts$/, () => on(...ALERT_PAGES)),
    answer: (_, body) => {
      const b = (body ?? {}) as { channels?: AlertChannel[]; defaultEmail?: string | null }
      const channels = b.channels ?? []
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      // `?fx=bad-target` refuses the first webhook channel as the API does for an unknown endpoint.
      const bad =
        fx() === "bad-target"
          ? channels.findIndex((c) => c.kind === "webhook")
          : channels.findIndex((c) => c.kind === "email" && !email.test(c.target))
      const at = bad >= 0 ? channels[bad] : undefined
      if (at)
        return refusal(
          400,
          "InvalidRequest",
          at.kind === "webhook"
            ? `No webhook endpoint ${at.target}.`
            : `${at.target} isn’t an email address.`,
          { field: `channels[${bad}].target` },
        )
      if (b.defaultEmail && !email.test(b.defaultEmail))
        return refusal(400, "InvalidRequest", `${b.defaultEmail} isn’t an email address.`, {
          field: "defaultEmail",
        })
      alertChannels = channels
      alertDefault = b.defaultEmail ?? null
      return ok(alertSettings(alertChannels, alertDefault))
    },
  },
  // Agents
  {
    method: "GET",
    path: new Scoped(/^\/v1\/agents$/, () => on(...AGENT_PAGES)),
    answer: () => {
      const s = fx()
      if (s === "error") return refusal(500, "InternalError", "The agents couldn’t be read.")
      if (s === "loading") return hang()
      return ok({ agents: s === "empty" ? [] : AGENTS } satisfies Agents)
    },
  },
  {
    method: "GET",
    path: /^\/v1\/agents\/([^/]+)$/,
    answer: ([, id = ""]) => {
      const s = fx()
      if (s === "error") return refusal(500, "InternalError", "The agent couldn’t be read.")
      if (s === "loading") return hang()
      const a = agentById(id)
      return a ? ok(a) : refusal(404, "NotFound", `No agent ${id}.`)
    },
  },
  {
    method: "POST",
    path: /^\/v1\/agents$/,
    answer: (_, body) => {
      const b = (body ?? {}) as Record<string, unknown>
      const address = String(b.address ?? "")
      if (address.startsWith("hermes@"))
        return refusal(409, "Conflict", `${address} already exists. Pick another address.`, {
          reason: "address-taken",
        })
      return ok(created(b))
    },
  },
  {
    method: "PATCH",
    path: /^\/v1\/agents\/([^/]+)$/,
    answer: ([, id = ""], body) => {
      const a = agentById(id)
      if (!a) return refusal(404, "NotFound", `No agent ${id}.`)
      const b = (body ?? {}) as { name?: string; limits?: Agent["limits"] }
      return ok({
        ...a,
        ...(b.name ? { name: b.name } : {}),
        ...("limits" in b ? { limits: b.limits ?? null } : {}),
      })
    },
  },
  {
    method: "DELETE",
    path: /^\/v1\/agents\/([^/]+)$/,
    answer: ([, id = ""]) => {
      const a = agentById(id)
      if (!a) return refusal(404, "NotFound", `No agent ${id}.`)
      return ok({
        ...a,
        key: a.key ? { ...a.key, revoked: true } : null,
        pendingApprovals: 0,
        removedAt: Date.now(),
      })
    },
  },
  // Approvals
  {
    method: "GET",
    path: /^\/v1\/approvals$/,
    answer: (_, __, url) => {
      const s = fx()
      if (on("/settings/integrations/approvals")) {
        if (s === "error") return refusal(500, "InternalError", "The approval queue couldn’t be read.")
        if (s === "loading") return hang()
        if (s === "empty") return ok({ approvals: [] })
      }
      const status = url.searchParams.get("status") ?? "pending"
      return ok({
        approvals: status === "pending" ? PENDING : decided(status as "approved" | "rejected" | "failed"),
      })
    },
  },
  {
    method: "POST",
    path: /^\/v1\/approvals\/([^/]+)\/(approve|reject)$/,
    answer: ([, id = "", verb], body) => {
      const a = PENDING.find((p) => p.id === id)
      if (!a) return refusal(409, "Conflict", "This send was already decided.", { reason: "decided" })
      const reason = (body as { reason?: string } | null)?.reason ?? null
      return ok({
        ...a,
        status: verb === "approve" ? "approved" : "rejected",
        decidedAt: Date.now(),
        decidedBy: "Halleluyah Oludele",
        reason: verb === "reject" ? reason : null,
        result: verb === "approve" ? {} : null,
      } satisfies Approval)
    },
  },
  {
    method: "GET",
    path: new Scoped(/^\/v1\/mailboxes\/[^/]+\/drafts\/([^/]+)$/, () =>
      on("/settings/integrations/approvals"),
    ),
    answer: ([, id = ""]) => (DRAFTS[id] ? ok(draft(id)) : refusal(404, "NotFound", "No such draft.")),
  },
  // Audit
  {
    method: "GET",
    path: new Scoped(/^\/v1\/audit$/, () => on(...AUDIT_PAGES)),
    answer: (_, __, url) => audit(url),
  },
  // Import and export
  {
    method: "GET",
    path: new Scoped(/^\/v1\/exports$/, () => on(...DATA)),
    answer: () => ok(EXPORTS),
  },
  {
    method: "GET",
    path: new Scoped(/^\/v1\/exports\/([^/]+)$/, () => on(...DATA, ...DANGER)),
    answer: ([, id = ""]) => ok(workspaceExport(id)),
  },
  {
    method: "POST",
    path: new Scoped(/^\/v1\/exports$/, () => on(...DATA)),
    answer: () => ok(workspaceExport("exp_running")),
  },
  {
    method: "GET",
    path: new Scoped(/^\/v1\/imports$/, () => on(...DATA)),
    answer: () => ok(IMPORTS),
  },
  {
    method: "GET",
    path: new Scoped(/^\/v1\/mailboxes\/([^/]+)\/imports$/, () => on(...DATA)),
    answer: ([, id = ""]) => ok(mailImport(id)),
  },
  {
    method: "POST",
    path: new Scoped(/^\/v1\/mailboxes\/[^/]+\/imports\/[^/]+\/resume$/, () => on(...DATA)),
    answer: () => ok({}),
  },
  // Danger zone
  {
    method: "GET",
    path: /^\/v1\/workspace\/deletion$/,
    answer: () => ok(deletion()),
  },
  {
    method: "DELETE",
    path: /^\/v1\/workspace$/,
    answer: (_, body) => {
      const confirm = (body as { confirm?: string } | null)?.confirm
      if (confirm !== "Coursified")
        return refusal(400, "InvalidRequest", "Type the workspace’s name exactly to delete it.", {
          reason: "name-mismatch",
        })
      const at = Date.now() + 7 * DAY
      setFixtureDeleting(at)
      return {
        status: 202,
        body: {
          requestedAt: Date.now(),
          requestedBy: "Halleluyah Oludele",
          deletesAt: at,
          exportId: "exp_ready",
        },
        headers: { "x-workspace-deleting": new Date(at).toISOString() },
      }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/workspace\/restore$/,
    answer: () => {
      if (!deletesAt())
        return refusal(409, "Conflict", "The workspace isn’t being deleted.", { reason: "not-deleting" })
      setFixtureDeleting(null)
      return ok({ restored: true })
    },
  },
  {
    method: "DELETE",
    path: new Scoped(/^\/v1\/mailboxes\/([^/]+)$/, () => on(...DANGER)),
    answer: ([, id = ""]) => {
      const refused = MAILBOX_409[fx() ?? ""]
      if (refused) return refused
      return ok({
        id,
        address: "halleluyah@coursified.app",
        domainId: "dom_01",
        kind: "user",
        displayName: "Halleluyah Oludele",
        holdsMail: true,
        targetIds: [],
        createdAt: NOW - 60 * DAY,
        updatedAt: NOW,
      })
    },
  },
  {
    method: "GET",
    path: new Scoped(/^\/v1\/mailboxes\/([^/]+)\/exports$/, () => on(...DANGER)),
    answer: () => ok(fx() === "export" ? { exports: [] } : MAILBOX_EXPORTS),
  },
  {
    method: "POST",
    path: new Scoped(/^\/v1\/mailboxes\/([^/]+)\/exports$/, () => on(...DANGER)),
    answer: () =>
      ok({
        ...(MAILBOX_EXPORTS.exports[0] as MailboxExports["exports"][number]),
        id: "mbe_02",
        status: "pending",
        completedAt: null,
      }),
  },
  {
    method: "PATCH",
    path: new Scoped(/^\/v1\/domains\/([^/]+)$/, () => on(...DANGER)),
    answer: ([, id = ""]) =>
      ok({
        id,
        name: id === "dom_02" ? "news.coursified.app" : "coursified.app",
        zoneId: null,
        receiving: false,
        sending: false,
        catchAll: "bounce",
        mailboxCount: 0,
        lastCheckedAt: NOW,
        checkStatus: "pass",
        zoneStatus: null,
        createdAt: NOW - 60 * DAY,
        updatedAt: NOW,
      }),
  },
]

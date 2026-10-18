/**
 * Fixture-mode overrides for Transactional's API keys, webhooks and suppressions (registered in
 * src/fixtures/overrides.ts), typed against the generated schema. The data is the designs' Coursified sample,
 * timed relative to now so "6 min ago" stays true, and kept in memory so a create, rotate, revoke, replay or
 * removal shows up in the list the way it would live.
 *
 * Designed states are picked by the page's own query string (`window.location.search`), so each is a URL:
 *   /transactional/keys?state=empty | ?state=rotating | ?as=sender
 *   /transactional/webhooks?state=empty | ?state=error
 *   /transactional/webhooks/whk_backlog?status=dead   → 1,312 dead letters, replayed 500 a call
 *   /transactional/suppressions?state=empty | ?state=error | ?state=connected
 *   /transactional/suppressions/no-reply@competitor.example?push=refused|not-connected|not-applicable
 */
import type { Json, Override } from "../fixtures/overrides.ts"

type Me = Json<"/v1/me", "get">
type KeyList = Json<"/v1/api-keys", "get">
type ApiKey = KeyList["keys"][number]
type Created = Json<"/v1/api-keys", "post">
type Rotated = Json<"/v1/api-keys/{id}/rotate", "post">
type LimitsBody = Json<"/v1/api-keys/{id}/limits", "get">
type Hooks = Json<"/v1/webhooks", "get">
type Hook = Hooks["webhooks"][number]
type HookCreated = Json<"/v1/webhooks", "post">
type Deliveries = Json<"/v1/webhooks/{id}/deliveries", "get">
type Delivery = Deliveries["deliveries"][number]
type SupList = Json<"/v1/suppressions", "get">
type Sup = SupList["suppressions"][number]
type SupDetail = Json<"/v1/suppressions/{email}", "get">
type SupImport = Json<"/v1/suppressions/imports/{id}", "get">

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => Date.now() - ms
const page = () =>
  typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)
const state = () => page().get("state")

/** A path pattern that only matches while `cond()` holds, so a designed state can shadow the default answer. */
function when(re: RegExp, cond: () => boolean): RegExp {
  const r = new RegExp(re.source, re.flags)
  Object.defineProperty(r, Symbol.match, {
    value: (s: string) => (cond() ? s.match(re) : null),
  })
  return r
}

const refuse = (status: number, body: Record<string, unknown>) => ({
  status,
  body: { requestId: "req_fixture_01JAF9", ...body },
})
const serverError = (what: string) =>
  refuse(500, {
    _tag: "InternalError",
    message: `${what} failed on the server.`,
    requestId: "req_01JAF9C3V7B1",
  })

// ── The signed-in sender (HANDOFF-ops §3: senders read keys, only owners and admins change them) ─────────────
const workspace = {
  id: "ws_01JA3Q8M2K",
  name: "Coursified",
  logoUrl: null,
  url: "https://mail.coursified.app",
  host: "mail.coursified.app",
  claimed: true,
}
const sender = (): Me => ({
  user: { id: "usr_01JAT0LU", name: "Tolu Adeyemi", email: "tolu@coursified.app", timeZone: "Africa/Lagos" },
  workspace,
  role: "sender",
  via: "session-member",
  key: null,
  scopes: [],
  permissions: [],
  mailboxes: [{ id: "mbx_hello", address: "hello@coursified.app", access: "member" }],
  workspaces: [workspace],
  session: { id: "ses_01JAT0LU", expiresAt: Date.now() + 14 * DAY, absoluteExpiresAt: Date.now() + 30 * DAY },
})

// ── API keys ──────────────────────────────────────────────────────────────────────────────────────────────
const key = (k: Omit<ApiKey, "createdBy" | "lastUsedAt" | "revokedAt"> & Partial<ApiKey>): ApiKey => ({
  createdBy: "Halleluyah Oludele",
  lastUsedAt: null,
  revokedAt: null,
  ...k,
})

function seedKeys(): ApiKey[] {
  return [
    key({
      id: "key_01JA4B7Q",
      name: "Coursified web app",
      kind: "secret",
      purpose: "api",
      prefix: "sk_7Hq2xLp",
      scopes: ["send", "track", "read"],
      lastUsedAt: ago(40_000),
      createdAt: ago(44 * DAY),
      requests24h: 612,
    }),
    key({
      id: "key_01JA4C2M",
      name: "Billing worker",
      kind: "secret",
      purpose: "api",
      prefix: "sk_Vd81Kq0",
      scopes: ["send"],
      lastUsedAt: ago(6 * MIN),
      createdAt: ago(44 * DAY),
      requests24h: 94,
    }),
    key({
      id: "key_01JA9ZP1",
      name: "Signup form (browser)",
      kind: "public",
      purpose: "api",
      prefix: "pk_3mRw9Tc",
      scopes: ["track"],
      createdBy: "Tolu Adeyemi",
      lastUsedAt: ago(31 * MIN),
      createdAt: ago(29 * DAY),
      requests24h: 37,
    }),
    key({
      id: "key_01JAD0R8",
      name: "Hermes agent",
      kind: "secret",
      purpose: "api",
      prefix: "sk_c0PzE4a",
      scopes: ["send", "track", "read", "admin"],
      lastUsedAt: ago(3 * HOUR),
      createdAt: ago(15 * DAY),
      requests24h: 12,
    }),
    key({
      id: "key_01J9Y3KE",
      name: "Old Vercel relay",
      kind: "secret",
      purpose: "api",
      prefix: "sk_Yx5Lb2n",
      scopes: ["send"],
      lastUsedAt: ago(8 * DAY),
      revokedAt: ago(7 * DAY),
      createdAt: ago(45 * DAY),
      requests24h: 0,
    }),
    key({
      id: "key_01JAG2C5",
      name: "Claude Code (Halleluyah)",
      kind: "secret",
      purpose: "mcp",
      prefix: "sk_Q4n8rWz",
      scopes: ["read", "send"],
      lastUsedAt: ago(HOUR),
      createdAt: ago(2 * DAY),
      requests24h: 48,
    }),
    key({
      id: "key_01JAG7K1",
      name: "Support triage agent",
      kind: "secret",
      purpose: "mcp",
      prefix: "sk_T0vh3Md",
      scopes: ["read"],
      lastUsedAt: ago(9 * MIN),
      createdAt: ago(DAY),
      requests24h: 131,
    }),
  ]
}

let keys: ApiKey[] | null = null
const allKeys = () => {
  keys ??= seedKeys()
  return keys
}

/** `?state=rotating`: Billing worker mid-rotation, its replacement beside it (api-keys-rotating). */
function rotatingKeys(): ApiKey[] {
  const list = seedKeys()
  const i = list.findIndex((k) => k.id === "key_01JA4C2M")
  const old = list[i]
  if (!old) return list
  list[i] = { ...old, revokedAt: Date.now() + 24 * HOUR }
  list.splice(
    i,
    0,
    key({
      id: "key_01JAH9R3",
      name: "Billing worker",
      kind: "secret",
      purpose: "api",
      prefix: "sk_Wd4nB8q",
      scopes: ["send"],
      createdBy: "Ops laptop",
      lastUsedAt: ago(40_000),
      createdAt: ago(5 * MIN),
      requests24h: 3,
    }),
  )
  return list
}

const limits = new Map<string, LimitsBody>([
  [
    "key_01JAD0R8",
    {
      limits: {
        sendsPerDay: 50,
        recipients: "domains",
        allowDomains: ["coursified.app", "gmail.com", "outlook.com", "yahoo.com"],
        requireApproval: true,
      },
      sentToday: 12,
    },
  ],
  [
    "key_01JAG2C5",
    {
      limits: { sendsPerDay: 200, recipients: "contacts", allowDomains: [], requireApproval: false },
      sentToday: 31,
    },
  ],
])

const secret = () => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  return Array.from({ length: 24 }, (_, i) => abc[(i * 7 + Date.now()) % abc.length]).join("")
}

// ── Webhooks ──────────────────────────────────────────────────────────────────────────────────────────────
const EVENTS: Hooks["events"] = [
  "message.sent",
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.failed",
  "message.rejected",
  "message.complained",
  "email.opened",
  "email.clicked",
  "contact.created",
  "contact.updated",
  "contact.subscribed",
  "contact.unsubscribed",
  "contact.deleted",
  "contact.suppressed",
  "contact.unsuppressed",
  "event.tracked",
  "campaign.paused",
  "campaign.sent",
  "mail.received",
  "mail.rule_matched",
  "approval.pending",
  "approval.approved",
  "approval.rejected",
  "alert.raised",
]

function seedHooks(): Hook[] {
  return [
    {
      id: "whk_01",
      url: "https://api.coursified.app/hooks/mail",
      description: "Course platform: mark bounced learners",
      events: ["message.delivered", "message.bounced", "message.complained", "contact.unsubscribed"],
      enabled: true,
      filter: { mailboxIds: ["mbx_support"], streams: ["transactional"] },
      paused: false,
      held: 0,
      lastSuccessAt: ago(3 * HOUR + 44 * MIN),
      lastFailureAt: ago(3 * MIN),
      deadLetters: 3,
      createdAt: ago(42 * DAY),
      updatedAt: ago(42 * DAY),
    },
    {
      id: "whk_02",
      url: "https://hermes.flareyard.dev/lanes/email/events",
      description: "Hermes agent: wake on new mail",
      events: ["mail.received", "message.bounced", "approval.pending"],
      enabled: true,
      filter: null,
      paused: true,
      held: 42,
      lastSuccessAt: ago(9 * MIN),
      lastFailureAt: null,
      deadLetters: 0,
      createdAt: ago(15 * DAY),
      updatedAt: ago(15 * DAY),
    },
    {
      id: "whk_03",
      url: "https://analytics.coursified.app/ingest/email",
      description: null,
      events: ["email.opened", "email.clicked"],
      enabled: false,
      filter: null,
      paused: false,
      held: 0,
      lastSuccessAt: ago(17 * DAY),
      lastFailureAt: null,
      deadLetters: 0,
      createdAt: ago(32 * DAY),
      updatedAt: ago(16 * DAY),
    },
    {
      id: "whk_backlog",
      url: "https://legacy.coursified.app/hooks/crm",
      description: "Old CRM bridge: down for a migration",
      events: ["*"],
      enabled: true,
      filter: null,
      paused: false,
      held: 0,
      lastSuccessAt: ago(9 * DAY),
      lastFailureAt: ago(20 * MIN),
      deadLetters: 1312,
      createdAt: ago(90 * DAY),
      updatedAt: ago(9 * DAY),
    },
  ]
}
let hooks: Hook[] | null = null
const allHooks = () => {
  hooks ??= seedHooks()
  return hooks
}

const payload = (id: string, type: string, messageId: string, recipient: string) => ({
  id,
  type,
  createdAt: new Date(ago(3 * HOUR)).toISOString(),
  data: { messageId, recipient, stream: "transactional", templateId: "tpl_reset" },
})

function seedDeliveries(): Delivery[] {
  const t = ago(3 * HOUR + 43 * MIN)
  return [
    {
      id: "dlv_0091",
      eventId: "evt_8c1f2a",
      eventType: "message.bounced",
      status: "retrying",
      attempts: 4,
      lastStatusCode: 500,
      lastError: "Internal Server Error",
      lastDurationMs: 10012,
      lastAttemptAt: ago(3 * MIN),
      nextAttemptAt: Date.now() + 12 * MIN,
      createdAt: ago(41 * MIN),
      payload: payload("evt_JAF004", "message.bounced", "msg_01JAF004", "t.mensah@kumasitech.edu.gh"),
      requestId: "req_8d44a01c0f3e9b",
    },
    {
      id: "dlv_0090",
      eventId: "evt_8c1e77",
      eventType: "message.delivered",
      status: "dead",
      attempts: 8,
      lastStatusCode: 500,
      lastError: "Internal Server Error",
      lastDurationMs: 10004,
      lastAttemptAt: t + 3_810_000,
      nextAttemptAt: null,
      createdAt: t,
      payload: payload("evt_JAF001", "message.delivered", "msg_01JAF001", "ada.okafor@gmail.com"),
      requestId: "req_8d44a02c0f3e9b",
    },
    {
      id: "dlv_0089",
      eventId: "evt_8c1e70",
      eventType: "message.delivered",
      status: "dead",
      attempts: 8,
      lastStatusCode: null,
      lastError: "Timed out after 10 s",
      lastDurationMs: 10000,
      lastAttemptAt: t + 3_690_000,
      nextAttemptAt: null,
      createdAt: t - 2 * MIN,
      payload: payload("evt_JAF002", "message.delivered", "msg_01JAF002", "chidi.eze@outlook.com"),
      requestId: null,
    },
    {
      id: "dlv_0088",
      eventId: "evt_8c1e61",
      eventType: "contact.unsubscribed",
      status: "dead",
      attempts: 8,
      lastStatusCode: 500,
      lastError: "Internal Server Error",
      lastDurationMs: 9988,
      lastAttemptAt: t + 3_390_000,
      nextAttemptAt: null,
      createdAt: t - 7 * MIN,
      payload: payload("evt_JAF006", "contact.unsubscribed", "msg_01JAF006", "bayo.k@icloud.com"),
      requestId: "req_8d44a04c0f3e9b",
    },
    {
      id: "dlv_0087",
      eventId: "evt_8c1d02",
      eventType: "message.delivered",
      status: "succeeded",
      attempts: 1,
      lastStatusCode: 200,
      lastError: null,
      lastDurationMs: 184,
      lastAttemptAt: t - MIN,
      nextAttemptAt: null,
      createdAt: t - MIN,
      payload: payload("evt_JAF007", "message.delivered", "msg_01JAF007", "amina.yusuf@gmail.com"),
      requestId: "req_8d44a05c0f3e9b",
    },
    {
      id: "dlv_0086",
      eventId: "evt_8c1cf1",
      eventType: "message.complained",
      status: "succeeded",
      attempts: 2,
      lastStatusCode: 204,
      lastError: null,
      lastDurationMs: 231,
      lastAttemptAt: t - 15 * MIN,
      nextAttemptAt: null,
      createdAt: t - 17 * MIN,
      payload: payload("evt_JAF006", "message.complained", "msg_01JAF006", "bayo.k@icloud.com"),
      requestId: "req_8d44a06c0f3e9b",
    },
    {
      id: "dlv_0085",
      eventId: "evt_8c1c9a",
      eventType: "message.bounced",
      status: "succeeded",
      attempts: 1,
      lastStatusCode: 200,
      lastError: null,
      lastDurationMs: 162,
      lastAttemptAt: t - 34 * MIN,
      nextAttemptAt: null,
      createdAt: t - 34 * MIN,
      payload: payload("evt_JAF013", "message.bounced", "msg_01JAF013", "ifeanyi.o@gmail.com"),
      requestId: "req_8d44a07c0f3e9b",
    },
  ]
}
const deliveries = new Map<string, Delivery[]>()
function heldDeliveries(): Delivery[] {
  return Array.from({ length: 4 }, (_, i) => ({
    id: `dlv_h${String(42 - i).padStart(3, "0")}`,
    eventId: `evt_h${i}`,
    eventType: i % 2 ? "message.bounced" : "mail.received",
    status: i === 3 ? ("succeeded" as const) : ("paused" as const),
    attempts: i === 3 ? 1 : 0,
    lastStatusCode: i === 3 ? 200 : null,
    lastError: null,
    lastDurationMs: i === 3 ? 141 : null,
    lastAttemptAt: i === 3 ? ago(50 * MIN) : null,
    nextAttemptAt: null,
    createdAt: ago((i + 1) * 9 * MIN),
    payload: payload(
      `evt_H${i}`,
      i % 2 ? "message.bounced" : "mail.received",
      `msg_01JH${i}`,
      "learner@example.com",
    ),
    requestId: i === 3 ? "hermes-7f3a91" : null,
  }))
}

const deliveriesFor = (id: string) => {
  if (!deliveries.has(id)) {
    if (id === "whk_01") deliveries.set(id, seedDeliveries())
    else if (id === "whk_02") deliveries.set(id, heldDeliveries())
    else if (id === "whk_backlog")
      deliveries.set(
        id,
        Array.from({ length: 12 }, (_, i) => ({
          id: `dlv_b${String(1312 - i).padStart(4, "0")}`,
          eventId: `evt_b${i}`,
          eventType: i % 3 ? "contact.updated" : "message.delivered",
          status: "dead" as const,
          attempts: 8,
          lastStatusCode: 503,
          lastError: "Service Unavailable",
          requestId: null,
          lastDurationMs: 88,
          lastAttemptAt: ago(9 * DAY - i * HOUR),
          nextAttemptAt: null,
          createdAt: ago(9 * DAY + HOUR - i * HOUR),
          payload: payload(
            `evt_B${i}`,
            i % 3 ? "contact.updated" : "message.delivered",
            `msg_01JB${i}`,
            "learner@example.com",
          ),
        })),
      )
    else deliveries.set(id, [])
  }
  return deliveries.get(id) ?? []
}
/** The backlog's dead letters still to replay, 500 a call. */
let backlog = 1312

// ── Suppressions ──────────────────────────────────────────────────────────────────────────────────────────
const sup = (s: Omit<Sup, "updatedAt" | "streams"> & Partial<Sup>): Sup => ({
  updatedAt: s.at,
  streams: s.bulkOnly ? ["campaign", "automation"] : ["all"],
  ...s,
})
const connected = () => state() === "connected"

function seedSups(): Sup[] {
  const cf = (v: Sup["cloudflare"]): Sup["cloudflare"] => v
  return [
    sup({
      email: "t.mensah@kumasitech.edu.gh",
      reason: "hard_bounce",
      source: "events",
      messageId: "msg_01JAF004",
      note: null,
      bulkOnly: false,
      cloudflare: cf("unchecked"),
      at: ago(26 * MIN),
    }),
    sup({
      email: "bayo.k@icloud.com",
      reason: "complaint",
      source: "events",
      messageId: "msg_01JAF006",
      note: null,
      bulkOnly: false,
      cloudflare: cf("unchecked"),
      at: ago(13 * MIN),
    }),
    sup({
      email: "ngozi.obi@gmail.com",
      reason: "unsubscribe",
      source: "events",
      messageId: "msg_01JAF005",
      note: null,
      bulkOnly: true,
      cloudflare: cf("not-applicable"),
      at: ago(40 * MIN),
    }),
    sup({
      email: "lola.ade@gmail.com",
      reason: "complaint",
      source: "events",
      messageId: "msg_01JA9X12",
      note: "Asked by email to keep getting receipts (Tolu, 4 Oct)",
      bulkOnly: true,
      cloudflare: cf("not-applicable"),
      at: ago(14 * DAY),
    }),
    sup({
      email: "no-reply@competitor.example",
      reason: "manual",
      source: "manual",
      messageId: null,
      note: "Scraper address; never mail it",
      bulkOnly: false,
      cloudflare: cf("unchecked"),
      at: ago(38 * DAY),
    }),
    sup({
      email: "old.list.member@yahoo.co.uk",
      reason: "hard_bounce",
      source: "import",
      messageId: null,
      note: "From plunk-suppressions.csv",
      bulkOnly: false,
      cloudflare: cf("unchecked"),
      at: ago(26 * DAY),
    }),
  ]
}
let sups: Sup[] | null = null
const allSups = () => {
  sups ??= seedSups()
  return sups
}
/** The connected deploy's view (suppressions-connected): every all-mail row checked, one missing. */
const asConnected = (s: Sup): Sup =>
  s.cloudflare === "not-applicable"
    ? s
    : { ...s, cloudflare: s.email === "no-reply@competitor.example" ? "missing" : "in-sync" }

const cfStatus = () =>
  connected()
    ? { readable: true, writable: true, checkedAt: ago(37 * MIN), cloudflareOnly: 4, error: null }
    : { readable: false, writable: false, checkedAt: null, cloudflareOnly: 0, error: null }

const counts = (list: Sup[]) => ({
  total: list.length + 293,
  hard_bounce: list.filter((s) => s.reason === "hard_bounce").length + 49,
  complaint: list.filter((s) => s.reason === "complaint").length + 1,
  unsubscribe: list.filter((s) => s.reason === "unsubscribe").length + 240,
  manual: list.filter((s) => s.reason === "manual").length + 3,
})

const CONTACTS: Record<string, { id: string; status: string; before: string }> = {
  "t.mensah@kumasitech.edu.gh": { id: "con_7Q2M", status: "suppressed", before: "subscribed" },
  "bayo.k@icloud.com": { id: "con_B4YK", status: "complained", before: "subscribed" },
  "ngozi.obi@gmail.com": { id: "con_N9OB", status: "unsubscribed", before: "subscribed" },
  "lola.ade@gmail.com": { id: "con_L0LA", status: "complained", before: "subscribed" },
}
const ENTRIES: Record<string, NonNullable<SupDetail["cloudflareEntries"]>> = {
  "t.mensah@kumasitech.edu.gh": [
    { id: "cfs_9a1c", reason: "hard_bounce", scope: "account", expiresAt: null, readOnly: false },
  ],
  "bayo.k@icloud.com": [
    { id: "cfs_7e20", reason: "complaint", scope: "account", expiresAt: null, readOnly: true },
  ],
  "old.list.member@yahoo.co.uk": [
    { id: "cfs_51d0", reason: "hard_bounce", scope: "account", expiresAt: null, readOnly: false },
  ],
}

function supDetail(s: Sup): SupDetail {
  const c = CONTACTS[s.email]
  const row = connected() ? asConnected(s) : s
  return {
    ...row,
    contact: c ? { id: c.id, status: c.status } : null,
    contactStatusBefore: c?.before ?? null,
    cloudflareEntries: connected() ? (ENTRIES[s.email] ?? []) : null,
  }
}

const imports = new Map<string, SupImport>([
  [
    "simp_01JAG2",
    {
      id: "simp_01JAG2",
      uploadId: "upl_01JAG1",
      status: "completed",
      reason: "hard_bounce",
      note: "Brevo export",
      emailColumn: "EMAIL",
      reasonColumn: "STATUS",
      noteColumn: null,
      push: true,
      headers: ["EMAIL", "STATUS", "DATE"],
      rows: 1204,
      added: 1121,
      existing: 41,
      invalid: 27,
      duplicates: 15,
      pushed: 960,
      errors: [
        { line: 18, message: "Not an email address: “info@”" },
        { line: 233, message: "Not an email address: “n/a”" },
        { line: 901, message: "Unknown reason “greylisted”; skipped" },
      ],
      error: null,
      createdAt: ago(9 * MIN),
      finishedAt: ago(7 * MIN),
    },
  ],
])
const importPolls = new Map<string, number>()

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
const body = <T>(b: unknown) => (b ?? {}) as T

export const TRANSACTIONAL_KEYS_OVERRIDES: readonly Override[] = [
  // The sender's view of Transactional: `?as=sender` anywhere under /transactional.
  {
    method: "GET",
    path: when(
      /^\/v1\/me$/,
      () => page().get("as") === "sender" && window.location.pathname.startsWith("/transactional"),
    ),
    answer: () => ({ status: 200, body: sender() }),
  },

  // ── API keys ──
  {
    method: "GET",
    path: /^\/v1\/api-keys$/,
    answer: (_m, _b, url) => {
      if (state() === "empty" && window.location.pathname.startsWith("/transactional"))
        return { status: 200, body: { keys: [] } satisfies KeyList }
      const list = state() === "rotating" ? rotatingKeys() : allKeys()
      const purpose = url.searchParams.get("purpose")
      const usage = url.searchParams.get("include") === "usage"
      const out = list
        .filter((k) => !purpose || k.purpose === purpose)
        .map((k) => {
          if (usage) return k
          const { requests24h: _, ...rest } = k
          return rest
        })
      return { status: 200, body: { keys: out } satisfies KeyList }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/api-keys$/,
    answer: (_m, b) => {
      const req = body<{
        name?: string
        kind?: "secret" | "public"
        scopes?: ApiKey["scopes"]
        purpose?: "api" | "mcp"
      }>(b)
      if (req.kind === "public" && req.purpose === "mcp")
        return refuse(400, {
          _tag: "InvalidRequest",
          message: "Public keys can’t be used for MCP",
          field: "purpose",
        })
      const kind = req.kind ?? "secret"
      const raw = `${kind === "public" ? "pk_" : "sk_"}${secret()}`
      const apiKey = key({
        id: `key_${Date.now().toString(36).toUpperCase()}`,
        name: req.name ?? "New key",
        kind,
        purpose: req.purpose ?? "api",
        prefix: raw.slice(0, 10),
        scopes: req.scopes ?? [],
        createdBy: "Halleluyah Oludele",
        createdAt: Date.now(),
        requests24h: 0,
      })
      allKeys().unshift(apiKey)
      return { status: 200, body: { key: raw, apiKey } satisfies Created }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/api-keys\/([^/]+)\/rotate$/,
    answer: ([, id = ""], b) => {
      const list = allKeys()
      const old = list.find((k) => k.id === id)
      if (!old || (old.revokedAt !== null && Number(old.revokedAt) <= Date.now()))
        return refuse(404, { _tag: "NotFound", message: "No active key with that id." })
      const grace = Number(body<{ graceSeconds?: number }>(b).graceSeconds ?? 0)
      const revokedAt = Date.now() + grace * 1000
      const raw = `sk_${secret()}`
      const apiKey = key({
        ...old,
        id: `key_${Date.now().toString(36).toUpperCase()}`,
        prefix: raw.slice(0, 10),
        createdBy: "Halleluyah Oludele",
        createdAt: Date.now(),
        lastUsedAt: null,
        revokedAt: null,
        requests24h: 0,
      })
      old.revokedAt = revokedAt
      list.splice(list.indexOf(old), 0, apiKey)
      const lim = limits.get(old.id)
      if (lim) limits.set(apiKey.id, lim)
      return {
        status: 200,
        body: { key: raw, apiKey, previous: { id: old.id, revokedAt } } satisfies Rotated,
      }
    },
  },
  {
    method: "DELETE",
    path: /^\/v1\/api-keys\/([^/]+)$/,
    answer: ([, id = ""]) => {
      const k = allKeys().find((x) => x.id === id)
      if (!k) return refuse(404, { _tag: "NotFound", message: "No key with that id." })
      k.revokedAt = Date.now() - 1
      return { status: 200, body: k }
    },
  },
  {
    method: "GET",
    path: /^\/v1\/api-keys\/([^/]+)\/limits$/,
    answer: ([, id = ""]) => ({
      status: 200,
      body:
        limits.get(id) ?? ({ limits: null, sentToday: id === "key_01JA4C2M" ? 94 : 0 } satisfies LimitsBody),
    }),
  },
  {
    method: "PUT",
    path: /^\/v1\/api-keys\/([^/]+)\/limits$/,
    answer: ([, id = ""], b) => {
      const next = body<{ limits: LimitsBody["limits"] }>(b).limits
      const cur = limits.get(id)
      const out: LimitsBody = { limits: next, sentToday: cur?.sentToday ?? 0 }
      limits.set(id, out)
      return { status: 200, body: out }
    },
  },

  // ── Webhooks ──
  {
    method: "GET",
    path: /^\/v1\/webhooks$/,
    answer: () => {
      if (state() === "error") return serverError("Listing webhook endpoints")
      if (state() === "empty") return { status: 200, body: { webhooks: [], events: EVENTS } satisfies Hooks }
      return { status: 200, body: { webhooks: allHooks(), events: EVENTS } satisfies Hooks }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/webhooks$/,
    answer: (_m, b) => {
      const req = body<{
        url?: string
        description?: string
        events?: Hook["events"]
        filter?: Hook["filter"]
        preset?: { kind: "agent-wake"; mailboxId: string }
      }>(b)
      // The agent-wake preset (HAL-3461) is mail.received, filtered to the agent's mailbox, as the API sets it.
      const wake = req.preset?.kind === "agent-wake" ? req.preset.mailboxId : null
      const endpoint: Hook = {
        id: `whk_${Date.now().toString(36)}`,
        url: req.url ?? "",
        filter: wake ? { mailboxIds: [wake] } : (req.filter ?? null),
        paused: false,
        held: 0,
        description: req.description ?? null,
        events: wake ? ["mail.received"] : (req.events ?? []),
        enabled: true,
        lastSuccessAt: null,
        lastFailureAt: null,
        deadLetters: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      allHooks().push(endpoint)
      return {
        status: 200,
        body: { endpoint, secret: `whsec_${btoa(secret() + secret()).slice(0, 43)}=` } satisfies HookCreated,
      }
    },
  },
  {
    method: "GET",
    path: /^\/v1\/webhooks\/([^/]+)$/,
    answer: ([, id = ""]) => {
      const h = allHooks().find((x) => x.id === id)
      return h
        ? { status: 200, body: h }
        : refuse(404, { _tag: "NotFound", message: "No webhook endpoint with that id." })
    },
  },
  {
    method: "PATCH",
    path: /^\/v1\/webhooks\/([^/]+)$/,
    answer: ([, id = ""], b) => {
      const h = allHooks().find((x) => x.id === id)
      if (!h) return refuse(404, { _tag: "NotFound", message: "No webhook endpoint with that id." })
      const req = body<Partial<Hook>>(b)
      // Resuming sends the held deliveries, oldest first; pausing starts holding new ones.
      if (req.paused === false && h.paused) {
        for (const d of deliveriesFor(id)) if (d.status === "paused") Object.assign(d, { status: "pending" })
        h.held = 0
      }
      Object.assign(h, req, { updatedAt: Date.now() })
      return { status: 200, body: h }
    },
  },
  {
    method: "DELETE",
    path: /^\/v1\/webhooks\/([^/]+)$/,
    answer: ([, id = ""]) => {
      const list = allHooks()
      const h = list.find((x) => x.id === id)
      if (!h) return refuse(404, { _tag: "NotFound", message: "No webhook endpoint with that id." })
      list.splice(list.indexOf(h), 1)
      return { status: 200, body: h }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/webhooks\/([^/]+)\/rotate-secret$/,
    answer: ([, id = ""]) => {
      const h = allHooks().find((x) => x.id === id)
      if (!h) return refuse(404, { _tag: "NotFound", message: "No webhook endpoint with that id." })
      return {
        status: 200,
        body: { endpoint: h, secret: `whsec_${btoa(secret() + secret()).slice(0, 43)}=` },
      }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/webhooks\/([^/]+)\/test$/,
    answer: ([, id = ""], b) => {
      const list = deliveriesFor(id)
      const type = body<{ event?: string } | null>(b)?.event ?? "webhook.test"
      const d: Delivery = {
        id: `dlv_${String(92 + list.length).padStart(4, "0")}`,
        eventId: `evt_test_${list.length}`,
        eventType: type,
        status: "pending",
        attempts: 0,
        lastStatusCode: null,
        lastError: null,
        lastDurationMs: null,
        lastAttemptAt: null,
        nextAttemptAt: null,
        createdAt: Date.now(),
        payload: {
          id: `evt_test_${list.length}`,
          type,
          createdAt: new Date().toISOString(),
          sample: true,
          data: { messageId: "msg_sample", recipient: "sample@example.com", stream: "transactional" },
        },
        requestId: null,
      }
      list.unshift(d)
      return { status: 200, body: { deliveryId: d.id, eventId: d.eventId, eventType: d.eventType } }
    },
  },
  {
    method: "GET",
    path: /^\/v1\/webhooks\/([^/]+)\/deliveries$/,
    answer: ([, id = ""], _b, url) => {
      const status = url.searchParams.get("status")
      const list = deliveriesFor(id).filter((d) => !status || d.status === status)
      return {
        status: 200,
        body: { deliveries: list, nextCursor: list.length >= 7 ? "dlv_0084" : null } satisfies Deliveries,
      }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/webhooks\/([^/]+)\/deliveries\/replay$/,
    answer: ([, id = ""]) => {
      const h = allHooks().find((x) => x.id === id)
      if (id === "whk_backlog") {
        const n = Math.min(500, backlog)
        backlog -= n
        if (h) h.deadLetters = backlog
        if (!backlog) deliveries.set(id, [])
        return { status: 200, body: { replayed: n, remaining: backlog } }
      }
      const list = deliveriesFor(id)
      const dead = list.filter((d) => d.status === "dead")
      for (const d of dead) Object.assign(d, { status: "pending", attempts: 0, nextAttemptAt: null })
      if (h) h.deadLetters = 0
      return { status: 200, body: { replayed: dead.length, remaining: 0 } }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/webhooks\/([^/]+)\/deliveries\/([^/]+)\/replay$/,
    answer: ([, id = "", dId = ""]) => {
      const d = deliveriesFor(id).find((x) => x.id === dId)
      if (!d) return refuse(404, { _tag: "NotFound", message: "No delivery with that id." })
      const h = allHooks().find((x) => x.id === id)
      if (d.status === "dead" && h) h.deadLetters = Math.max(0, Number(h.deadLetters) - 1)
      Object.assign(d, { status: "pending", attempts: 0, nextAttemptAt: null })
      return { status: 200, body: { id: d.id, status: d.status } }
    },
  },

  // ── Suppressions ──
  {
    method: "GET",
    path: /^\/v1\/suppressions$/,
    answer: (_m, _b, url) => {
      if (state() === "error")
        return refuse(500, {
          _tag: "InternalError",
          message: "Reading the suppression list failed.",
          requestId: "req_01JAFH8C2N5R",
        })
      const base = state() === "empty" ? [] : allSups().map((s) => (connected() ? asConnected(s) : s))
      const p = url.searchParams
      const q = p.get("q")?.toLowerCase()
      const list = base.filter(
        (s) =>
          (!p.get("reason") || s.reason === p.get("reason")) &&
          (!p.get("source") || s.source === p.get("source")) &&
          (!p.get("cloudflare") || s.cloudflare === p.get("cloudflare")) &&
          (!q || s.email.includes(q)),
      )
      const all = base.length
        ? counts(base)
        : { total: 0, hard_bounce: 0, complaint: 0, unsubscribe: 0, manual: 0 }
      const res: SupList = {
        suppressions: list,
        counts: all,
        cloudflare: cfStatus(),
        nextCursor: list.length >= 6 ? "MTc2MDY5…" : null,
      }
      return { status: 200, body: res }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/suppressions$/,
    answer: (_m, b) => {
      const req = body<{
        email?: string
        reason?: Sup["reason"]
        note?: string | null
        bulkOnly?: boolean
        push?: boolean
      }>(b)
      const email = (req.email ?? "").trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return refuse(400, {
          _tag: "InvalidRequest",
          message: "That isn’t an email address.",
          field: "email",
        })
      const list = allSups()
      const existing = list.find((s) => s.email === email)
      if (existing) return { status: 200, body: { suppression: existing, created: false, cloudflare: null } }
      const reason = req.reason ?? "manual"
      const bulkOnly = reason === "unsubscribe" ? true : Boolean(req.bulkOnly)
      const s = sup({
        email,
        reason,
        source: "manual",
        messageId: null,
        note: req.note ?? null,
        bulkOnly,
        cloudflare: bulkOnly ? "not-applicable" : "unchecked",
        at: Date.now(),
      })
      list.unshift(s)
      return {
        status: 200,
        body: {
          suppression: s,
          created: true,
          cloudflare: req.push
            ? {
                state: connected() ? "pushed" : "not-connected",
                message: connected() ? null : "No Cloudflare write token.",
              }
            : null,
        },
      }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/suppressions\/sync$/,
    answer: () => ({
      status: 200,
      body: connected()
        ? {
            connected: true,
            checkedAt: Date.now(),
            cloudflareOnly: 4,
            adopted: 2,
            complete: true,
            error: null,
            matched: 297,
          }
        : { connected: false, checkedAt: null, cloudflareOnly: 0, adopted: 0, complete: false, error: null },
    }),
  },
  {
    method: "POST",
    path: /^\/v1\/suppressions\/import$/,
    answer: (_m, b) => {
      const req = body<{
        uploadId: string
        reason?: Sup["reason"]
        note?: string | null
        emailColumn?: string
        reasonColumn?: string
        noteColumn?: string
        push?: boolean
      }>(b)
      const id = `simp_${Date.now().toString(36).toUpperCase()}`
      const imp: SupImport = {
        id,
        uploadId: req.uploadId,
        status: "queued",
        reason: req.reason ?? "hard_bounce",
        note: req.note ?? null,
        emailColumn: req.emailColumn ?? null,
        reasonColumn: req.reasonColumn ?? null,
        noteColumn: req.noteColumn ?? null,
        push: Boolean(req.push),
        headers: null,
        rows: 0,
        added: 0,
        existing: 0,
        invalid: 0,
        duplicates: 0,
        pushed: 0,
        errors: [],
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
      }
      imports.set(id, imp)
      return { status: 200, body: imp }
    },
  },
  {
    method: "GET",
    path: /^\/v1\/suppressions\/imports$/,
    answer: () => ({ status: 200, body: { imports: [...imports.values()].reverse(), nextCursor: null } }),
  },
  {
    method: "GET",
    path: /^\/v1\/suppressions\/imports\/([^/]+)$/,
    answer: ([, id = ""]) => {
      const imp = imports.get(id)
      if (!imp) return refuse(404, { _tag: "NotFound", message: "No import with that id." })
      if (imp.status !== "completed" && imp.status !== "failed") {
        // A fixture import runs for two polls, then lands like the designed result.
        const n = (importPolls.get(id) ?? 0) + 1
        importPolls.set(id, n)
        const done = imports.get("simp_01JAG2")
        if (n >= 3 && done)
          Object.assign(imp, {
            ...done,
            id,
            uploadId: imp.uploadId,
            createdAt: imp.createdAt,
            finishedAt: Date.now(),
          })
        else Object.assign(imp, { status: "running", rows: 5000 * n > 1204 ? 1204 : 5000 * n })
      }
      return { status: 200, body: imp }
    },
  },
  {
    method: "GET",
    path: /^\/v1\/suppressions\/([^/]+)$/,
    answer: ([, raw = ""]) => {
      const s = allSups().find((x) => x.email === decode(raw))
      return s
        ? { status: 200, body: supDetail(s) }
        : refuse(404, {
            _tag: "SuppressionNotFound",
            message: "That address isn’t suppressed.",
            email: decode(raw),
          })
    },
  },
  {
    method: "PATCH",
    path: /^\/v1\/suppressions\/([^/]+)$/,
    answer: ([, raw = ""], b) => {
      const s = allSups().find((x) => x.email === decode(raw))
      if (!s) return refuse(404, { _tag: "SuppressionNotFound", message: "That address isn’t suppressed." })
      const req = body<{ note?: string | null; bulkOnly?: boolean }>(b)
      const turnedBulk = req.bulkOnly === true && !s.bulkOnly
      Object.assign(s, {
        ...(req.note !== undefined ? { note: req.note } : {}),
        ...(req.bulkOnly !== undefined && s.reason !== "unsubscribe"
          ? {
              bulkOnly: req.bulkOnly,
              streams: req.bulkOnly ? ["campaign", "automation"] : ["all"],
              cloudflare: req.bulkOnly ? "not-applicable" : "unchecked",
            }
          : {}),
        updatedAt: Date.now(),
      })
      return {
        status: 200,
        body: {
          suppression: s,
          cloudflare: turnedBulk
            ? connected()
              ? { state: ENTRIES[s.email] ? "removed" : "not-listed", message: null }
              : { state: "not-connected", message: "No Cloudflare write token." }
            : null,
        },
      }
    },
  },
  {
    method: "DELETE",
    path: /^\/v1\/suppressions\/([^/]+)$/,
    answer: ([, raw = ""], b) => {
      const list = allSups()
      const s = list.find((x) => x.email === decode(raw))
      if (!s) return refuse(404, { _tag: "SuppressionNotFound", message: "That address isn’t suppressed." })
      if (s.reason === "complaint")
        return refuse(409, {
          _tag: "Conflict",
          reason: "complaint",
          message: "A complaint can never be removed. Set Bulk only to let transactional mail through.",
        })
      if (!body<{ confirm?: boolean }>(b).confirm)
        return refuse(400, {
          _tag: "InvalidRequest",
          message: "Send confirm: true to remove a suppression.",
          field: "confirm",
        })
      list.splice(list.indexOf(s), 1)
      const entry = ENTRIES[s.email]?.[0]
      const cloudflare = !connected()
        ? { state: "not-connected" as const, message: "No Cloudflare write token." }
        : entry?.readOnly
          ? {
              state: "read-only" as const,
              message: "Cloudflare keeps this entry and won’t let anyone delete it.",
            }
          : entry
            ? { state: "removed" as const, message: null }
            : { state: "not-listed" as const, message: null }
      return {
        status: 200,
        body: { email: s.email, removed: true, contactStatus: CONTACTS[s.email]?.before ?? null, cloudflare },
      }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/suppressions\/([^/]+)\/push$/,
    answer: ([, raw = ""]) => {
      const s = allSups().find((x) => x.email === decode(raw))
      if (!s) return refuse(404, { _tag: "SuppressionNotFound", message: "That address isn’t suppressed." })
      const forced = page().get("push")
      if (forced === "not-applicable" || s.bulkOnly || s.reason === "unsubscribe")
        return refuse(409, {
          _tag: "Conflict",
          reason: "not-applicable",
          message:
            "This row only blocks bulk mail, so it isn’t pushed: Cloudflare’s list would block transactional mail too.",
        })
      if (forced === "not-connected" || (!connected() && forced !== "refused"))
        return refuse(409, {
          _tag: "CloudflareNotConnected",
          message: "There’s no Cloudflare write token, so Mailyard can’t add to the account list.",
        })
      if (forced === "refused")
        return refuse(502, {
          _tag: "CloudflareRefused",
          status: 400,
          message: "address already present with a different scope",
        })
      s.cloudflare = "in-sync"
      return { status: 200, body: { suppression: s, cloudflare: { state: "pushed", message: null } } }
    },
  },
]

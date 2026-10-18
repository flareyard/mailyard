/**
 * Fixture mode for designed states (HAL-3310). `?fx=<screen>` on a page's URL answers each API call from that
 * design screen's own fixture, so `/campaigns/cmp_01JAB9?fx=campaign-paused-complaint` renders the paused-by-
 * complaint state, not whichever variant scores first. Design fixtures always carry the body only; an error
 * body (`_tag`) is answered with its HTTP status. Screens whose state is the request itself (loading, a failed
 * load) get the generic rules below, scoped to this run's endpoints, so the shell keeps working around them.
 *
 * Only fixture mode ever calls this; the table is the same lazily loaded `fixtures.json`.
 */
import { findFixture } from "../../fixtures/mode.ts"

type Variant = { screen: string; path: string; query: string; body: unknown }
type Table = Record<string, Variant[]>
type Answer = { status: number; body: unknown }

let table: Promise<Table> | null = null
const load = () => {
  table ??= import("../../fixtures/fixtures.json").then((m) => m.default as Table)
  return table
}

/** The API paths these sections own: the generic loading and error rules apply to these only. */
const SECTION =
  /^\/v1\/(contacts|contact-fields|topics|segments|forms|imports|exports|campaigns|automations|runs)(\/|$)/

const STATUS: Record<string, number> = {
  InvalidRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  NotReady: 409,
  Gone: 410,
  Unprocessable: 422,
  RateLimited: 429,
}

/**
 * Per-screen rules for states a fixture can't express: which request hangs (loading) or fails (error), when
 * it isn't the screen's main list. A path pattern and what it answers; the first match wins.
 */
/** `"pass"` answers as if `?fx` weren't set (the default fixture), for a request the screen doesn't change. */
type Rule = { method?: string; path: RegExp; answer: "hang" | "pass" | Answer }
export const err = (
  status: number,
  tag: string,
  message: string,
  extra: Record<string, unknown> = {},
): Answer => ({
  status,
  body: { _tag: tag, message, requestId: "req_01JAHFX7Q2", ...extra },
})
export const down = err(503, "Unavailable", "The database didn’t answer in time.")

export const SCREEN_RULES: Record<string, Rule[]> = {
  // ── Audience ──
  "contact-error": [{ path: /^\/v1\/contacts\/[^/]+\/timeline$/, answer: down }],
  "contact-loading": [{ path: /^\/v1\/contacts\/[^/]+(\/timeline)?$/, answer: "hang" }],
  "segment-counting": [{ method: "POST", path: /^\/v1\/segments\/preview$/, answer: "hang" }],
  // The builder's segment loads as usual; only the preview answers the 400 (or nothing matches).
  "segment-preview-error": [{ method: "GET", path: /^\/v1\//, answer: "pass" }],
  "segment-zero": [{ method: "GET", path: /^\/v1\/segments(\/[^/]+)?$/, answer: "pass" }],
  "segments-empty": [
    { method: "GET", path: /^\/v1\/segments$/, answer: { status: 200, body: { segments: [] } } },
  ],
  "topics-empty": [
    { method: "GET", path: /^\/v1\/topics$/, answer: { status: 200, body: { topics: [] } } },
    {
      method: "GET",
      path: /^\/v1\/topics\/stats$/,
      answer: { status: 200, body: { range: "30d", minimumSubscribers: 100, topics: [] } },
    },
  ],
  "forms-empty": [{ method: "GET", path: /^\/v1\/forms$/, answer: { status: 200, body: { forms: [] } } }],
  // Read-only for a key without admin: the Support desk key (read, send).
  "fields-readonly": [
    {
      method: "GET",
      path: /^\/v1\/me$/,
      answer: {
        status: 200,
        body: {
          user: null,
          workspace: {
            id: "ws_01JA3Q8M2K",
            name: "Coursified",
            logoUrl: null,
            url: "https://mail.coursified.app",
            host: "mail.coursified.app",
            claimed: true,
          },
          role: null,
          via: "session-key",
          key: { id: "key_01JA4SUPP", name: "Support desk", prefix: "sk_Sd5k2Pw" },
          scopes: ["read", "send"],
          permissions: [],
          mailboxes: null,
          workspaces: [],
          session: null,
        },
      },
    },
  ],
  // ── Campaigns ──
  "campaign-editor-loading": [{ path: /^\/v1\/campaigns\/[^/]+$/, answer: "hang" }],
  "campaign-report-loading": [{ path: /^\/v1\/campaigns\/[^/]+\/(report|recipients)$/, answer: "hang" }],
  "campaign-report-error": [{ path: /^\/v1\/campaigns\/[^/]+\/report$/, answer: down }],
  // These screens are a refused save: everything loads as usual, and only the PATCH answers the designed 400/409.
  ...Object.fromEntries(
    [
      "campaign-editor-error",
      "campaign-content-section-error",
      "campaign-content-footer-error",
      "campaign-content-subject-error",
      "campaign-audience-exclude-error",
      "campaign-audience-days-error",
    ].map((k) => [k, [{ method: "GET", path: /^\/v1\/campaigns\/[^/]+$/, answer: "pass" as const }]]),
  ),
  // ── Automations ──
  "automation-builder-loading": [{ path: /^\/v1\/automations\/[^/]+$/, answer: "hang" }],
  "automation-builder-error": [{ path: /^\/v1\/automations\/[^/]+$/, answer: down }],
  "automations-empty": [
    {
      method: "GET",
      path: /^\/v1\/automations$/,
      answer: {
        status: 200,
        body: {
          range: "7d",
          summary: { live: 0, activeRuns: 0, entered: 0, completed: 0, failed: 0 },
          automations: [],
        },
      },
    },
  ],
  "automation-runs-empty": [
    {
      method: "GET",
      path: /^\/v1\/automations\/[^/]+\/runs$/,
      answer: { status: 200, body: { runs: [], total: 0, nextCursor: null } },
    },
  ],
  // The send inspector reads each template's required placeholders; the design embeds one template's detail.
  "automation-send-step": automationTemplates({
    tpl_welcome: ["welcome", 3, ["first_name"]],
    tpl_pick: ["pick-a-course", 2, ["first_name"]],
    tpl_nudge: ["nudge", 1, []],
    tpl_anniv: ["course-anniversary", 1, ["first_name", "trigger.topicName", "trigger.years"]],
    tpl_anniv_cert: ["anniversary-certificate", null, ["trigger.years"]],
  }),
  "automation-send-step-date": automationTemplates({
    tpl_welcome: ["welcome", 3, ["first_name"]],
    tpl_pick: ["pick-a-course", 2, ["first_name"]],
    tpl_nudge: ["nudge", 1, []],
    tpl_anniv: ["course-anniversary", 1, ["first_name", "trigger.topicName", "trigger.years"]],
    tpl_anniv_cert: ["anniversary-certificate", null, ["trigger.years"]],
  }),
  "automation-builder-issues": automationTemplates({
    tpl_anniv: ["course-anniversary", 1, ["first_name", "trigger.topicName", "trigger.years"]],
    tpl_anniv_cert: ["anniversary-certificate", null, ["trigger.years"]],
  }),
}

/** Template details for the send inspector's placeholder list: id → [name, published version, required]. */
function automationTemplates(t: Record<string, [string, number | null, string[]]>): Rule[] {
  return Object.entries(t).map(([id, [name, published, required]]) => ({
    method: "GET",
    path: new RegExp(`^/v1/templates/${id}$`),
    answer: {
      status: 200,
      body: {
        id,
        name,
        kind: "html",
        publishedVersion: published,
        latestVersion: published ?? 1,
        hasUnpublishedChanges: published === null,
        archived: false,
        updatedAt: 1791740880000,
        createdAt: 1788284880000,
        latest: {
          version: published ?? 1,
          subject: name,
          source: required.map((r) => `{{ ${r} }}`).join(" "),
          text: null,
          publishedAt: published === null ? null : 1791740880000,
          updatedAt: 1791740880000,
          updatedBy: "key_01JA4B7Q2M",
          variables: { used: required, required },
        },
        versions: [],
      },
    },
  }))
}

/** Extra rules other parts of this run register (kept here so overrides.ts stays a one-line hook). */
export function addScreenRules(screen: string, rules: Rule[]) {
  SCREEN_RULES[screen] = [...(SCREEN_RULES[screen] ?? []), ...rules]
}

/**
 * Default answers without `?fx`, where the table's scoring would pick the wrong variant: a list answered from
 * the screen that draws it (filtered by a query parameter the way the API filters), or a detail answered with
 * the matching item of a list fixture when no screen fetched that id.
 */
type DefaultRule = {
  method: string
  path: RegExp
  answer:
    | {
        fromScreen: string
        filter?: { param: string; array: string; field: string; aliases?: Record<string, string[]> }
      }
    | { listItem: string; array: string }
}
export const DEFAULT_RULES: DefaultRule[] = [
  // ── Campaigns ──
  {
    method: "GET",
    path: /^\/v1\/campaigns$/,
    answer: {
      fromScreen: "campaigns-viewer",
      filter: {
        param: "status",
        array: "campaigns",
        field: "status",
        aliases: { active: ["scheduled", "sending", "paused"] },
      },
    },
  },
  {
    method: "GET",
    path: /^\/v1\/campaigns\/(?!counts$)[^/]+$/,
    answer: { listItem: "GET /v1/campaigns", array: "campaigns" },
  },
  // The campaign editor's compliance panel: the account with its postal address set (campaign-checks.html).
  { method: "GET", path: /^\/v1\/settings\/compliance$/, answer: { fromScreen: "campaign-checks" } },
]

async function defaultFixture(request: Request): Promise<Answer | undefined> {
  const url = new URL(request.url)
  const rule = DEFAULT_RULES.find((r) => r.method === request.method && r.path.test(url.pathname))
  if (!rule) return undefined
  const t = await load()
  if ("listItem" in rule.answer) {
    // Only when no screen fetched this id itself.
    const key = `${request.method} ${url.pathname.replace(/\/[^/]+$/, "/{id}")}`
    if ((t[key] ?? []).some((v) => v.path === url.pathname)) return undefined
    const id = url.pathname.split("/").pop()
    const { array } = rule.answer
    for (const v of t[rule.answer.listItem] ?? []) {
      const list = (v.body as Record<string, unknown> | null)?.[array]
      const hit = Array.isArray(list) ? list.find((x: { id?: string }) => x?.id === id) : undefined
      if (hit) return { status: 200, body: hit }
    }
    return undefined
  }
  const { fromScreen, filter } = rule.answer
  const variants = (t[`${request.method} ${url.pathname}`] ?? []).filter((v) =>
    v.screen.endsWith(`/${fromScreen}.html`),
  )
  const v = variants[0]
  if (!v) return undefined
  const want = filter ? url.searchParams.get(filter.param) : null
  if (!filter || !want) return { status: 200, body: v.body }
  const body = v.body as Record<string, unknown>
  const list = Array.isArray(body[filter.array]) ? (body[filter.array] as Record<string, unknown>[]) : []
  const allowed = filter.aliases?.[want] ?? [want]
  return {
    status: 200,
    body: { ...body, [filter.array]: list.filter((x) => allowed.includes(String(x[filter.field]))) },
  }
}

function screenParam(): string | null {
  if (typeof window === "undefined") return null
  return new URLSearchParams(window.location.search).get("fx")
}

const never = () => new Promise<never>(() => {})

/** Each role's permissions, as the API's table hands them out (`src/domain/permissions.ts`), for role screens. */
const ROLE_PERMISSIONS: Record<string, string[]> = (() => {
  const all = ["owner", "admin", "sender", "agent", "viewer"]
  const managers = ["owner", "admin"]
  const senders = ["owner", "admin", "sender"]
  const readers = ["owner", "admin", "sender", "viewer"]
  const table: Record<string, string[]> = {
    "mail.read": all,
    "mail.send": ["owner", "admin", "sender", "agent"],
    "mail.manage": managers,
    "contacts.read": all,
    "contacts.write": senders,
    "contacts.erase": managers,
    "campaigns.read": readers,
    "campaigns.write": senders,
    "automations.read": readers,
    "automations.write": senders,
    "templates.read": readers,
    "templates.write": senders,
    "analytics.read": readers,
    "settings.read": readers,
    "settings.write": managers,
    "domains.manage": managers,
    "webhooks.manage": managers,
    "keys.manage": managers,
    "email.send": senders,
    "events.track": senders,
    "exports.workspace": managers,
    "agents.manage": managers,
    "approvals.manage": managers,
    "members.manage": managers,
    "workspace.owner": ["owner"],
  }
  const out: Record<string, string[]> = {}
  for (const r of all)
    out[r] = Object.keys(table)
      .filter((p) => table[p]?.includes(r))
      .sort()
  return out
})()

const ROLE_PEOPLE: Record<string, { name: string; email: string }> = {
  agent: { name: "Kemi Lawal", email: "kemi@coursified.app" },
  sender: { name: "Tolu Adeyemi", email: "tolu@coursified.app" },
  viewer: { name: "Ifeoma Nwosu", email: "ifeoma@coursified.app" },
}

/** `?fx=<screen>-agent|-sender|-viewer`: `/v1/me` answers as a person in that role (HAL-3361). */
async function roleMe(screen: string): Promise<Answer | undefined> {
  const role = screen.match(/-(agent|sender|viewer)$/)?.[1]
  if (!role) return undefined
  const t = await load()
  const base = (t["GET /v1/me"] ?? []).find((v) => v.screen === "overview/overview-7d.html")?.body as
    | Record<string, unknown>
    | undefined
  const person = ROLE_PEOPLE[role] ?? { name: "Teammate", email: "teammate@coursified.app" }
  return {
    status: 200,
    body: {
      ...(base ?? {}),
      user: { id: `usr_fx_${role}`, ...person, timeZone: "UTC" },
      role,
      via: "session-member",
      key: null,
      scopes: [],
      permissions: ROLE_PERMISSIONS[role] ?? [],
    },
  }
}

export async function screenFixture(request: Request): Promise<Answer | undefined> {
  const screen = screenParam()
  if (!screen) return (await actionFixture(request)) ?? defaultFixture(request)
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/v1/me") {
    const me = await roleMe(screen)
    if (me) return me
  }
  for (const r of SCREEN_RULES[screen] ?? []) {
    if (r.method && r.method !== request.method) continue
    if (!r.path.test(url.pathname)) continue
    if (r.answer === "hang") return never()
    if (r.answer === "pass") return defaultFixture(request)
    return r.answer
  }
  const t = await load()
  const own: Table = {}
  for (const [k, list] of Object.entries(t)) {
    const mine = list.filter((v) => v.screen.replace(/^[a-z-]+\//, "").replace(/\.html$/, "") === screen)
    if (mine.length) own[k] = mine
  }
  const hit = findFixture(own, request.method, url)
  if (hit) {
    const body = hit.body as { _tag?: unknown } | null
    const tag = body && typeof body === "object" && typeof body._tag === "string" ? body._tag : null
    return { status: tag ? (STATUS[tag] ?? 400) : 200, body: hit.body }
  }
  if (SECTION.test(url.pathname) && request.method === "GET") {
    if (/-loading$/.test(screen)) return never()
    if (/-error$/.test(screen)) return down
  }
  return (await actionFixture(request)) ?? defaultFixture(request)
}

/**
 * Writes the design table can't answer as they are (it keeps request bodies beside responses): each answers
 * from a design screen's own response, so a bulk action, an export or an import started in fixture mode lands
 * on the designed result.
 */
async function actionFixture(request: Request): Promise<Answer | undefined> {
  const url = new URL(request.url)
  if (request.method !== "POST") return undefined
  const t = await load()
  const from = (key: string, screen: string, has?: string) =>
    (t[key] ?? []).find(
      (v) =>
        v.screen.endsWith(`/${screen}.html`) &&
        (!has || (v.body !== null && typeof v.body === "object" && has in (v.body as object))),
    )?.body
  let body: Record<string, unknown> = {}
  try {
    body = (await request.clone().json()) as Record<string, unknown>
  } catch {}
  if (url.pathname === "/v1/contacts/bulk") {
    if (Array.isArray(body.ids)) {
      const r = from("POST /v1/contacts/bulk", "contacts-bulk-result", "mode")
      return r ? { status: 200, body: r } : undefined
    }
    const job = from("GET /v1/contacts/bulk/{id}", "contacts-bulk-queued")
    return job ? { status: 200, body: { mode: "async", job } } : undefined
  }
  if (url.pathname === "/v1/exports" && body.kind === "contacts") {
    const r = from("POST /v1/exports", "contacts-export-ready", "id") as { rows?: number } | undefined
    if (!r) return undefined
    return url.searchParams.get("dryRun")
      ? { status: 200, body: { dryRun: true, rows: r.rows ?? 0 } }
      : { status: 200, body: r }
  }
  if (url.pathname === "/v1/imports/contacts") {
    const r = from("GET /v1/imports/{id}", "import-cancel")
    return r ? { status: 200, body: r } : undefined
  }
  return undefined
}

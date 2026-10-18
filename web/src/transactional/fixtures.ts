/**
 * Fixture-mode overrides for Transactional's messages, templates and quick start (registered in
 * src/fixtures/overrides.ts), typed against the generated schema. They answer from the design's own fixtures
 * (fixtures.json, loaded on first use) and add what a static table can't:
 *
 *   GET /v1/messages            filters applied to the design's log, like the API does (q matches an exact id
 *                               or Cloudflare id, or the start of a recipient)
 *   GET /v1/messages/{id}       the design's detail for that id, or one built from its log row
 *   GET /v1/messages/{id}/raw   the stored copy rebuilt as message/rfc822
 *   templates                   rendering, drafts, publish, rollback, create and test sends, kept in memory
 *
 * A page's `?state=` picks a designed state for its list: `empty`, `error` or `loading`. Ids pick detail
 * states: `msg_missing` (404), `msg_error` and `tpl_error` (503).
 */
import type { Answer, Json, Override } from "../fixtures/overrides.ts"
import { type LogSearch, parseLogSearch, variablesIn } from "./logic.ts"

type Variant = { screen: string; path: string; query: string; body: unknown }
type Table = Record<string, Variant[]>

type MessageList = Json<"/v1/messages", "get">
type Message = MessageList["messages"][number]
type MessageDetail = Json<"/v1/messages/{id}", "get">
type TemplateList = Json<"/v1/templates", "get">
type TemplateDetail = Json<"/v1/templates/{id}", "get">
type Rendered = Json<"/v1/templates/preview", "post">
type TestSent = Json<"/v1/templates/{id}/test", "post">

/** Sample values the design's editor shows, so fixture mode opens on the populated preview. */
export const FIXTURE_SAMPLES: Record<string, Record<string, string>> = {
  tpl_reset: {
    name: "Ada",
    email: "ada.okafor@gmail.com",
    expires_in: "30 minutes",
    reset_url: "https://coursified.app/reset?t=7f3a…",
    ip_city: "Lagos",
    requested_at: "17 Oct 2026, 17:41 UTC",
  },
  tpl_receipt: {
    name: "Ada",
    course: "Data foundations",
    amount: "₦45,000",
    url: "https://coursified.app/orders/1042",
  },
}

let table: Promise<Table> | null = null
const load = () => {
  table ??= import("../fixtures/fixtures.json").then((m) => m.default as unknown as Table)
  return table
}

/** The page's own `?state=`, which picks a designed list state in fixture mode. */
const pageState = () =>
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("state")

const refusal = (status: number, tag: string, message: string): Answer => ({
  status,
  body: { _tag: tag, message, requestId: "req_01JAF8Q2W4N6" },
})
const never = () => new Promise<Answer>(() => {}) as unknown as Answer
const ok = (body: unknown): Answer => ({ status: 200, body })

/** Answers that must wait for the fixture table resolve as a promise; findOverride awaits whatever it gets. */
const later = (f: (t: Table) => Answer | Promise<Answer>): Answer => load().then(f) as unknown as Answer

const variants = (t: Table, key: string) => t[key] ?? []
const dictFor = (t: Table, key: string, path: string) =>
  variants(t, key).find(
    (v) => v.path === path && v.body && typeof v.body === "object" && !Array.isArray(v.body),
  )?.body as Record<string, unknown> | undefined

// ── Messages ────────────────────────────────────────────────────────────────────────────────────────────────

const baseLog = (t: Table): Message[] =>
  ((
    variants(t, "GET /v1/messages").find((v) => v.screen.endsWith("transactional/messages.html"))
      ?.body as MessageList
  )?.messages ?? []) as Message[]

/** The API's own matching (src/domain/messages.ts): exact id or Cloudflare id, or a recipient prefix. */
export function filterLog(rows: readonly Message[], s: LogSearch): Message[] {
  return rows.filter((m) => {
    if (s.status && m.status !== s.status) return false
    if (s.stream && m.stream !== s.stream) return false
    if (s.templateId && m.templateId !== s.templateId) return false
    const at = Number(m.createdAt)
    if (s.from && at < s.from) return false
    if (s.to && at > s.to) return false
    if (s.q) {
      const q = s.q.toLowerCase()
      const hit =
        m.id === s.q ||
        m.cfMessageId === s.q ||
        m.cfMessageId === `<${s.q}>` ||
        m.recipient.toLowerCase().startsWith(q)
      if (!hit) return false
    }
    return true
  })
}

const detailFrom = (m: Message): MessageDetail => ({
  ...m,
  smtpResponse: null,
  idempotencyKey: null,
  nextAttemptAt: null,
  events: [],
  headers: [
    { name: "From", value: m.sender },
    { name: "To", value: m.recipient },
    { name: "Subject", value: m.subject },
  ],
  rendered: {
    from: m.sender,
    to: [m.recipient],
    subject: m.subject,
    html: `<!doctype html><html><body style="margin:0;font:16px/1.55 system-ui,sans-serif"><div style="max-width:520px;margin:0 auto;padding:28px 24px"><p style="font-weight:700;font-size:18px">Coursified</p><h1 style="font-size:22px">${m.subject}</h1><p>Sample copy for this fixture message.</p></div></body></html>`,
    text: m.subject,
    attachments: [],
  },
})

async function messageDetail(t: Table, id: string): Promise<MessageDetail | null> {
  const d = dictFor(t, "GET /v1/messages/{id}", `/v1/messages/${id}`) as unknown as MessageDetail | undefined
  if (d) {
    // The design's detail fixtures stand in for the body with a short comment; give the frame a real email.
    const r = d.rendered
    if (r && (!r.html || r.html.length < 200))
      return { ...d, rendered: { ...r, html: detailFrom(d).rendered?.html ?? null } }
    return d
  }
  const row = baseLog(t).find((m) => m.id === id)
  return row ? detailFrom(row) : null
}

export function rawFrom(m: MessageDetail): string {
  const r = m.rendered
  const lines = [
    ...m.headers.map((h) => `${h.name}: ${h.value}`),
    `Date: ${new Date(Number(m.createdAt)).toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    "X-Mailyard-Copy: rebuilt from the message log",
  ]
  if (!r) return `${lines.join("\n")}\n\n`
  const b = "=_my7f3a"
  return [
    ...lines,
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    r.text ?? "",
    "",
    `--${b}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    r.html ?? "",
    `--${b}--`,
  ].join("\n")
}

// ── Templates, kept in memory so drafts, publish and rollback behave ───────────────────────────────────────

/** Variables the design marks optional; everything else a fixture template reads is required. */
const OPTIONAL = new Set(["ip_city", "requested_at"])

const templates = new Map<string, TemplateDetail>()

const EMAIL_CSS =
  "body{margin:0;background:#fff;color:#171717;font:16px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}.w{max-width:520px;margin:0 auto;padding:28px 24px}h1{font-size:22px;margin:0 0 16px}p{margin:0 0 14px}.button{display:inline-block;background:#171717;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600}.small{color:#666;font-size:13px;border-top:1px solid #ddd;padding-top:12px}.m{background:#fde2e2;color:#7f1d1d;border-radius:3px;padding:0 3px;font-family:monospace}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.button{background:#eee;color:#111}.small{color:#aaa;border-color:#333}}"

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** A stand-in for the server's renderer: fills variables, marks missing ones, wraps in the design's email CSS. */
export function renderFixture(
  subject: string,
  source: string,
  text: string | null,
  data: Record<string, string>,
  required: readonly string[],
): Rendered {
  const used = variablesIn(`${subject}\n${source}\n${text ?? ""}`)
  const fill = (s: string, html: boolean) =>
    s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, v: string) =>
      data[v] ? (html ? esc(data[v]) : data[v]) : html ? `<span class="m">${all}</span>` : all,
    )
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${EMAIL_CSS}</style></head><body><div class="w"><p style="font-weight:700;font-size:18px;margin-bottom:22px">Coursified</p>${fill(source, true)}</div></body></html>`
  const req = required.filter((v) => used.includes(v))
  return {
    subject: fill(subject, false),
    html,
    text: fill(text ?? source.replace(/<[^>]+>/g, ""), false),
    size: new Blob([html]).size,
    withinLimit: true,
    variables: { used, required: req, missing: req.filter((v) => !data[v]) },
  }
}

async function template(t: Table, id: string): Promise<TemplateDetail | null> {
  const hit = templates.get(id)
  if (hit) return hit
  const d = dictFor(t, "GET /v1/templates/{id}", `/v1/templates/${id}`) as unknown as
    | TemplateDetail
    | undefined
  const list = (
    variants(t, "GET /v1/templates").find((v) => v.query === "include=usage")?.body as TemplateList
  )?.templates
  const row = list?.find((x) => x.id === id)
  let out: TemplateDetail | null = null
  if (d && d.id === id) out = d
  else if (row) {
    const n = Number(row.latestVersion)
    const pub = row.publishedVersion === null ? null : Number(row.publishedVersion)
    const source =
      id === "tpl_receipt"
        ? '<h1>Thanks, {{name}}</h1>\n<p>We’ve received your payment for {{course}}: {{amount}}.</p>\n<p><a href="{{url}}" class="button">View your order</a></p>'
        : `<h1>{{name}}, a note from Coursified</h1>\n<p>This is ${row.name}.</p>\n<p><a href="{{link}}" class="button">Open Coursified</a></p>`
    const vars = variablesIn(source)
    out = {
      ...row,
      latest: {
        version: n,
        subject: row.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()),
        source,
        text: null,
        publishedAt: row.hasUnpublishedChanges || pub === null ? null : Number(row.updatedAt),
        updatedAt: Number(row.updatedAt),
        updatedBy: "key_01JA4B7Q",
        variables: { used: vars, required: vars },
      },
      versions: Array.from({ length: n }, (_, i) => {
        const v = n - i
        return {
          version: v,
          subject: row.name,
          publishedAt: pub !== null && v <= pub ? Number(row.updatedAt) - i * 86_400_000 * 6 : null,
          createdBy: "key_01JA4B7Q",
          createdAt: Number(row.updatedAt) - i * 86_400_000 * 6,
        }
      }),
    }
  }
  if (out) templates.set(id, out)
  return out
}

const dataOf = (body: unknown): Record<string, string> => {
  const d = (body as { data?: unknown } | null)?.data
  if (!d || typeof d !== "object") return {}
  return Object.fromEntries(
    Object.entries(d as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]),
  )
}

function saveDraft(
  cur: TemplateDetail,
  b: { subject: string; source: string; text?: string | null },
): TemplateDetail {
  const now = Date.now()
  const published = cur.latest?.publishedAt !== null && cur.latest !== null
  const version = published ? Number(cur.latestVersion) + 1 : Number(cur.latestVersion)
  const vars = variablesIn(b.source)
  const required = cur.latest?.variables.required.filter((v) => vars.includes(v)) ?? vars
  return {
    ...cur,
    latestVersion: version,
    hasUnpublishedChanges: true,
    updatedAt: now,
    latest: {
      version,
      subject: b.subject,
      source: b.source,
      text: b.text ?? null,
      publishedAt: null,
      updatedAt: now,
      updatedBy: "root",
      variables: { used: vars, required },
    },
    versions: published
      ? [
          { version, subject: b.subject, publishedAt: null, createdBy: "root", createdAt: now },
          ...cur.versions,
        ]
      : cur.versions.map((v) => (Number(v.version) === version ? { ...v, subject: b.subject } : v)),
  }
}

export const TRANSACTIONAL_OVERRIDES: readonly Override[] = [
  {
    method: "GET",
    path: /^\/v1\/messages$/,
    answer: (_m, _b, url) => {
      const st = pageState()
      if (st === "loading") return never()
      if (st === "error") return refusal(503, "ServiceUnavailable", "Service unavailable after 10 s")
      if (st === "empty") return ok({ messages: [], nextCursor: null } satisfies MessageList)
      const s = parseLogSearch(Object.fromEntries(url.searchParams))
      const limit = Number(url.searchParams.get("limit") ?? 50)
      return later((t) => {
        const rows = filterLog(baseLog(t), s)
        return ok({ messages: rows.slice(0, limit), nextCursor: null } satisfies MessageList)
      })
    },
  },
  {
    method: "GET",
    path: /^\/v1\/messages\/([^/]+)\/raw$/,
    answer: ([, id = ""]) =>
      later(async (t) => {
        const m = await messageDetail(t, id)
        return m ? ok(rawFrom(m)) : refusal(404, "NotFound", "No message with this id.")
      }),
  },
  {
    method: "GET",
    path: /^\/v1\/messages\/([^/]+)$/,
    answer: ([, id = ""]) => {
      if (id === "msg_error") return refusal(503, "ServiceUnavailable", "Service unavailable after 10 s")
      return later(async (t) => {
        const m = await messageDetail(t, id)
        return m ? ok(m) : refusal(404, "NotFound", "No message with this id.")
      })
    },
  },
  {
    method: "POST",
    path: /^\/v1\/send$/,
    answer: (_m, body) => {
      const to = (body as { to?: unknown } | null)?.to
      const email = typeof to === "string" ? to : "ada@example.com"
      return ok({
        success: true,
        data: {
          emails: [{ contact: { id: "cnt_fixture", email }, email, status: "queued" }],
          timestamp: new Date().toISOString(),
        },
      })
    },
  },
  {
    method: "GET",
    path: /^\/v1\/templates$/,
    answer: (_m, _b, url) => {
      if (
        !/\/transactional\/templates\/?$/.test(typeof window === "undefined" ? "" : window.location.pathname)
      )
        return later((t) =>
          ok(
            (variants(t, "GET /v1/templates").find((v) => v.query === "include=usage")
              ?.body as TemplateList) ?? { templates: [] },
          ),
        )
      const st = pageState()
      if (st === "loading") return never()
      if (st === "error") return refusal(503, "ServiceUnavailable", "Service unavailable after 10 s")
      if (st === "empty") return ok({ templates: [] } satisfies TemplateList)
      const archived = url.searchParams.get("archived") === "true"
      return later((t) => {
        const base =
          (variants(t, "GET /v1/templates").find((v) => v.query === "include=usage")?.body as TemplateList)
            ?.templates ?? []
        const merged = base.map((row) => {
          const m = templates.get(row.id)
          return m
            ? {
                ...row,
                latestVersion: m.latestVersion,
                publishedVersion: m.publishedVersion,
                hasUnpublishedChanges: m.hasUnpublishedChanges,
                updatedAt: m.updatedAt,
              }
            : row
        })
        const created = [...templates.values()].filter((x) => !base.some((r) => r.id === x.id))
        return ok({
          templates: [...created, ...merged].filter((x) => archived || !x.archived),
        } satisfies TemplateList)
      })
    },
  },
  {
    method: "POST",
    path: /^\/v1\/templates$/,
    answer: (_m, body) => {
      const b = body as { name: string; kind: "html" | "blocks"; subject: string; source: string }
      const now = Date.now()
      const id = `tpl_${b.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`
      const vars = variablesIn(b.source)
      const t: TemplateDetail = {
        id,
        name: b.name,
        kind: b.kind,
        publishedVersion: null,
        latestVersion: 1,
        hasUnpublishedChanges: true,
        archived: false,
        updatedAt: now,
        createdAt: now,
        usage: { sends30d: 0, usedBy: [] },
        latest: {
          version: 1,
          subject: b.subject,
          source: b.source,
          text: null,
          publishedAt: null,
          updatedAt: now,
          updatedBy: "root",
          variables: { used: vars, required: vars },
        },
        versions: [{ version: 1, subject: b.subject, publishedAt: null, createdBy: "root", createdAt: now }],
      }
      templates.set(id, t)
      return ok(t)
    },
  },
  {
    method: "POST",
    path: /^\/v1\/templates\/preview$/,
    answer: (_m, body) => {
      const b = body as { subject?: string; source?: string; text?: string | null }
      const used = variablesIn(b.source ?? "")
      const required = used.filter((v) => !OPTIONAL.has(v))
      return ok(renderFixture(b.subject ?? "", b.source ?? "", b.text ?? null, dataOf(body), required))
    },
  },
  {
    method: "PUT",
    path: /^\/v1\/templates\/([^/]+)\/draft$/,
    answer: ([, id = ""], body) =>
      later(async (t) => {
        const cur = await template(t, id)
        if (!cur) return refusal(404, "NotFound", "No template with this id.")
        const next = saveDraft(cur, body as { subject: string; source: string; text?: string | null })
        templates.set(id, next)
        return ok(next)
      }),
  },
  {
    method: "POST",
    path: /^\/v1\/templates\/([^/]+)\/publish$/,
    answer: ([, id = ""]) =>
      later(async (t) => {
        const cur = await template(t, id)
        if (!cur?.latest) return refusal(404, "NotFound", "No template with this id.")
        const now = Date.now()
        const v = Number(cur.latestVersion)
        const next: TemplateDetail = {
          ...cur,
          publishedVersion: v,
          hasUnpublishedChanges: false,
          updatedAt: now,
          latest: { ...cur.latest, publishedAt: now },
          versions: cur.versions.map((x) => (Number(x.version) === v ? { ...x, publishedAt: now } : x)),
        }
        templates.set(id, next)
        return ok(next)
      }),
  },
  {
    method: "POST",
    path: /^\/v1\/templates\/([^/]+)\/rollback$/,
    answer: ([, id = ""], body) =>
      later(async (t) => {
        const cur = await template(t, id)
        const to = Number((body as { version?: number } | null)?.version)
        const old = cur?.versions.find((x) => Number(x.version) === to)
        if (!cur?.latest || !old) return refusal(404, "NotFound", "No such version.")
        const now = Date.now()
        const v = Number(cur.latestVersion) + 1
        const next: TemplateDetail = {
          ...cur,
          publishedVersion: v,
          latestVersion: v,
          hasUnpublishedChanges: false,
          updatedAt: now,
          latest: {
            ...cur.latest,
            version: v,
            subject: old.subject,
            publishedAt: now,
            updatedAt: now,
            updatedBy: "root",
          },
          versions: [
            { version: v, subject: old.subject, publishedAt: now, createdBy: "root", createdAt: now },
            ...cur.versions,
          ],
        }
        templates.set(id, next)
        return ok(next)
      }),
  },
  {
    method: "POST",
    path: /^\/v1\/templates\/([^/]+)\/render$/,
    answer: ([, id = ""], body) =>
      later(async (t) => {
        const cur = await template(t, id)
        if (!cur?.latest) return refusal(404, "NotFound", "No template with this id.")
        const version = (body as { version?: unknown } | null)?.version
        const past =
          (typeof version === "number" && version < Number(cur.latestVersion)) ||
          (version === "published" && cur.hasUnpublishedChanges)
        // Earlier versions differ from the draft in the design only by wording (template-publish.html), so the
        // fixture ages the source: the link "expires in 1 hour" and there's no "Sent from" line.
        const source = past
          ? cur.latest.source.replace("{{expires_in}}", "1 hour").replace(/\n<p class="small">.*<\/p>/, "")
          : cur.latest.source
        const text = past ? (cur.latest.text?.replace("{{expires_in}}", "1 hour") ?? null) : cur.latest.text
        return ok(
          renderFixture(cur.latest.subject, source, text, dataOf(body), cur.latest.variables.required),
        )
      }),
  },
  {
    method: "POST",
    path: /^\/v1\/templates\/([^/]+)\/test$/,
    answer: ([, id = ""], body) =>
      later(async (t) => {
        const cur = await template(t, id)
        if (!cur) return refusal(404, "NotFound", "No template with this id.")
        const b = body as { to: string[]; version?: unknown }
        const v =
          typeof b.version === "number"
            ? b.version
            : b.version === "published"
              ? Number(cur.publishedVersion ?? cur.latestVersion)
              : Number(cur.latestVersion)
        const sent: TestSent = {
          version: v,
          sent: b.to.map((email, i) => ({
            email,
            messageId: `msg_01JAF0${17 + i}`,
            status: /lola\.ade|suppressed/i.test(email) ? "rejected" : i === 0 ? "sent" : "queued",
          })),
        }
        return ok(sent)
      }),
  },
  {
    method: "GET",
    path: /^\/v1\/templates\/([^/]+)$/,
    answer: ([, id = ""]) => {
      if (id === "tpl_error") return refusal(503, "ServiceUnavailable", "Service unavailable after 10 s")
      return later(async (t) => {
        const cur = await template(t, id)
        return cur ? ok(cur) : refusal(404, "NotFound", "No template with this id.")
      })
    },
  },
]

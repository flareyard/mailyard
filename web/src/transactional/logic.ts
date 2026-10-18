/**
 * Pure logic for Transactional's message log, message detail, templates and quick start. No React, no fetch,
 * so every rule here is tested in logic.test.ts.
 */

import { utcShort } from "../ops/format.ts"
import type { IconName } from "../ui/icons.tsx"

// ── Message log filters (HANDOFF-ops §22): every filter maps one to one onto GET /v1/messages ──────────────

export const STATUSES = [
  "queued",
  "sent",
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
] as const
export type Status = (typeof STATUSES)[number]

export const STREAMS = ["transactional", "campaign", "automation", "reply", "mailbox", "test"] as const
export type Stream = (typeof STREAMS)[number] | "system"

export const STREAM_LABEL: Record<string, string> = {
  transactional: "Transactional",
  campaign: "Campaign",
  automation: "Automation",
  reply: "Reply",
  mailbox: "Mailbox reply",
  test: "Test send",
  system: "System",
}

export type LogSearch = {
  q?: string
  status?: Status
  stream?: Stream
  templateId?: string
  /** Epoch ms, UTC. */
  from?: number
  to?: number
  cursor?: string
  /** A design link (`?open=msg_…`): the log hands over to the message's own page. */
  open?: string
}

const isStatus = (v: unknown): v is Status =>
  typeof v === "string" && (STATUSES as readonly string[]).includes(v)
const isStream = (v: unknown): v is Stream =>
  typeof v === "string" && ([...STREAMS, "system"] as readonly string[]).includes(v)
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const ms = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** The route's validateSearch: keeps only what the API understands, so a pasted link can't break the view. */
export function parseLogSearch(s: Record<string, unknown>): LogSearch {
  const out: LogSearch = {}
  const q = str(s.q)
  if (q) out.q = q
  if (isStatus(s.status)) out.status = s.status
  if (isStream(s.stream)) out.stream = s.stream
  const t = str(s.templateId)
  if (t) out.templateId = t
  const from = ms(s.from)
  if (from) out.from = from
  const to = ms(s.to)
  if (to) out.to = to
  const c = str(s.cursor)
  if (c) out.cursor = c
  const o = str(s.open)
  if (o) out.open = o
  return out
}

/** The GET /v1/messages query for a view (numbers on the wire are strings). */
export function logQuery(s: LogSearch, limit = 50) {
  return {
    ...(s.q ? { q: s.q } : {}),
    ...(s.status ? { status: s.status } : {}),
    ...(s.stream ? { stream: s.stream } : {}),
    ...(s.templateId ? { templateId: s.templateId } : {}),
    ...(s.from ? { from: String(s.from) } : {}),
    ...(s.to ? { to: String(s.to) } : {}),
    ...(s.cursor ? { cursor: s.cursor } : {}),
    limit: String(limit),
  }
}

/** "?status=bounced&stream=transactional": the view as a link, for the footer's echo. */
export function echo(s: LogSearch): string {
  const u = new URLSearchParams()
  for (const k of ["q", "status", "stream", "templateId", "from", "to", "cursor"] as const) {
    const v = s[k]
    if (v !== undefined) u.set(k, String(v))
  }
  const q = u.toString()
  return q ? `?${q}` : "?"
}

export const hasFilters = (s: LogSearch) =>
  Boolean(s.q || s.status || s.stream || s.templateId || s.from || s.to)

const shortUtc = (v: number) => {
  const d = new Date(v)
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

export type Chip = { key: keyof LogSearch; label: string; value: string }

/** The active-filter chips, in the filter bar's order, each removable on its own. */
export function chips(s: LogSearch, templateName: (id: string) => string | undefined): Chip[] {
  const out: Chip[] = []
  if (s.q) out.push({ key: "q", label: "Search", value: s.q })
  if (s.status) out.push({ key: "status", label: "Status", value: s.status })
  if (s.stream) out.push({ key: "stream", label: "Stream", value: s.stream })
  if (s.templateId)
    out.push({ key: "templateId", label: "Template", value: templateName(s.templateId) ?? s.templateId })
  if (s.from) out.push({ key: "from", label: "From", value: shortUtc(s.from) })
  if (s.to) out.push({ key: "to", label: "To", value: shortUtc(s.to) })
  return out
}

/** The view without one filter (and back on the first page). */
export function without(s: LogSearch, key: keyof LogSearch): LogSearch {
  const { [key]: _, cursor: __, open: ___, ...rest } = s
  return rest
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────────────────

export type Tone = "pass" | "warn" | "fail" | "neutral"

/** The status pill: "Bounced hard", "Deferred", … with its colour. */
export function statusPill(status: string, bounceType?: string | null): { tone: Tone; label: string } {
  switch (status) {
    case "delivered":
      return { tone: "pass", label: "Delivered" }
    case "deferred":
      return { tone: "warn", label: "Deferred" }
    case "bounced":
      return { tone: "fail", label: bounceType ? `Bounced ${bounceType}` : "Bounced" }
    case "failed":
      return { tone: "fail", label: "Failed" }
    case "rejected":
      return { tone: "fail", label: "Rejected" }
    case "complained":
      return { tone: "fail", label: "Complained" }
    case "sent":
      return { tone: "neutral", label: "Sent" }
    default:
      return { tone: "neutral", label: status ? status[0]?.toUpperCase() + status.slice(1) : "Queued" }
  }
}

/** The red or amber line under a row's subject, when there is one. */
export function rowNote(m: {
  status: string
  attempts: number | string
  error: string | null
}): { tone: "warn" | "fail"; text: string } | null {
  if (m.status === "deferred") return { tone: "warn", text: `Attempt ${m.attempts} · Mailyard tries again` }
  if (["bounced", "failed", "rejected"].includes(m.status) && m.error) {
    // Bounces read better as the SMTP line alone; the Effect tag is noise there.
    const text = m.status === "bounced" ? m.error.replace(/^[A-Za-z]+:\s*/, "") : m.error
    return { tone: "fail", text }
  }
  return null
}

const PROVIDER: Record<string, string> = {
  gmail: "Gmail",
  google: "Gmail",
  microsoft: "Microsoft",
  outlook: "Microsoft",
  yahoo: "Yahoo",
  apple: "Apple",
  icloud: "Apple",
  other: "Other",
}
export const providerName = (p: string | null | undefined) =>
  p ? (PROVIDER[p.toLowerCase()] ?? p[0]?.toUpperCase() + p.slice(1)) : null

/** The mailbox a reply went out from, as "support@": the local part of the sender address. */
export function senderLocal(sender: string): string {
  const addr = sender.match(/<([^>]+)>/)?.[1] ?? sender
  const local = addr.split("@")[0]
  return local ? `${local}@` : addr
}

// ── Message detail: the trail ───────────────────────────────────────────────────────────────────────────────

export type EventType =
  | "accepted"
  | "sent"
  | "deferred"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "rejected"
  | "suppressed"
  | "opened"
  | "clicked"

const EVENT: Record<
  EventType,
  { label: string; tone: "is-info" | "is-pass" | "is-warn" | "is-fail"; icon: IconName }
> = {
  accepted: { label: "Accepted", tone: "is-info", icon: "info" },
  sent: { label: "Sent to Email Service", tone: "is-info", icon: "send" },
  deferred: { label: "Deferred", tone: "is-warn", icon: "clock" },
  delivered: { label: "Delivered", tone: "is-pass", icon: "check" },
  bounced: { label: "Bounced", tone: "is-fail", icon: "x" },
  complained: { label: "Complained", tone: "is-fail", icon: "warn" },
  failed: { label: "Failed", tone: "is-fail", icon: "x-circle" },
  rejected: { label: "Rejected", tone: "is-fail", icon: "ban" },
  suppressed: { label: "Suppressed", tone: "is-fail", icon: "ban" },
  opened: { label: "Opened", tone: "is-info", icon: "eye" },
  clicked: { label: "Clicked", tone: "is-info", icon: "link" },
}

export function eventView(e: {
  type: string
  attempt: number | string | null
  provider: string | null
  bounceType: string | null
}) {
  const base = EVENT[e.type as EventType] ?? {
    label: e.type,
    tone: "is-info" as const,
    icon: "dot" as IconName,
  }
  const label = e.type === "bounced" && e.bounceType ? `${base.label} · ${e.bounceType}` : base.label
  const meta = [
    e.attempt !== null && e.attempt !== undefined ? `Attempt ${e.attempt}` : null,
    providerName(e.provider),
    e.bounceType ? `${e.bounceType} bounce` : null,
  ].filter(Boolean)
  return { ...base, label, meta: meta.join(" · ") }
}

/** Mailyard's own retry schedule (src/domain/outbox.ts): up to 8 attempts. */
export const MAX_ATTEMPTS = 8

export type Callout = {
  tone: "error" | "warn" | "info"
  title: string
  body: string
  link?: { to: string; label: string }
}

const suppressedRejection = (m: {
  error: string | null
  events: { type: string; detail: string | null }[]
}) =>
  /SendSuppressed|suppress/i.test(m.error ?? "") ||
  m.events.some((e) => e.type === "rejected" && /SendSuppressed|suppress/i.test(e.detail ?? ""))

/** The callout above a message that didn't simply arrive: what happened, in words, and where to look next. */
export function messageCallout(m: {
  status: string
  stream: string
  source: string
  bounceType: string | null
  provider: string | null
  error: string | null
  events: { type: string; detail: string | null }[]
}): Callout | null {
  const provider = providerName(m.provider)
  switch (m.status) {
    case "bounced":
      return m.bounceType === "soft"
        ? {
            tone: "warn",
            title: "Soft bounce: the receiving server turned it away for now.",
            body: "The address exists but couldn’t take mail (a full mailbox, say). It isn’t suppressed; a later send may get through.",
          }
        : {
            tone: "error",
            title: "Hard bounce: the address doesn’t exist.",
            body: "It was added to the suppression list, so later sends to it are rejected before they’re billed. Bounce rate counts this one against your 2% warning line.",
            link: { to: "/transactional/suppressions", label: "Suppressions" },
          }
    case "deferred":
      return {
        tone: "warn",
        title: `${provider && provider !== "Other" ? `${provider} deferred it` : "The receiving server deferred it"}, so Email Service will try again.`,
        body: `Mailyard tries again on its own, up to ${MAX_ATTEMPTS} attempts, then marks it failed. Nothing to do unless it fails.`,
        link: { to: "/analytics/sending", label: "Deferral reasons" },
      }
    case "complained":
      return {
        tone: "error",
        title: `The recipient marked this ${m.stream === "campaign" ? "campaign" : "message"} as spam.`,
        body:
          m.stream === "campaign"
            ? "They were unsubscribed from every topic and suppressed for bulk mail. Complaints are measured against deliveries; Cloudflare’s warning line is 0.1%."
            : "They were suppressed for bulk mail. Complaints are measured against deliveries; Cloudflare’s warning line is 0.1%.",
        link: { to: "/domains/reputation", label: "Reputation" },
      }
    case "rejected":
      return suppressedRejection(m)
        ? {
            tone: "error",
            title: "Not sent: the recipient is suppressed.",
            body: "Mailyard refused it before Email Service, so it wasn’t billed. Remove the address under Suppressions only if they asked to hear from you again.",
            link: { to: "/transactional/suppressions", label: "Suppressions" },
          }
        : {
            tone: "error",
            title: "Not sent: Mailyard refused it before Email Service.",
            body: m.error ?? "It wasn’t billed.",
          }
    case "failed": {
      const domain = /domain/i.test(m.error ?? "")
      return {
        tone: "error",
        title: "Email Service refused this message and won’t retry it.",
        body: m.error
          ? `${m.error.replace(/^[A-Za-z]+:\s*/, "")}.`.replace(/\.\.$/, ".")
          : "Fix the cause, then resend.",
        ...(domain ? { link: { to: "/domains", label: "Domains" } } : {}),
      }
    }
    default:
      return null
  }
}

/** Why Resend is off for this message, or null when it can go again. */
export function resendBlock(m: {
  status: string
  stream: string
  error: string | null
  events: { type: string; detail: string | null }[]
  rendered: unknown | null
}): { reason: string; who: string } | null {
  const suppressed =
    (m.status === "bounced" && m.events.some((e) => e.type === "suppressed")) ||
    (m.status === "rejected" && suppressedRejection(m))
  if (suppressed)
    return {
      reason: "This address is suppressed",
      who: "Sends to it are rejected before billing. Remove it under Suppressions if the address is fixed.",
    }
  if (m.status === "complained" && m.stream === "campaign")
    return {
      reason: "The recipient marked this as spam",
      who: "Mailyard won’t resend campaign mail to someone who complained. Transactional mail to them still sends.",
    }
  if (!m.rendered)
    return {
      reason: "The sent copy wasn’t kept",
      who: "Resend repeats the exact copy that went out, and this message has none stored.",
    }
  return null
}

/** The POST /v1/send body that repeats what was sent: the stored copy, not the template, so it's exact. */
export function resendBody(m: {
  recipient: string
  rendered: { from: string; subject: string; html: string | null; text: string | null } | null
}) {
  const r = m.rendered
  if (!r) return null
  return { to: m.recipient, from: r.from, subject: r.subject, body: r.html ?? r.text ?? "" }
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** "Copy as curl": the same request against this Mailyard, with the key left as $MAILYARD_KEY. */
export function curlFor(origin: string, body: object, idempotencyKey?: string | null): string {
  return [
    `curl ${origin}/v1/send \\`,
    `  -H "Authorization: Bearer $MAILYARD_KEY" \\`,
    ...(idempotencyKey ? [`  -H "Idempotency-Key: ${idempotencyKey}-2" \\`] : []),
    `  -H "Content-Type: application/json" \\`,
    `  -d ${shellQuote(JSON.stringify(body))}`,
  ].join("\n")
}

/** A fresh idempotency key for a resend, so it's a new send rather than the first result again. */
export const resendKey = (id: string, now = Date.now()) => `resend-${id}-${now.toString(36)}`

/** Who sent a message, for the "Sent by" cell: the key's name, the campaign, the mailbox, or the stream. */
export function sentBy(
  m: { source: string; stream: string; apiKeyId: string | null; campaignId: string | null; sender: string },
  keys: Map<string, { name: string; prefix: string }>,
  campaigns: Map<string, string>,
): { name: string; prefix?: string; kind: "key" | "campaign" | "mailbox" | "stream" } {
  if (m.campaignId) {
    const name = campaigns.get(m.campaignId)
    return { name: name ?? m.campaignId, kind: "campaign" }
  }
  if (m.apiKeyId) {
    const k = keys.get(m.apiKeyId)
    return k ? { name: k.name, prefix: k.prefix, kind: "key" } : { name: m.apiKeyId, kind: "key" }
  }
  if (m.source === "mailbox" || m.stream === "reply" || m.stream === "mailbox")
    return { name: senderLocal(m.sender), kind: "mailbox" }
  return { name: STREAM_LABEL[m.stream] ?? m.stream, kind: "stream" }
}

/** "key_01JA4B7Q" → "Coursified web app"; "root" → "Admin key"; unknown ids stay as they are. */
export function actorName(by: string | null | undefined, keys: Map<string, { name: string }>): string | null {
  if (!by) return null
  if (by === "root" || by === "admin") return "Admin key"
  return keys.get(by)?.name ?? by
}

// ── Rendered copies ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Remote images are held back until you allow them (HANDOFF-ops §2): their `src` moves to `data-held-src`
 * and a transparent pixel takes its place. Returns how many were held.
 */
export function holdRemoteImages(html: string): { html: string; held: number } {
  let held = 0
  const out = html.replace(
    /<img\b([^>]*?)\ssrc\s*=\s*(["'])(https?:\/\/[^"']+)\2/gi,
    (_m, pre: string, q: string, url: string) => {
      held++
      return `<img${pre} data-held-src=${q}${url}${q} src=${q}data:image/gif;base64,R0lGODlhAQABAAAAACw=${q}`
    },
  )
  return { html: out, held }
}

/** The document a sandboxed preview frame shows: the email, with dark mode forced when asked. */
export function previewDoc(html: string, opts: { dark?: boolean; allowImages?: boolean } = {}): string {
  const body = opts.allowImages ? html : holdRemoteImages(html).html
  const dark = opts.dark
    ? `<meta name="color-scheme" content="dark"><style>:root{color-scheme:dark}html,body{background:#111;color:#eee}a{color:#8ab4ff}</style>`
    : `<meta name="color-scheme" content="light">`
  if (/<head[\s>]/i.test(body)) return body.replace(/<head([^>]*)>/i, `<head$1>${dark}`)
  return `<!doctype html><html><head><meta charset="utf-8">${dark}</head><body>${body}</body></html>`
}

/** The 5 MiB budget Cloudflare puts on a message. */
export const SIZE_LIMIT = 5 * 1024 * 1024

// ── Templates ───────────────────────────────────────────────────────────────────────────────────────────────

export type Token = { kind: "text" | "var" | "tag"; text: string; name?: string }

/** One source line, split into tags (`<p`, `</p`), `{{variables}}` and text, for the highlighted editor. */
export function tokenizeLine(line: string): Token[] {
  const out: Token[] = []
  const re = /(\{\{\s*([\w.]+)\s*\}\})|(<\/?[A-Za-z][\w-]*)/g
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ kind: "text", text: line.slice(last, m.index) })
    if (m[1]) out.push({ kind: "var", text: m[1], name: m[2] ?? "" })
    else out.push({ kind: "tag", text: m[3] ?? "" })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ kind: "text", text: line.slice(last) })
  return out
}

/** Variables a source uses, in order of first appearance (the server says the same in `variables.used`). */
export function variablesIn(source: string): string[] {
  const seen = new Set<string>()
  for (const m of source.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) if (m[1]) seen.add(m[1])
  return [...seen]
}

/** Required variables with no sample value: what a real send would fail on. */
export function missingVars(required: readonly string[], data: Record<string, string>): string[] {
  return required.filter((v) => !(data[v] ?? "").trim())
}

/** Sample data as the API's `data`: blank values are left out so they count as missing. */
export function sampleData(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""))
}

/** The version a template shows: "v5 live", "Draft v6", and the state pill. */
export function versionState(t: {
  publishedVersion: number | string | null
  latestVersion: number | string
  hasUnpublishedChanges: boolean
}): { live: string; draft: { tone: Tone; label: string } } {
  const pub = t.publishedVersion === null ? null : Number(t.publishedVersion)
  const latest = Number(t.latestVersion)
  return {
    live: pub ? `v${pub} live` : "Not published",
    draft: t.hasUnpublishedChanges
      ? { tone: "warn", label: `Draft v${latest}` }
      : pub
        ? { tone: "pass", label: "Up to date" }
        : { tone: "warn", label: `Draft v${latest}` },
  }
}

export type VersionRow = {
  version: number
  subject: string
  state: "draft" | "live" | "past" | "superseded"
  publishedAt: number | null
  createdAt: number
  createdBy: string | null
}

/**
 * The versions list, newest first: the latest unpublished one is the draft, the published one is live, earlier
 * published ones can be rolled back to, and an unpublished one that isn't latest was superseded (a rollback
 * publishes a copy as a new version, so the old draft stays in history).
 */
export function versionRows(t: {
  publishedVersion: number | string | null
  latestVersion: number | string
  versions: {
    version: number | string
    subject: string
    publishedAt: number | string | null
    createdBy: string | null
    createdAt: number | string
  }[]
}): VersionRow[] {
  const pub = t.publishedVersion === null ? null : Number(t.publishedVersion)
  const latest = Number(t.latestVersion)
  return [...t.versions]
    .map((v) => {
      const n = Number(v.version)
      const publishedAt = v.publishedAt === null ? null : Number(v.publishedAt)
      const state: VersionRow["state"] =
        n === pub ? "live" : publishedAt === null ? (n === latest ? "draft" : "superseded") : "past"
      return {
        version: n,
        subject: v.subject,
        state,
        publishedAt,
        createdAt: Number(v.createdAt),
        createdBy: v.createdBy,
      }
    })
    .sort((a, b) => b.version - a.version)
}

/** Line diff of two texts (LCS): what the publish sheet shows between the live copy and the draft. */
export function lineDiff(a: string, b: string): { kind: "same" | "del" | "add"; text: string }[] {
  const x = a.split("\n")
  const y = b.split("\n")
  const n = x.length
  const m = y.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i] as number[]
      row[j] = x[i] === y[j] ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  const out: { kind: "same" | "del" | "add"; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: "same", text: x[i] ?? "" })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) out.push({ kind: "del", text: x[i++] ?? "" })
    else out.push({ kind: "add", text: y[j++] ?? "" })
  }
  while (i < n) out.push({ kind: "del", text: x[i++] ?? "" })
  while (j < m) out.push({ kind: "add", text: y[j++] ?? "" })
  return out
}

/** How the variables change between two versions, for the publish and rollback sheets. */
export function varChanges(
  from: { used: readonly string[]; required: readonly string[] },
  to: { used: readonly string[]; required: readonly string[] },
) {
  return {
    added: to.used.filter((v) => !from.used.includes(v)),
    removed: from.used.filter((v) => !to.used.includes(v)),
    nowRequired: to.required.filter((v) => !from.required.includes(v)),
  }
}

/** A list in words: "a", "a and b", "a, b and c". */
export const andList = (xs: readonly string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`

// ── Send a test (HAL-3415) ──────────────────────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export type TestVersion = { kind: "latest" } | { kind: "published" } | { kind: "number"; n: number }

export type TestForm = { to: string[]; version: TestVersion; data: string; from: string }

export type TestErrors = { to?: string; version?: string; data?: string; from?: string }

/** Checks the test sheet before a round trip; the API's 400 says the same things. */
export function checkTest(f: TestForm, latest: number): TestErrors {
  const e: TestErrors = {}
  const to = f.to.map((t) => t.trim()).filter(Boolean)
  if (!to.length) e.to = "Add at least one address."
  else if (to.length > 5) e.to = "Five addresses at most."
  else {
    const bad = to.find((t) => !EMAIL.test(t))
    if (bad) e.to = `${bad} isn’t an email address.`
  }
  if (
    f.version.kind === "number" &&
    (!Number.isInteger(f.version.n) || f.version.n < 1 || f.version.n > latest)
  )
    e.version = `Choose a version from 1 to ${latest}.`
  if (f.data.trim()) {
    try {
      const v = JSON.parse(f.data) as unknown
      if (!v || typeof v !== "object" || Array.isArray(v))
        e.data = 'Test data is a JSON object, like { "name": "Ada" }.'
    } catch {
      e.data = "That isn’t valid JSON."
    }
  }
  if (f.from.trim() && !EMAIL.test(f.from.match(/<([^>]+)>/)?.[1] ?? f.from.trim()))
    e.from = "From is an address, like Name <no-reply@your.domain>."
  return e
}

export function testBody(f: TestForm) {
  const to = f.to.map((t) => t.trim()).filter(Boolean)
  const version = f.version.kind === "number" ? f.version.n : f.version.kind
  return {
    to,
    version,
    ...(f.data.trim() ? { data: JSON.parse(f.data) as Record<string, unknown> } : {}),
    ...(f.from.trim() ? { from: f.from.trim() } : {}),
  }
}

/** The pill for a test recipient's result. */
export function testStatus(status: string): { tone: Tone; label: string } {
  if (/suppress/i.test(status)) return { tone: "fail", label: "Rejected: suppressed" }
  if (status === "rejected" || status === "failed")
    return { tone: "fail", label: status === "failed" ? "Failed" : "Rejected" }
  if (status === "sent" || status === "delivered")
    return { tone: "pass", label: status === "sent" ? "Sent" : "Delivered" }
  return { tone: "neutral", label: status ? status[0]?.toUpperCase() + status.slice(1) : "Queued" }
}

/** "17 Oct, 17:34 UTC"-style stamp for a version row. */
export const versionStamp = (ms: number) => utcShort(ms).replace(/^\w+ /, "")

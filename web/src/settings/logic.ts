/**
 * Pure logic for the Settings pages (HAL-3309): brand contrast exactly as the API checks it, form diffs for the
 * save bars, rule summaries and reordering, session and invite wording. Tested in logic.test.ts.
 */
import { num } from "../lib/format.ts"

// ── Brand ───────────────────────────────────────────────────────────────────────────────────────────────────

export const COLOR_KEYS = [
  "bg",
  "surface",
  "fg",
  "body",
  "muted",
  "border",
  "indigo",
  "lime",
  "red",
  "white",
] as const
export type ColorKey = (typeof COLOR_KEYS)[number]
export type Colors = Partial<Record<ColorKey, string>>

/** Mailyard's default theme (src/templates/kit.ts DEFAULT_THEME), which a brand's colours merge over. */
export const DEFAULT_COLORS: Record<ColorKey, string> = {
  bg: "#fcfcfc",
  surface: "#ebedef",
  fg: "#0c0c0c",
  body: "#3a3a3a",
  muted: "#6a6f76",
  border: "#dee0e1",
  indigo: "#2f5bd8",
  lime: "#ffffff",
  red: "#cc272e",
  white: "#ffffff",
}

export const COLOR_LABEL: Record<ColorKey, string> = {
  bg: "Page background",
  surface: "Notices and panels",
  fg: "Headings",
  body: "Body text",
  muted: "Secondary text",
  border: "Lines",
  indigo: "Accent (buttons, links)",
  lime: "Highlight",
  red: "Errors",
  white: "Card and text on the accent",
}

export const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v)

const luminance = (hex: string) => {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1 to 21 (src/domain/brand.ts contrastRatio). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The brand's valid colours merged over the defaults, the way the API uses them. */
export function mergedColors(colors: Colors): Record<ColorKey, string> {
  const out = { ...DEFAULT_COLORS }
  for (const k of COLOR_KEYS) {
    const v = colors[k]
    if (v && isHex(v)) out[k] = v
  }
  return out
}

export type ContrastPair = { field: `colors.${ColorKey}`; what: string; ratio: number; ok: boolean }

/** The backend's six `brandContrastProblem` pairs, every one, so the screen can show them all before saving. */
export function contrastPairs(colors: Colors): ContrastPair[] {
  const c = mergedColors(colors)
  const pairs: [`colors.${ColorKey}`, string, string, string][] = [
    ["colors.indigo", c.white, c.indigo, "White text on the accent"],
    ["colors.fg", c.fg, c.bg, "Heading text on the page background"],
    ["colors.body", c.body, c.bg, "Body text on the page background"],
    ["colors.muted", c.muted, c.bg, "Muted text on the page background"],
    ["colors.fg", c.fg, c.white, "Heading text on the card"],
    ["colors.muted", c.muted, c.white, "Muted text on the card"],
  ]
  return pairs.map(([field, fg, bg, what]) => {
    const ratio = contrastRatio(fg, bg)
    return { field, what, ratio, ok: ratio >= 4.5 }
  })
}

/** The API's own refusal for the first failing pair, word for word, or null when the brand saves. */
export function contrastProblem(colors: Colors): { field: string; message: string } | null {
  const bad = contrastPairs(colors).find((p) => !p.ok)
  return bad
    ? {
        field: bad.field,
        message: `${bad.what} is ${bad.ratio.toFixed(1)}:1; AA needs 4.5:1. Darken or lighten one of them.`,
      }
    : null
}

export const fmtRatio = (r: number) => `${r.toFixed(1)}:1`

/** Only the colours that are set and valid, for the PUT body (empty uses the default). */
export function cleanColors(colors: Colors): Colors {
  const out: Colors = {}
  for (const k of COLOR_KEYS) {
    const v = colors[k]?.trim()
    if (v && isHex(v)) out[k] = v
  }
  return out
}

export const MAX_LOGO_BYTES = 1024 * 1024
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

/** The backend's logo refusals, checked before uploading so the message arrives at once. */
export function logoProblem(file: { name: string; type: string; size: number }): string | null {
  const svg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name)
  if (svg || (file.type && !LOGO_TYPES.has(file.type))) return "A logo is a PNG, JPEG, WebP or GIF image."
  if (file.size > MAX_LOGO_BYTES) return "A logo is at most 1 MiB."
  return null
}

// ── Save bars ───────────────────────────────────────────────────────────────────────────────────────────────

/** "2 unsaved changes: auto-reply dates, signature" from the labels of what changed. */
export function unsavedLine(changed: string[]): string {
  if (!changed.length) return "No unsaved changes"
  return `${changed.length} unsaved change${changed.length === 1 ? "" : "s"}: ${changed.join(", ")}`
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The labels of the fields that differ between `before` and `after`. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  labels: Partial<Record<keyof T, string>>,
): string[] {
  const out: string[] = []
  for (const k of Object.keys(labels) as (keyof T)[]) {
    if (!same(before[k], after[k])) {
      const label = labels[k]
      if (label && !out.includes(label)) out.push(label)
    }
  }
  return out
}

// ── Compliance ──────────────────────────────────────────────────────────────────────────────────────────────

/** Privacy policy URL: empty hides the link; otherwise https only (HAL-3377). */
export function privacyUrlProblem(v: string): string | null {
  const s = v.trim()
  if (!s) return null
  if (!/^https:\/\//i.test(s))
    return "Use an https:// address. Mailyard won’t link to a page that isn’t secure."
  try {
    new URL(s)
    return null
  } catch {
    return "That isn’t a full web address."
  }
}

export type Tri = boolean | null
export const triFromValue = (v: string): Tri => (v === "true" ? true : v === "false" ? false : null)

/** The tracking origin as a hostname for the input ("https://t.coursified.app" → "t.coursified.app"). */
export const originHost = (origin: string | null | undefined) =>
  (origin ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "")
export const hostOrigin = (host: string) => {
  const h = originHost(host.trim())
  return h ? `https://${h}` : null
}

/** A link domain as people type it: lower case, no scheme, no path. Null when it isn't a domain. */
export function normaliseDomain(v: string): string | null {
  const d = v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Fractions shown as percentages in the inputs ("0.2" ⇄ "20"). Rounded so 0.001 reads 0.1, not 0.1000000001. */
export const toPercentInput = (f: number | string | null | undefined) => {
  const n = num(f)
  return n === null ? "" : String(Math.round(n * 100 * 1000) / 1000)
}
export const fromPercentInput = (v: string): number | null => {
  const n = Number(v.trim())
  return v.trim() !== "" && Number.isFinite(n) ? Math.round((n / 100) * 1e6) / 1e6 : null
}

// ── Mailboxes ───────────────────────────────────────────────────────────────────────────────────────────────

export type MailboxKind = "user" | "shared" | "group" | "alias" | "catch_all"
export const KIND_LABEL: Record<MailboxKind, string> = {
  user: "Personal",
  shared: "Shared",
  group: "Group",
  alias: "Alias",
  catch_all: "Catch-all",
}
export const ACCESS_LABEL = {
  owner: "Owner · manages it",
  member: "Member · reads and replies",
  viewer: "Viewer · reads only",
} as const

/** A mailbox's address from its local part and domain; a catch-all is `*@domain`. */
export const mailboxAddress = (local: string, domain: string, kind: MailboxKind) =>
  kind === "catch_all" ? `*@${domain}` : `${local.trim().toLowerCase()}@${domain}`

/** "24 – 28 Oct" for an auto-reply window, or null when it's off or has no dates. */
export function autoReplyWindow(
  a: { enabled: boolean; startsAt: unknown; endsAt: unknown } | null,
): string | null {
  if (!a?.enabled) return null
  const s = num(a.startsAt as number | null)
  const e = num(a.endsAt as number | null)
  const day = (ms: number) => new Date(ms).getUTCDate()
  const mon = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })
  if (s !== null && e !== null)
    return mon(s) === mon(e) ? `${day(s)} – ${day(e)} ${mon(e)}` : `${day(s)} ${mon(s)} – ${day(e)} ${mon(e)}`
  if (s !== null) return `From ${day(s)} ${mon(s)}`
  if (e !== null) return `Until ${day(e)} ${mon(e)}`
  return "On"
}

export const DEFAULT_SPAM = 5
export const clampSpam = (v: number) => Math.min(20, Math.max(1, Math.round(v)))

// ── Rules ───────────────────────────────────────────────────────────────────────────────────────────────────

export type Condition =
  | {
      field: "from" | "to" | "cc" | "recipients" | "subject" | "listId" | "tag" | "body"
      op: Op
      value: string
    }
  | { field: "hasAttachment" | "automated"; value: boolean }
export type Op = "contains" | "notContains" | "equals" | "startsWith" | "endsWith"
export type Action =
  | { type: "label"; labelId: string }
  | { type: "archive" | "trash" | "spam" | "markRead" | "star" | "skipSpamCheck" }
  | { type: "forward"; to: string[] }
  | { type: "autoReply"; subject: string; body: string }
  | { type: "webhook"; endpointId: string }
  | { type: "assign"; assignee: string }

export const FIELD_LABEL: Record<Condition["field"], string> = {
  from: "From",
  to: "To",
  cc: "Cc",
  recipients: "Any recipient",
  subject: "Subject",
  listId: "List-Id",
  tag: "Tag",
  body: "Body",
  hasAttachment: "Has attachment",
  automated: "Automated mail",
}
export const OP_LABEL: Record<Op, string> = {
  contains: "contains",
  notContains: "doesn’t contain",
  equals: "is",
  startsWith: "starts with",
  endsWith: "ends with",
}
export const ACTION_LABEL: Record<Action["type"], string> = {
  label: "Label",
  archive: "Archive",
  trash: "Move to Trash",
  spam: "Mark as spam",
  markRead: "Mark read",
  star: "Star",
  skipSpamCheck: "Skip the spam check",
  forward: "Forward to",
  autoReply: "Auto-reply",
  webhook: "Webhook",
  assign: "Assign to",
}

/** "Subject contains", plus the value shown in mono, for a rule's When line. */
export function conditionText(c: Condition): { text: string; value: string | null } {
  if (!("op" in c)) return { text: `${FIELD_LABEL[c.field]}: ${c.value ? "yes" : "no"}`, value: null }
  return { text: `${FIELD_LABEL[c.field]} ${OP_LABEL[c.op]}`, value: c.value }
}

/** Actions that only run on new mail, so "Apply to existing" skips them (HAL-3368). */
export const NEW_MAIL_ONLY = new Set<Action["type"]>(["forward", "autoReply", "webhook"])

/** A blank condition and action for the editor's "Add" buttons. */
export const blankCondition = (): Condition => ({ field: "subject", op: "contains", value: "" })
export const blankAction = (): Action => ({ type: "archive" })

/** Changes an action's type, keeping what makes sense and filling what the new type needs. */
export function retypeAction(
  a: Action,
  type: Action["type"],
  defaults: { labelId?: string; endpointId?: string; assignee?: string },
): Action {
  switch (type) {
    case "label":
      return { type, labelId: a.type === "label" ? a.labelId : (defaults.labelId ?? "") }
    case "forward":
      return { type, to: a.type === "forward" ? a.to : [] }
    case "autoReply":
      return {
        type,
        subject: a.type === "autoReply" ? a.subject : "",
        body: a.type === "autoReply" ? a.body : "",
      }
    case "webhook":
      return { type, endpointId: a.type === "webhook" ? a.endpointId : (defaults.endpointId ?? "") }
    case "assign":
      return { type, assignee: a.type === "assign" ? a.assignee : (defaults.assignee ?? "") }
    default:
      return { type }
  }
}

/** Changes a condition's field, switching between text and yes/no shapes. */
export function refieldCondition(c: Condition, field: Condition["field"]): Condition {
  if (field === "hasAttachment" || field === "automated")
    return { field, value: c.field === "hasAttachment" || c.field === "automated" ? c.value : true }
  return { field, op: "op" in c ? c.op : "contains", value: "op" in c ? c.value : "" }
}

/** What's wrong with a rule before it's saved, or null. */
export function ruleProblem(r: { name: string; conditions: Condition[]; actions: Action[] }): string | null {
  if (!r.name.trim()) return "Give the rule a name."
  if (!r.conditions.length) return "Add at least one condition."
  if (r.conditions.some((c) => "op" in c && !c.value.trim())) return "Every condition needs a value."
  if (!r.actions.length) return "Add at least one action."
  for (const a of r.actions) {
    if (a.type === "label" && !a.labelId) return "Choose a label."
    if (a.type === "forward" && !a.to.filter(Boolean).length) return "Add an address to forward to."
    if (a.type === "webhook" && !a.endpointId) return "Choose a webhook."
    if (a.type === "assign" && !a.assignee) return "Choose who to assign to."
    if (a.type === "autoReply" && (!a.subject.trim() || !a.body.trim()))
      return "An auto-reply needs a subject and a message."
  }
  return null
}

/** Moves the item at `from` by `delta` places, clamped; returns a new array. */
export function move<T>(list: readonly T[], from: number, delta: number): T[] {
  const to = Math.min(list.length - 1, Math.max(0, from + delta))
  if (to === from) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

/** Moves the item at `from` to index `to`. */
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  return move(list, from, to - from)
}

// ── Sessions ────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a session ends when it does: 14 days after last use, or the 30-day cap, whichever is first. */
export function sessionEndsWhy(s: { expiresAt: unknown; absoluteExpiresAt: unknown }): string {
  const e = num(s.expiresAt as number)
  const a = num(s.absoluteExpiresAt as number)
  return e !== null && a !== null && a <= e ? "30-day cap" : "14 days after last use"
}

export const sessionEnds = (s: { expiresAt: unknown; absoluteExpiresAt: unknown }) => {
  const e = num(s.expiresAt as number)
  const a = num(s.absoluteExpiresAt as number)
  if (e === null) return a
  if (a === null) return e
  return Math.min(e, a)
}

// ── Members and invites ─────────────────────────────────────────────────────────────────────────────────────

/** An invite's pill: "Draft", "Pending · 6 days left", "Expired", "Accepted", "Withdrawn". */
export function inviteStatus(
  i: { status: "draft" | "sent" | "expired" | "accepted" | "revoked"; expiresAt: unknown },
  now = Date.now(),
): { label: string; tone: "neutral" | "info" | "warn" | "pass" } {
  const exp = num(i.expiresAt as number)
  const expired = i.status === "expired" || (i.status === "sent" && exp !== null && exp <= now)
  if (expired) return { label: "Expired", tone: "warn" }
  if (i.status === "draft") return { label: "Draft · not sent", tone: "neutral" }
  if (i.status === "accepted") return { label: "Accepted", tone: "pass" }
  if (i.status === "revoked") return { label: "Withdrawn", tone: "neutral" }
  const days = exp === null ? null : Math.max(0, Math.ceil((exp - now) / 86_400_000))
  return {
    label: days === null ? "Pending" : `Pending · ${days} day${days === 1 ? "" : "s"} left`,
    tone: "info",
  }
}

export const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

/** "hello@, support@" for the members table. */
export const shortAddresses = (addresses: string[]) =>
  addresses.length ? addresses.map((a) => `${a.split("@")[0]}@`).join(", ") : "—"

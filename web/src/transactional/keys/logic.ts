/**
 * API keys (HANDOFF-ops §20, §23): the pure rules behind the list and its sheets. A key is active, rotating
 * (revokedAt in the future: the old half of a rotation, still working) or revoked.
 */
import { num } from "../../lib/format.ts"

export type Scope = "send" | "track" | "read" | "admin"
export type Kind = "secret" | "public"
export type Purpose = "api" | "mcp"

export type KeyLike = {
  id: string
  name: string
  kind: Kind
  purpose: Purpose
  prefix: string
  scopes: string[]
  revokedAt: number | string | null
  lastUsedAt?: number | string | null
  createdAt?: number | string
  requests24h?: number | string
}

export type KeyState = "active" | "rotating" | "revoked"

export function keyState(k: Pick<KeyLike, "revokedAt">, now = Date.now()): KeyState {
  const r = num(k.revokedAt as number | string | null)
  if (r === null) return "active"
  return r > now ? "rotating" : "revoked"
}

export function purposeCounts(keys: readonly KeyLike[]): { all: number; api: number; mcp: number } {
  return {
    all: keys.length,
    api: keys.filter((k) => k.purpose === "api").length,
    mcp: keys.filter((k) => k.purpose === "mcp").length,
  }
}

export function stateCounts(keys: readonly KeyLike[], now = Date.now()) {
  const c = { active: 0, rotating: 0, revoked: 0 }
  for (const k of keys) c[keyState(k, now)]++
  return c
}

/** The panel meta: "6 active · 1 rotating · 1 revoked". */
export function keysMeta(keys: readonly KeyLike[], now = Date.now()): string {
  const c = stateCounts(keys, now)
  return [
    `${c.active} active`,
    c.rotating ? `${c.rotating} rotating` : null,
    c.revoked ? `${c.revoked} revoked` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * A rotation's new key: same name, created after the rotating one, still active. Marks the "new" tag on the
 * replacement row in the list.
 */
export function replacementOf(
  rotating: KeyLike,
  keys: readonly KeyLike[],
  now = Date.now(),
): KeyLike | undefined {
  return keys.find(
    (k) =>
      k.id !== rotating.id &&
      k.name === rotating.name &&
      keyState(k, now) === "active" &&
      (num(k.createdAt as number | string) ?? 0) > (num(rotating.createdAt as number | string) ?? 0),
  )
}

export const SCOPES: { id: Scope; label: string; sub: string }[] = [
  { id: "send", label: "Send", sub: "POST /v1/send, templates and test sends" },
  {
    id: "track",
    label: "Track",
    sub: "POST /v1/track events and contact upserts. The only scope a public key can have.",
  },
  {
    id: "read",
    label: "Read",
    sub: "Messages, stats, domains and settings, read-only. The web app needs it.",
  },
  {
    id: "admin",
    label: "Admin",
    sub: "Everything, including keys, webhooks, domains and settings. Give it to people, not code.",
  },
]

export type KeyDraft = { name: string; kind: Kind; scopes: Scope[]; purpose: Purpose }

/** Switching kind narrows the draft: a public key can only track, and is always `api`. */
export function withKind(d: KeyDraft, kind: Kind): KeyDraft {
  if (kind === "public") return { ...d, kind, scopes: ["track"], purpose: "api" }
  return { ...d, kind }
}

export function toggleScope(d: KeyDraft, s: Scope): KeyDraft {
  if (d.kind === "public") return d
  return { ...d, scopes: d.scopes.includes(s) ? d.scopes.filter((x) => x !== s) : [...d.scopes, s] }
}

/** What stops the draft being created, or null. Mirrors the API's own refusals. */
export function draftProblem(d: KeyDraft): string | null {
  if (!d.name.trim()) return "Give the key a name, so you can tell it apart in lists and the audit log."
  if (d.name.trim().length > 100) return "Keep the name under 100 characters."
  if (!d.scopes.length) return "Pick at least one scope."
  if (d.kind === "public" && d.purpose === "mcp") return "Public keys can’t be used for MCP"
  if (d.kind === "public" && d.scopes.some((s) => s !== "track"))
    return "A public key can only have the track scope."
  return null
}

/** Scopes in the API's canonical order. */
export const orderScopes = (scopes: readonly string[]) => {
  const order = ["send", "track", "read", "admin"]
  return [...scopes].sort((a, b) => order.indexOf(a) - order.indexOf(b))
}

export const GRACE_MAX = 604_800
export const GRACE_PRESETS: { seconds: number; label: string }[] = [
  { seconds: 0, label: "Now" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 86_400, label: "24 hours" },
  { seconds: GRACE_MAX, label: "7 days" },
]

/** The seconds field, clamped to what the API accepts (0 to 7 days), or null when it isn't a number. */
export function parseGrace(v: string): number | null {
  if (v.trim() === "") return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(GRACE_MAX, Math.max(0, Math.round(n)))
}

export const kindLabel = (k: Kind) => (k === "public" ? "Public, browser-safe" : "Secret")

/** The `.env` line handed out with a new key. */
export const envLine = (key: string) => `MAILYARD_KEY=${key}`

// ── Per-key send limits (HAL-3460) ────────────────────────────────────────────────────────────────────────

export type Recipients = "any" | "contacts" | "domains"
export type Limits = {
  sendsPerDay: number | null
  recipients: Recipients
  allowDomains: string[]
  requireApproval: boolean
}

export type LimitsDraft = {
  /** Text in the "Sends per day" field; empty means no cap. */
  cap: string
  recipients: Recipients
  allowDomains: string[]
  requireApproval: boolean
}

/** The API's limits as plain numbers (the wire may encode numbers as strings). */
export function fromApi(
  l:
    | {
        sendsPerDay: number | string | null
        recipients: Recipients
        allowDomains: readonly string[]
        requireApproval: boolean
      }
    | null
    | undefined,
): Limits | null {
  if (!l) return null
  return {
    sendsPerDay: num(l.sendsPerDay),
    recipients: l.recipients,
    allowDomains: [...l.allowDomains],
    requireApproval: l.requireApproval,
  }
}

export function toDraft(l: Limits | null | undefined): LimitsDraft {
  if (!l) return { cap: "", recipients: "any", allowDomains: [], requireApproval: false }
  return {
    cap: l.sendsPerDay === null ? "" : String(l.sendsPerDay),
    recipients: l.recipients,
    allowDomains: [...l.allowDomains],
    requireApproval: l.requireApproval,
  }
}

/** A typed domain, normalised the way the allow-list matches it (lower case, no scheme, no leading @ or dot). */
export function normalizeAllowDomain(v: string): string | null {
  const d = v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^[@.]+/, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
  if (!d || d.length > 253) return null
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) ? d : null
}

export function addDomain(list: readonly string[], v: string): { list: string[]; error: string | null } {
  const d = normalizeAllowDomain(v)
  if (!d) return { list: [...list], error: `“${v.trim()}” isn’t a domain. Type one like coursified.app.` }
  if (list.includes(d)) return { list: [...list], error: null }
  if (list.length >= 100) return { list: [...list], error: "Up to 100 domains." }
  return { list: [...list, d], error: null }
}

export function limitsProblem(d: LimitsDraft): string | null {
  if (d.cap.trim() !== "") {
    const n = Number(d.cap)
    if (!Number.isInteger(n) || n < 0 || n > 100_000)
      return "Sends per day is a whole number from 0 to 100,000."
  }
  if (d.recipients === "domains" && d.allowDomains.length === 0)
    return "Add at least one domain, or choose Anyone or Contacts only."
  return null
}

/** The PUT body; `null` clears every limit. */
export function toLimits(d: LimitsDraft): Limits {
  return {
    sendsPerDay: d.cap.trim() === "" ? null : Number(d.cap),
    recipients: d.recipients,
    allowDomains: d.recipients === "domains" ? d.allowDomains : [],
    requireApproval: d.requireApproval,
  }
}

/** Whether the draft is the same as having no limits at all (so Save sends `limits: null`). */
export const isUnlimited = (l: Limits) =>
  l.sendsPerDay === null && l.recipients === "any" && !l.requireApproval

/** A one-line summary for the list: "50 a day · coursified.app +2 · approval". */
export function limitsSummary(l: Limits | null | undefined): string {
  if (!l || isUnlimited(l)) return "No limits"
  const parts: string[] = []
  if (l.sendsPerDay !== null) parts.push(`${new Intl.NumberFormat("en").format(l.sendsPerDay)} a day`)
  if (l.recipients === "contacts") parts.push("contacts only")
  if (l.recipients === "domains")
    parts.push(
      l.allowDomains.length > 1
        ? `${l.allowDomains[0]} +${l.allowDomains.length - 1}`
        : (l.allowDomains[0] ?? ""),
    )
  if (l.requireApproval) parts.push("approval")
  return parts.join(" · ")
}

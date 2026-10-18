/**
 * Which invite screen to show (design: auth/invite-*.html; live contract HAL-3361), as a pure function of what
 * `GET /v1/invites/{token}` and `POST …/accept` answered. `410 { reason }` carries no invite, so the expired,
 * used and withdrawn screens say what they can without one.
 */
import { ApiError } from "../api/client.ts"
import { num } from "../lib/format.ts"

export type InviteState =
  | "loading"
  | "not-live"
  | "unknown"
  | "unreachable"
  | "expired"
  | "used"
  | "revoked"
  | "valid"
  | "wrong-account"
  | "already-member"

const GONE = new Set(["expired", "used", "revoked"])

export function inviteState(o: {
  ready: boolean
  live: boolean
  pending: boolean
  error: unknown
  hasInvite: boolean
  acceptError?: unknown
}): InviteState {
  if (!o.ready) return "loading"
  if (!o.live) return "not-live"
  const a = o.acceptError instanceof ApiError ? o.acceptError : null
  if (a?.status === 410 && GONE.has(String(a.reason))) return a.reason as "expired" | "used" | "revoked"
  if (a?.status === 409 && a.reason === "email-mismatch") return "wrong-account"
  if (a?.status === 409 && a.reason === "already-member") return "already-member"
  if (o.pending) return "loading"
  const e = o.error instanceof ApiError ? o.error : null
  if (e?.status === 410 && GONE.has(String(e.reason))) return e.reason as "expired" | "used" | "revoked"
  if (e?.status === 404) return "unknown"
  if (o.error) return "unreachable"
  return o.hasInvite ? "valid" : "unknown"
}

/** Who sent it: the inviter's name, or "Someone at Coursified" when the backend has none. */
export const inviterName = (invitedBy: string | null, workspace: string) =>
  invitedBy?.trim() || `Someone at ${workspace}`

/** "Thu 23 Oct" for an epoch-ms expiry, in UTC like every time on these screens. */
export const inviteDay = (v: number | string) =>
  new Date(num(v) ?? 0)
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .replace(",", "")

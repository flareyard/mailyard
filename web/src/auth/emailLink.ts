/**
 * Sign in by email (HAL-3361): `POST /v1/session/link { email }` answers `202 { sent: true }` whether or not the
 * address is a member, so the page never says which addresses are; `429` with `retryAfter` when asked too often;
 * `503 NoSystemSender` when this Mailyard has no system sender to email from. The emailed link opens a Worker
 * page that sets the session cookie, so the app needs no route for it.
 */
import { ApiError } from "../api/client.ts"

export type LinkOutcome =
  | { kind: "sent"; email: string }
  | { kind: "no-sender" }
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "unreachable" }
  | { kind: "other"; message: string; requestId?: string }

export function linkOutcome(email: string, result: { error?: unknown }): LinkOutcome {
  const e = result.error
  if (e === undefined || e === null) return { kind: "sent", email }
  if (!(e instanceof ApiError)) return { kind: "unreachable" }
  if (e.status === 503 || e.body._tag === "NoSystemSender") return { kind: "no-sender" }
  if (e.status === 429)
    return { kind: "rate-limited", retryAfter: Math.max(1, Number(e.body.retryAfter ?? 60)) }
  if (e.status >= 500) return { kind: "unreachable" }
  return e.requestId
    ? { kind: "other", message: e.message, requestId: e.requestId }
    : { kind: "other", message: e.message }
}

export const emailLooksValid = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

/**
 * Hand-written fixtures in the live contract, for routes whose design fixtures predate it (people, invites and
 * email sign-in, HAL-3361). `fixtureFetch` checks these before the design table. Bodies are typed against the
 * generated schema, so a contract change breaks them at compile time.
 *
 * A few example values pick a state, so every designed state renders in fixture mode:
 *   /invite/expired, /invite/used, /invite/revoked   → 410 with that reason
 *   /invite/unknown                                  → 404
 *   /invite/wrong-account, /invite/member            → accept answers 409 email-mismatch / already-member
 *   any other token                                  → a valid invite; accepting signs you in
 *   sign-in link to …@no-sender.example              → 503 NoSystemSender
 *   sign-in link to …@rate-limited.example           → 429
 */
import { screenFixture } from "../audience/kit/fixtureScreens.ts"
import { MAIL_OVERRIDES } from "../mail/fixtures.ts"

import { ANALYTICS_OVERRIDES } from "../analytics/fixtures.ts"
import type { paths } from "../api/schema"
import { DOMAINS_OVERRIDES } from "../domains/fixtures.ts"
import { SETTINGS_AGENTS_OVERRIDES } from "../settings/agents-fixtures.ts"
import { SETTINGS_OVERRIDES } from "../settings/fixtures.ts"
import { TRANSACTIONAL_OVERRIDES } from "../transactional/fixtures.ts"
import { TRANSACTIONAL_KEYS_OVERRIDES } from "../transactional/keys-fixtures.ts"

export type Json<
  P extends keyof paths,
  M extends "get" | "post" | "put" | "patch" | "delete",
  S extends number = 200,
> = paths[P][M] extends {
  responses: { [K in S]: { content: { "application/json": infer R } } }
}
  ? R
  : never

type Invite = Json<"/v1/invites/{token}", "get">
type MeBody = Json<"/v1/invites/{token}/accept", "post">
type LinkSent = Json<"/v1/session/link", "post", 202>
type Claimed = Json<"/v1/workspace/claim", "post">

export type Answer = { status: number; body: unknown; headers?: Record<string, string> }
export type Override = {
  method: string
  path: RegExp
  answer: (m: RegExpMatchArray, body: unknown, url: URL) => Answer
}

const DAY = 86_400_000
const workspace = {
  id: "ws_01JA3Q8M2K",
  name: "Coursified",
  logoUrl: null,
  url: "https://mail.coursified.app",
  host: "mail.coursified.app",
  claimed: true,
}

const invite = (): Invite => ({
  email: "tolu@coursified.app",
  role: "sender",
  workspace: "Coursified",
  invitedBy: "Halleluyah Oludele",
  message: "Welcome aboard: you’ll run the course newsletters from hello@.",
  expiresAt: Date.now() + 5 * DAY,
  mailboxes: [{ mailboxId: "mbx_hello", access: "member", address: "hello@coursified.app" }],
})

const tolu: MeBody = {
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
}

const refusal = (status: number, tag: string, reason: string, message: string): Answer => ({
  status,
  body: { _tag: tag, reason, message, requestId: "fixture" },
})

const GONE: Record<string, string> = {
  expired: "This invite has expired.",
  used: "This invite was already accepted.",
  revoked: "This invite was withdrawn.",
}

export const OVERRIDES: readonly Override[] = [
  {
    method: "GET",
    path: /^\/v1\/invites\/([^/]+)$/,
    answer: ([, token = ""]) => {
      if (token === "unknown") return refusal(404, "NotFound", "unknown", "No invite matches this link.")
      const gone = GONE[token]
      if (gone) return refusal(410, "Gone", token, gone)
      return { status: 200, body: invite() }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/invites\/([^/]+)\/accept$/,
    answer: ([, token = ""]) => {
      const gone = GONE[token]
      if (gone) return refusal(410, "Gone", token, gone)
      if (token === "wrong-account")
        return refusal(
          409,
          "Conflict",
          "email-mismatch",
          "This invite is for tolu@coursified.app; you’re signed in as kemi@coursified.app.",
        )
      if (token === "member")
        return refusal(
          409,
          "Conflict",
          "already-member",
          "tolu@coursified.app is already a member of Coursified.",
        )
      return { status: 200, body: tolu }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/session\/link$/,
    answer: (_, body) => {
      const email = typeof body === "object" && body && "email" in body ? String(body.email) : ""
      if (email.endsWith("@no-sender.example"))
        return {
          status: 503,
          body: { _tag: "NoSystemSender", message: "No system sender is configured.", requestId: "fixture" },
        }
      if (email.endsWith("@rate-limited.example"))
        return {
          status: 429,
          body: {
            _tag: "RateLimited",
            message: "Too many sign-in links.",
            retryAfter: 60,
            requestId: "fixture",
          },
        }
      const sent: LinkSent = { sent: true }
      return { status: 202, body: sent }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/workspace\/claim$/,
    answer: (_, body) => {
      const b = (body ?? {}) as { name?: string; email?: string }
      const claimed: Claimed = {
        member: {
          id: "mem_01JAOWNR",
          email: b.email ?? "halleluyah@coursified.app",
          name: b.name ?? "Halleluyah Oludele",
          role: "owner",
          timeZone: "UTC",
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        },
        signInLinkSent: true,
      }
      return { status: 200, body: claimed }
    },
  },
]

// ── Ops (HAL-3309): Transactional, Domains, Analytics and Settings ────────────────────────────────────────────
// Each area keeps its overrides in its own folder (`src/<area>/fixtures.ts`), typed against the schema the same
// way, for routes the design fixtures predate (agents, approvals, members and invites, sessions, workspace
// deletion, key limits) and for the designed states a fixture variant can't pick on its own.
const OPS_OVERRIDES: readonly Override[] = [
  ...TRANSACTIONAL_OVERRIDES,
  ...TRANSACTIONAL_KEYS_OVERRIDES,
  ...DOMAINS_OVERRIDES,
  ...ANALYTICS_OVERRIDES,
  ...SETTINGS_OVERRIDES,
  ...SETTINGS_AGENTS_OVERRIDES,
]

/** The override answering this request, if any. */
export async function findOverride(request: Request): Promise<Answer | undefined> {
  // Audience, campaigns and automations (HAL-3310): `?fx=<design screen>` answers from that screen's fixtures.
  const screen = await screenFixture(request)
  if (screen) return screen
  const url = new URL(request.url)
  // ── Mail (HAL-3308): mail/fixtures.ts answers first; an answer of undefined falls through to the designs.
  for (const o of MAIL_OVERRIDES) {
    if (o.method !== request.method) continue
    const m = url.pathname.match(o.path)
    if (!m) continue
    let body: unknown = null
    if (request.method !== "GET") {
      try {
        body = await request.clone().json()
      } catch {}
    }
    const answer = await o.answer(m, body, url)
    if (answer) return answer
  }
  // ── end Mail
  for (const o of [...OVERRIDES, ...OPS_OVERRIDES]) {
    if (o.method !== request.method) continue
    const m = url.pathname.match(o.path)
    if (!m) continue
    let body: unknown = null
    if (request.method !== "GET") {
      try {
        body = await request.clone().json()
      } catch {}
    }
    return o.answer(m, body, url)
  }
  return undefined
}

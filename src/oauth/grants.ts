import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm"
import * as Effect from "effect/Effect"
import {
  apiKeys,
  mailboxes,
  mailboxMembers,
  mailboxPeople,
  members,
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthTokens,
} from "../db/schema.ts"
import { type Caller, createKey, ROOT, recordUse, revokeKey, type Scope } from "../domain/apiKeys.ts"
import { recordAudit } from "../domain/audit.ts"
import { randomToken, sha256 } from "../domain/crypto.ts"
import { HOLDS_MAIL } from "../domain/mailboxes.ts"
import { can, isManager, ROLE_SCOPES, SEES_ALL_MAILBOXES } from "../domain/permissions.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { clientHost, findClient, type OAuthClient, OAuthError, pruneClients, touchClient } from "./clients.ts"

/**
 * What a person lets an MCP client do (HAL-3462), and the tokens that carry it. A grant is a
 * `purpose: mcp` key with the chosen scopes and mailbox memberships, so the client meets every check
 * an agent's key meets: scopes, mailbox roles, agent limits, approvals and the audit of its reads.
 * Codes and tokens are stored as SHA-256 only.
 */

const MINUTE = 60_000
const DAY = 86_400_000
export const CODE_TTL_MS = 10 * MINUTE
export const ACCESS_TTL_MS = 60 * MINUTE
/** A refresh token unused this long expires; each use issues a new one. */
export const REFRESH_TTL_MS = 30 * DAY

/** The scopes a client may ask for. `admin` is for step-up, and only someone who holds it can grant it. */
export const OAUTH_SCOPES = ["read", "send", "admin"] as const
export type OAuthScope = (typeof OAUTH_SCOPES)[number]
/** What `scope` means when a client leaves it out. */
export const DEFAULT_SCOPES: ReadonlyArray<OAuthScope> = ["read", "send"]

const hash = (token: string) => Effect.promise(() => sha256(token))

const invalidGrant = (description: string) =>
  new OAuthError({ error: "invalid_grant", description, status: 400 })

/** The caller a grant acts for: the consenting member (as they are now), or the admin key. */
export const principalCaller = Effect.fn("oauth.principal")(function* (principal: string) {
  if (principal === "root") return ROOT
  const database = yield* Database
  const m = yield* database.query("oauth.principal", (db) =>
    db.select().from(members).where(eq(members.id, principal)).get(),
  )
  if (!m || m.removedAt !== null) return null
  return {
    keyId: m.id,
    kind: "secret",
    scopes: ROLE_SCOPES[m.role],
    member: { id: m.id, role: m.role, email: m.email, name: m.name },
  } satisfies Caller as Caller
})

/** The OAuth scopes someone can hand a client: never more than their own role holds. */
export const grantableScopes = (caller: Caller): ReadonlyArray<OAuthScope> =>
  OAUTH_SCOPES.filter((s) => caller.scopes.includes(s as Scope))

/** Parses a space-separated `scope`, keeping only scopes Mailyard knows. Null when one is unknown. */
export const parseScopes = (raw: string | null | undefined): ReadonlyArray<OAuthScope> | null => {
  if (raw === null || raw === undefined || raw.trim() === "") return DEFAULT_SCOPES
  const asked = [...new Set(raw.trim().split(/\s+/))]
  if (asked.some((s) => !(OAUTH_SCOPES as ReadonlyArray<string>).includes(s))) return null
  return asked as ReadonlyArray<OAuthScope>
}

export interface GrantableMailbox {
  readonly id: string
  readonly address: string
  readonly displayName: string | null
  /** Whether the person may send from it, so `send` can reach it. */
  readonly canSend: boolean
}

/** The mailboxes someone can hand a client, and whether they could send from each. */
export const grantableMailboxes = Effect.fn("oauth.grantableMailboxes")(function* (caller: Caller) {
  const database = yield* Database
  const all = yield* database.query("oauth.mailboxes", (db) =>
    db
      .select({
        id: mailboxes.id,
        address: mailboxes.address,
        displayName: mailboxes.displayName,
        kind: mailboxes.kind,
      })
      .from(mailboxes)
      .orderBy(mailboxes.address)
      .limit(500)
      .all(),
  )
  const holding = all.filter((m) => HOLDS_MAIL.has(m.kind))
  if (caller.keyId === "root" || isManager(caller))
    return holding.map((m) => ({ id: m.id, address: m.address, displayName: m.displayName, canSend: true }))
  if (!caller.member) return []
  const own = yield* database.query("oauth.memberMailboxes", (db) =>
    db
      .select({ mailboxId: mailboxPeople.mailboxId, role: mailboxPeople.role })
      .from(mailboxPeople)
      .where(eq(mailboxPeople.memberId, caller.keyId))
      .all(),
  )
  const roles = new Map(own.map((r) => [r.mailboxId, r.role]))
  const sees = SEES_ALL_MAILBOXES.has(caller.member.role)
  const sends = can(caller, "mail.send")
  return holding
    .filter((m) => sees || roles.has(m.id))
    .map((m) => {
      const role = roles.get(m.id)
      return {
        id: m.id,
        address: m.address,
        displayName: m.displayName,
        canSend: sends && (role === "owner" || role === "member"),
      }
    }) satisfies ReadonlyArray<GrantableMailbox>
})

/** `/oauth/authorize` approved: a ten-minute, single-use code for what the person chose. */
export const issueCode = Effect.fn("oauth.issueCode")(function* (input: {
  readonly client: OAuthClient
  readonly principal: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly resource: string
  readonly scopes: ReadonlyArray<OAuthScope>
  readonly mailboxIds: ReadonlyArray<string>
  readonly now?: number
}) {
  const now = input.now ?? Date.now()
  const code = `oac_${randomToken(32)}`
  const codeHash = yield* hash(code)
  const database = yield* Database
  yield* database.query("oauth.issueCode", (db) =>
    db
      .insert(oauthCodes)
      .values({
        hash: codeHash,
        clientId: input.client.id,
        principal: input.principal,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        resource: input.resource,
        scopes: [...input.scopes],
        mailboxIds: [...input.mailboxIds],
        createdAt: now,
        expiresAt: now + CODE_TTL_MS,
      })
      .run(),
  )
  return code
})

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/

const s256 = (verifier: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    let s = ""
    for (const b of new Uint8Array(digest)) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  })

/** A new access and refresh token for a grant. */
const issuePair = Effect.fn("oauth.issuePair")(function* (grantId: string, now: number) {
  const access = `oat_${randomToken(32)}`
  const refresh = `ort_${randomToken(32)}`
  const accessHash = yield* hash(access)
  const refreshHash = yield* hash(refresh)
  const database = yield* Database
  yield* database.query("oauth.issuePair", (db) =>
    db
      .insert(oauthTokens)
      .values([
        { hash: accessHash, grantId, kind: "access", createdAt: now, expiresAt: now + ACCESS_TTL_MS },
        { hash: refreshHash, grantId, kind: "refresh", createdAt: now, expiresAt: now + REFRESH_TTL_MS },
      ])
      .run(),
  )
  return { access, refresh }
})

const tokenResponse = (pair: { access: string; refresh: string }, scopes: ReadonlyArray<string>) => ({
  access_token: pair.access,
  token_type: "Bearer",
  expires_in: Math.floor(ACCESS_TTL_MS / 1000),
  refresh_token: pair.refresh,
  scope: scopes.join(" "),
})

/** Ends a grant: its key stops working at once, and so does every token. */
export const revokeGrant = Effect.fn("oauth.revokeGrant")(function* (
  grantId: string,
  reason: string,
  actor: string,
  now = Date.now(),
) {
  const database = yield* Database
  const grant = yield* database.query("oauth.revokeGrant", (db) =>
    db
      .update(oauthGrants)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
      .returning()
      .get(),
  )
  if (!grant) return false
  yield* revokeKey(grant.apiKeyId)
  yield* recordAudit({
    actor,
    action: "oauth.revoke",
    target: grantId,
    after: { reason, clientId: grant.clientId, apiKeyId: grant.apiKeyId },
  })
  return true
})

/**
 * `grant_type=authorization_code`: checks the code (once, in time, for this client and redirect),
 * the PKCE verifier and the resource, then makes the grant's key and its first tokens. A code used
 * twice revokes the grant it made (RFC 6749 §4.1.2).
 */
export const exchangeCode = Effect.fn("oauth.exchangeCode")(function* (input: {
  readonly code: string
  readonly clientId: string
  readonly redirectUri: string
  readonly codeVerifier: string
  readonly resource: string | null
  readonly now?: number
}) {
  const now = input.now ?? Date.now()
  const database = yield* Database
  if (!input.code) return yield* invalidGrant("code is missing.")
  const codeHash = yield* hash(input.code)
  const row = yield* database.query("oauth.findCode", (db) =>
    db.select().from(oauthCodes).where(eq(oauthCodes.hash, codeHash)).get(),
  )
  if (!row) return yield* invalidGrant("That code isn't valid.")
  if (row.usedAt !== null) {
    if (row.grantId) yield* revokeGrant(row.grantId, "code-replayed", "oauth", now)
    return yield* invalidGrant("That code was already used, so the access it gave was revoked.")
  }
  const claimed = yield* database.query("oauth.claimCode", (db) =>
    db
      .update(oauthCodes)
      .set({ usedAt: now })
      .where(and(eq(oauthCodes.hash, codeHash), isNull(oauthCodes.usedAt)))
      .run(),
  )
  if ((claimed.meta.changes ?? 0) === 0) return yield* invalidGrant("That code was already used.")
  if (now >= row.expiresAt) return yield* invalidGrant("That code expired; codes last ten minutes.")
  if (row.clientId !== input.clientId) return yield* invalidGrant("That code was issued to another client.")
  if (row.redirectUri !== input.redirectUri)
    return yield* invalidGrant("redirect_uri must be the one the code was sent to.")
  if (!VERIFIER.test(input.codeVerifier))
    return yield* invalidGrant("code_verifier must be 43 to 128 unreserved characters.")
  if ((yield* s256(input.codeVerifier)) !== row.codeChallenge)
    return yield* invalidGrant("code_verifier doesn't match the code_challenge.")
  if (input.resource !== null && input.resource !== row.resource)
    return yield* new OAuthError({
      error: "invalid_target",
      description: `resource must be ${row.resource}, as at authorization.`,
      status: 400,
    })
  const principal = yield* principalCaller(row.principal)
  if (!principal) return yield* invalidGrant("The person who approved this is no longer in the workspace.")
  // Narrowed to what they hold now, in case their role changed in the last ten minutes.
  const allowed = grantableScopes(principal)
  const scopes = row.scopes.filter((s) => allowed.includes(s as OAuthScope)) as ReadonlyArray<OAuthScope>
  if (scopes.length === 0) return yield* invalidGrant("Nothing left to grant: the approver's role changed.")
  const client = yield* findClient(row.clientId, now).pipe(
    Effect.catchTag("OAuthError", () =>
      Effect.succeed({ id: row.clientId, name: "MCP client" } as Pick<OAuthClient, "id" | "name">),
    ),
  )
  const mailboxRights = new Map((yield* grantableMailboxes(principal)).map((m) => [m.id, m.canSend]))
  const mailboxIds = row.mailboxIds.filter((id) => mailboxRights.has(id))
  const created = yield* createKey({
    name: `${client.name} (OAuth)`.slice(0, 100),
    kind: "secret",
    scopes: scopes as ReadonlyArray<Scope>,
    purpose: "mcp",
    createdBy: row.principal,
  })
  const grantId = `ogr_${yield* (yield* Ids).next}`
  const sends = scopes.includes("send")
  yield* database.query("oauth.createGrant", (db) =>
    db.batch([
      db.insert(oauthGrants).values({
        id: grantId,
        clientId: row.clientId,
        principal: row.principal,
        apiKeyId: created.record.id,
        resource: row.resource,
        scopes: [...scopes],
        mailboxIds,
        createdAt: now,
        lastUsedAt: now,
      }),
      db.update(oauthCodes).set({ grantId }).where(eq(oauthCodes.hash, codeHash)),
      ...mailboxIds.map((mailboxId) =>
        db.insert(mailboxMembers).values({
          mailboxId,
          apiKeyId: created.record.id,
          role: sends && mailboxRights.get(mailboxId) ? "member" : "viewer",
        }),
      ),
    ]),
  )
  const pair = yield* issuePair(grantId, now)
  yield* touchClient(row.clientId, now)
  yield* recordAudit({
    actor: row.principal,
    action: "oauth.grant",
    target: grantId,
    after: { clientId: row.clientId, scopes, mailboxIds, apiKeyId: created.record.id },
  })
  return tokenResponse(pair, scopes)
})

/**
 * `grant_type=refresh_token`: rotation with reuse detection. The refresh token is spent and a new
 * pair issued; presenting a spent one again means it leaked, so the whole grant is revoked.
 */
export const refreshGrant = Effect.fn("oauth.refresh")(function* (input: {
  readonly refreshToken: string
  readonly clientId: string
  readonly scope: string | null
  readonly now?: number
}) {
  const now = input.now ?? Date.now()
  const database = yield* Database
  if (!input.refreshToken) return yield* invalidGrant("refresh_token is missing.")
  const tokenHash = yield* hash(input.refreshToken)
  const row = yield* database.query("oauth.findRefresh", (db) =>
    db
      .select({ token: oauthTokens, grant: oauthGrants })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .where(and(eq(oauthTokens.hash, tokenHash), eq(oauthTokens.kind, "refresh")))
      .get(),
  )
  if (!row) return yield* invalidGrant("That refresh token isn't valid.")
  const { token, grant } = row
  if (grant.revokedAt !== null) return yield* invalidGrant("This access was revoked. Connect again.")
  if (grant.clientId !== input.clientId)
    return yield* invalidGrant("That refresh token was issued to another client.")
  if (token.usedAt !== null) {
    yield* revokeGrant(grant.id, "refresh-reused", "oauth", now)
    return yield* invalidGrant(
      "That refresh token was already used, so this access was revoked. Connect again.",
    )
  }
  const claimed = yield* database.query("oauth.spendRefresh", (db) =>
    db
      .update(oauthTokens)
      .set({ usedAt: now })
      .where(and(eq(oauthTokens.hash, tokenHash), isNull(oauthTokens.usedAt)))
      .run(),
  )
  if ((claimed.meta.changes ?? 0) === 0) {
    yield* revokeGrant(grant.id, "refresh-reused", "oauth", now)
    return yield* invalidGrant(
      "That refresh token was already used, so this access was revoked. Connect again.",
    )
  }
  if (now >= token.expiresAt) return yield* invalidGrant("That refresh token expired. Connect again.")
  const key = yield* database.query("oauth.grantKey", (db) =>
    db.select({ revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.id, grant.apiKeyId)).get(),
  )
  if (!key || (key.revokedAt !== null && key.revokedAt <= now)) {
    yield* revokeGrant(grant.id, "key-revoked", "oauth", now)
    return yield* invalidGrant("This access was revoked. Connect again.")
  }
  const principal = yield* principalCaller(grant.principal)
  if (!principal) {
    yield* revokeGrant(grant.id, "member-removed", "oauth", now)
    return yield* invalidGrant("The person who approved this is no longer in the workspace.")
  }
  if (input.scope !== null) {
    const asked = parseScopes(input.scope)
    if (!asked || asked.some((s) => !grant.scopes.includes(s)))
      return yield* new OAuthError({
        error: "invalid_scope",
        description: "A refresh can't add scopes. Connect again to ask for more.",
        status: 400,
      })
  }
  const pair = yield* issuePair(grant.id, now)
  yield* database.query("oauth.grantUsed", (db) =>
    db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, grant.id)).run(),
  )
  yield* recordAudit({ actor: grant.principal, action: "oauth.refresh", target: grant.id })
  return tokenResponse(pair, grant.scopes)
})

export type AccessRefusal = { readonly code: "invalid_token" | "wrong_resource"; readonly message: string }

/**
 * The caller behind an access token on `/mcp`: the grant's key, with its scopes narrowed to what the
 * approver holds today. `resources` are the audiences this request answers for (RFC 8707).
 */
export const authenticateAccessToken = Effect.fn("oauth.authenticate")(function* (
  token: string,
  resources: ReadonlyArray<string>,
  now = Date.now(),
) {
  const database = yield* Database
  const tokenHash = yield* hash(token)
  const row = yield* database.query("oauth.findAccess", (db) =>
    db
      .select({ token: oauthTokens, grant: oauthGrants, key: apiKeys })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .innerJoin(apiKeys, eq(apiKeys.id, oauthGrants.apiKeyId))
      .where(and(eq(oauthTokens.hash, tokenHash), eq(oauthTokens.kind, "access")))
      .get(),
  )
  const refuse = (code: AccessRefusal["code"], message: string) =>
    Effect.succeed({ refused: { code, message } as AccessRefusal })
  if (!row) return yield* refuse("invalid_token", "The access token isn't valid.")
  if (now >= row.token.expiresAt) return yield* refuse("invalid_token", "The access token expired.")
  if (row.grant.revokedAt !== null) return yield* refuse("invalid_token", "This access was revoked.")
  if (row.key.revokedAt !== null && row.key.revokedAt <= now)
    return yield* refuse("invalid_token", "This access was revoked.")
  if (!resources.includes(row.grant.resource))
    return yield* refuse("wrong_resource", `This token is for ${row.grant.resource}.`)
  const principal = yield* principalCaller(row.grant.principal)
  if (!principal) return yield* refuse("invalid_token", "The person who approved this left the workspace.")
  const held = new Set(grantableScopes(principal) as ReadonlyArray<string>)
  const scopes = (row.key.scopes as ReadonlyArray<Scope>).filter((s) => held.has(s))
  yield* recordUse(row.key.id, row.key.lastUsedAt, now)
  if (row.grant.lastUsedAt === null || now - row.grant.lastUsedAt > MINUTE)
    yield* database.query("oauth.grantSeen", (db) =>
      db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, row.grant.id)).run(),
    )
  return {
    caller: {
      keyId: row.key.id,
      kind: "secret",
      scopes,
      purpose: "mcp",
      oauth: { grantId: row.grant.id, clientId: row.grant.clientId },
    } satisfies Caller as Caller,
  }
})

/**
 * `POST /oauth/revoke` (RFC 7009): an access or refresh token ends its whole grant. Unknown tokens
 * answer the same, so the endpoint says nothing about which exist.
 */
export const revokeToken = Effect.fn("oauth.revokeToken")(function* (token: string, clientId: string | null) {
  if (!token) return
  const tokenHash = yield* hash(token)
  const database = yield* Database
  const row = yield* database.query("oauth.findToken", (db) =>
    db
      .select({ grantId: oauthTokens.grantId, clientId: oauthGrants.clientId })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .where(eq(oauthTokens.hash, tokenHash))
      .get(),
  )
  if (!row || (clientId !== null && row.clientId !== clientId)) return
  yield* revokeGrant(row.grantId, "client-revoked", "oauth")
})

/** The live grants, for the Integrations screen: who let which client do what. */
export const listGrants = Effect.fn("oauth.listGrants")(function* () {
  const database = yield* Database
  const rows = yield* database.query("oauth.listGrants", (db) =>
    db
      .select({ grant: oauthGrants, client: oauthClients, member: members, keyRevokedAt: apiKeys.revokedAt })
      .from(oauthGrants)
      .innerJoin(apiKeys, eq(apiKeys.id, oauthGrants.apiKeyId))
      .leftJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .leftJoin(members, eq(members.id, oauthGrants.principal))
      .where(and(isNull(oauthGrants.revokedAt), isNull(apiKeys.revokedAt)))
      .orderBy(desc(oauthGrants.createdAt))
      .limit(200)
      .all(),
  )
  return rows.map((r) => ({
    id: r.grant.id,
    client: {
      id: r.grant.clientId,
      name: r.client?.name ?? "MCP client",
      host: r.client ? clientHost(r.client) : null,
      registration: r.client?.kind ?? null,
    },
    grantedBy:
      r.grant.principal === "root"
        ? { id: "root", name: "Admin key", email: null }
        : { id: r.grant.principal, name: r.member?.name ?? "Former member", email: r.member?.email ?? null },
    apiKeyId: r.grant.apiKeyId,
    scopes: r.grant.scopes,
    mailboxIds: r.grant.mailboxIds,
    createdAt: r.grant.createdAt,
    lastUsedAt: r.grant.lastUsedAt,
  }))
})

/** The grant behind a key, if any: so revoking either end ends both. */
export const grantForKey = Effect.fn("oauth.grantForKey")(function* (apiKeyId: string) {
  const database = yield* Database
  return yield* database.query("oauth.grantForKey", (db) =>
    db
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.apiKeyId, apiKeyId), isNull(oauthGrants.revokedAt)))
      .get(),
  )
})

/** Hourly: spent and expired codes and tokens go, and so do unused registrations. */
export const pruneOAuth = Effect.fn("oauth.prune")(function* (now = Date.now()) {
  const database = yield* Database
  yield* database.query("oauth.pruneCodes", (db) =>
    db
      .delete(oauthCodes)
      .where(lt(oauthCodes.expiresAt, now - DAY))
      .run(),
  )
  // Spent refresh tokens stay until they'd have expired, so reusing one is still caught.
  yield* database.query("oauth.pruneTokens", (db) =>
    db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, now)).run(),
  )
  // Revoked grants keep a month for the audit trail's sake, then their tokens' rows are gone anyway.
  const old = yield* database.query("oauth.oldGrants", (db) =>
    db
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(lt(oauthGrants.revokedAt, now - 30 * DAY))
      .limit(500)
      .all(),
  )
  if (old.length > 0)
    yield* database.query("oauth.pruneGrantTokens", (db) =>
      db
        .delete(oauthTokens)
        .where(
          // d1: bounded: at most 500 grant ids, from the query above.
          inArray(
            oauthTokens.grantId,
            old.map((g) => g.id),
          ),
        )
        .run(),
    )
  yield* pruneClients(now)
})

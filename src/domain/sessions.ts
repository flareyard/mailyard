import { and, desc, eq, gt, isNull, lt, ne, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { apiKeys, sessions, settings } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { type Caller, isRevoked, ROOT, recordUse, type Scope } from "./apiKeys.ts"
import { customBrandSettings } from "./brand.ts"
import { randomToken, sha256 } from "./crypto.ts"

/**
 * Browser sessions (HAL-3358). The web app signs in by posting an API key (or the ADMIN_KEY) to
 * `POST /v1/session`; it gets back an HTTP-only cookie and never holds the key again. The cookie is
 * a random token whose SHA-256 is all the database keeps. Each request reads the session with its
 * key, so revoking the key ends its sessions and narrowing it narrows them, with no second list to
 * keep in step.
 */

/** `__Host-`: Secure, Path=/ and no Domain, so no subdomain can set or read it. */
export const SESSION_COOKIE = "__Host-mailyard_session"

const MINUTE = 60_000
const DAY = 86_400_000
/** A session lives this long after its last use… */
export const SESSION_IDLE_MS = 14 * DAY
/** …and never longer than this after it was opened. */
export const SESSION_MAX_MS = 30 * DAY

export type SessionVia = "session-key" | "admin-key"

/** Why a session cookie was refused; every case answers `401 reason: "session-expired"`. */
export class SessionExpired extends Schema.TaggedError<SessionExpired>()("SessionExpired", {
  message: Schema.String,
  cause: Schema.Literals(["unknown", "ended", "expired", "key-revoked", "admin-key-changed"]),
}) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  id: Schema.String,
}) {}

/** Fingerprint of the ADMIN_KEY: changing the key ends every admin-key session. */
const adminFingerprint = (adminKey: string) => sha256(`mailyard-admin-session:${adminKey}`)

/** Where the request came from, for "Your sessions". Cloudflare's own headers, nothing guessed. */
export const clientOf = (headers: Readonly<Record<string, string | undefined>>) => {
  const city = headers["cf-ipcity"]
  const country = headers["cf-ipcountry"]
  const location = [city, country && country !== "XX" ? country : undefined].filter(Boolean).join(", ")
  return {
    userAgent: headers["user-agent"]?.slice(0, 400) ?? null,
    ip: headers["cf-connecting-ip"] ?? null,
    location: location || null,
  }
}

/** Opens a session for an authenticated caller. Returns the cookie's token, shown only here. */
export const openSession = Effect.fn("sessions.open")(function* (
  caller: Caller,
  client: ReturnType<typeof clientOf>,
  now = Date.now(),
) {
  const database = yield* Database
  const { ADMIN_KEY } = yield* Bindings
  const id = `ses_${yield* (yield* Ids).next}`
  const token = randomToken(32)
  const admin = caller.keyId === ROOT.keyId
  const row = {
    id,
    tokenHash: yield* Effect.promise(() => sha256(token)),
    keyId: caller.keyId,
    via: (admin ? "admin-key" : "session-key") as SessionVia,
    adminFingerprint: admin && ADMIN_KEY ? yield* Effect.promise(() => adminFingerprint(ADMIN_KEY)) : null,
    ...client,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_IDLE_MS,
    absoluteExpiresAt: now + SESSION_MAX_MS,
    endedAt: null,
  }
  yield* database.query("sessions.open", (db) => db.insert(sessions).values(row).run())
  return { token, session: row }
})

/**
 * The caller behind a session cookie, or why it no longer works. Slides the expiry forward at most
 * once a minute, and counts the request against the key like a Bearer request.
 */
export const resolveSession = Effect.fn("sessions.resolve")(function* (token: string, now = Date.now()) {
  const database = yield* Database
  const { ADMIN_KEY } = yield* Bindings
  const expired = (cause: SessionExpired["cause"], message: string) => new SessionExpired({ cause, message })
  const hash = yield* Effect.promise(() => sha256(token))
  const found = yield* database
    .query("sessions.find", (db) =>
      db
        .select({ session: sessions, key: apiKeys })
        .from(sessions)
        .leftJoin(apiKeys, eq(apiKeys.id, sessions.keyId))
        .where(eq(sessions.tokenHash, hash))
        .get(),
    )
    .pipe(Effect.orDie)
  if (!found) return yield* expired("unknown", "Your session has ended. Sign in again.")
  const { session, key } = found
  if (session.endedAt !== null)
    return yield* expired("ended", "You signed out of this session. Sign in again.")
  if (now >= session.expiresAt)
    return yield* expired(
      "expired",
      now >= session.absoluteExpiresAt
        ? "Sessions last 30 days at most. Sign in again."
        : "Your session expired after 14 days unused. Sign in again.",
    )
  let caller: Caller
  if (session.via === "admin-key") {
    const current = ADMIN_KEY ? yield* Effect.promise(() => adminFingerprint(ADMIN_KEY)) : null
    if (current === null || current !== session.adminFingerprint)
      return yield* expired(
        "admin-key-changed",
        "The admin key changed, which ends its sessions. Sign in again.",
      )
    caller = { ...ROOT, sessionId: session.id }
  } else {
    if (!key || (key.revokedAt !== null && isRevoked(key.revokedAt, now)))
      return yield* expired(
        "key-revoked",
        "The key behind this session was revoked. Sign in with another key.",
      )
    caller = {
      keyId: key.id,
      kind: key.kind,
      scopes: key.scopes as ReadonlyArray<Scope>,
      sessionId: session.id,
    }
    yield* recordUse(key.id, key.lastUsedAt, now)
  }
  if (now - session.lastSeenAt > MINUTE)
    yield* database
      .query("sessions.touch", (db) =>
        db
          .update(sessions)
          .set({ lastSeenAt: now, expiresAt: Math.min(now + SESSION_IDLE_MS, session.absoluteExpiresAt) })
          .where(eq(sessions.id, session.id))
          .run(),
      )
      .pipe(Effect.ignore)
  return caller
})

/** Ends the session behind a cookie token, if there is one. Signing out twice is not an error. */
export const endSessionByToken = Effect.fn("sessions.endByToken")(function* (
  token: string,
  now = Date.now(),
) {
  const database = yield* Database
  const hash = yield* Effect.promise(() => sha256(token))
  yield* database.query("sessions.end", (db) =>
    db
      .update(sessions)
      .set({ endedAt: now })
      .where(and(eq(sessions.tokenHash, hash), isNull(sessions.endedAt)))
      .run(),
  )
})

/** Sessions still working: not ended, not expired. */
const live = (now: number) => and(isNull(sessions.endedAt), gt(sessions.expiresAt, now))

/** The caller's own sessions (every session opened with the same key), newest use first. */
export const listSessions = Effect.fn("sessions.list")(function* (caller: Caller, now = Date.now()) {
  const database = yield* Database
  const rows = yield* database.query("sessions.list", (db) =>
    db
      .select({ session: sessions, key: apiKeys })
      .from(sessions)
      .leftJoin(apiKeys, eq(apiKeys.id, sessions.keyId))
      .where(and(eq(sessions.keyId, caller.keyId), live(now)))
      .orderBy(desc(sessions.lastSeenAt))
      .limit(200)
      .all(),
  )
  return rows.map(({ session, key }) => ({
    id: session.id,
    current: session.id === caller.sessionId,
    via: session.via,
    key: key
      ? { id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes as ReadonlyArray<Scope> }
      : null,
    userAgent: session.userAgent,
    ip: session.ip,
    location: session.location,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
  }))
})

/** Ends one of the caller's sessions. Someone else's (or an unknown id) is a 404, never a hint. */
export const endSession = Effect.fn("sessions.end")(function* (caller: Caller, id: string, now = Date.now()) {
  const database = yield* Database
  const result = yield* database.query("sessions.endOne", (db) =>
    db
      .update(sessions)
      .set({ endedAt: now })
      .where(and(eq(sessions.id, id), eq(sessions.keyId, caller.keyId), live(now)))
      .run(),
  )
  if ((result.meta.changes ?? 0) === 0) return yield* new SessionNotFound({ id })
})

/** "Sign out everywhere else": ends every live session of the caller's key except the current one. */
export const endOtherSessions = Effect.fn("sessions.endOthers")(function* (caller: Caller, now = Date.now()) {
  const database = yield* Database
  const result = yield* database.query("sessions.endOthers", (db) =>
    db
      .update(sessions)
      .set({ endedAt: now })
      .where(
        and(
          eq(sessions.keyId, caller.keyId),
          live(now),
          caller.sessionId ? ne(sessions.id, caller.sessionId) : undefined,
        ),
      )
      .run(),
  )
  return { ended: result.meta.changes ?? 0 }
})

/** Drops sessions that ended or expired more than 30 days ago (hourly, from the cron). */
export const pruneSessions = Effect.fn("sessions.prune")(function* (now = Date.now()) {
  const database = yield* Database
  const cutoff = now - SESSION_MAX_MS
  yield* database.query("sessions.prune", (db) =>
    db
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, cutoff), lt(sessions.endedAt, cutoff)))
      .run(),
  )
})

const WorkspaceSetting = Schema.Struct({ id: Schema.String })

/**
 * The workspace this deployment is. One per deployment for now; its id is minted on first read and
 * kept in settings so it stays the same across deploys. The name is the brand's, until claiming the
 * workspace (HAL-3361) gives it its own.
 */
export const currentWorkspace = Effect.fn("workspace.current")(function* () {
  const database = yield* Database
  const read = database.query("settings.workspace", (db) =>
    db.select().from(settings).where(eq(settings.key, "workspace")).get(),
  )
  let row = yield* read
  if (!row) {
    yield* database.query("settings.workspace.init", (db) =>
      db
        .insert(settings)
        .values({ key: "workspace", value: { id: `ws_${randomToken(12)}` }, updatedAt: Date.now() })
        .onConflictDoNothing()
        .run(),
    )
    row = yield* read
  }
  const setting = Schema.decodeUnknownOption(WorkspaceSetting)(row?.value)
  const brand = yield* customBrandSettings()
  return {
    id: setting._tag === "Some" ? setting.value.id : "ws_default",
    name: brand?.name ?? "Mailyard",
    logoUrl: brand?.logoUrl ?? null,
  }
})

/**
 * What each scope lets the app show, so screens can hide what the caller can't do instead of
 * failing on click. Scopes stay the source of truth; this is their reading for the UI. Mailbox
 * access is narrower still: a key reads only the mailboxes it's a member of (admin reads all).
 */
const PERMISSIONS: Record<Scope, ReadonlyArray<string>> = {
  read: [
    "mail.read",
    "contacts.read",
    "campaigns.read",
    "automations.read",
    "templates.read",
    "analytics.read",
    "settings.read",
  ],
  send: ["mail.send", "email.send"],
  track: ["events.track"],
  admin: [
    "mail.manage",
    "contacts.write",
    "campaigns.write",
    "automations.write",
    "templates.write",
    "settings.write",
    "domains.manage",
    "keys.manage",
    "webhooks.manage",
    "exports.workspace",
  ],
}

export const permissionsOf = (scopes: ReadonlyArray<Scope>) =>
  [...new Set(scopes.flatMap((s) => PERMISSIONS[s] ?? []))].sort()

/** `GET /v1/me`: who the app is signed in as. `user` and `role` stay null until people exist (HAL-3361). */
export const describeCaller = Effect.fn("sessions.me")(function* (caller: Caller, now = Date.now()) {
  const database = yield* Database
  const workspace = yield* currentWorkspace()
  const admin = caller.keyId === ROOT.keyId
  const key = admin
    ? null
    : ((yield* database.query("apiKeys.me", (db) =>
        db
          .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix })
          .from(apiKeys)
          .where(eq(apiKeys.id, caller.keyId))
          .get(),
      )) ?? null)
  const session = caller.sessionId
    ? ((yield* database.query("sessions.me", (db) =>
        db
          .select({
            id: sessions.id,
            expiresAt: sessions.expiresAt,
            absoluteExpiresAt: sessions.absoluteExpiresAt,
          })
          .from(sessions)
          .where(eq(sessions.id, caller.sessionId as string))
          .get(),
      )) ?? null)
    : null
  return {
    user: null,
    workspace,
    role: null,
    via: (admin ? "admin-key" : caller.sessionId ? "session-key" : "api-key") as
      | "admin-key"
      | "session-key"
      | "api-key",
    key,
    scopes: [...caller.scopes],
    permissions: permissionsOf(caller.scopes),
    workspaces: [workspace],
    session: session
      ? {
          ...session,
          // The sliding expiry as the app should show it: from now, unless the cap comes first.
          expiresAt: Math.min(now + SESSION_IDLE_MS, session.absoluteExpiresAt),
        }
      : null,
  }
})

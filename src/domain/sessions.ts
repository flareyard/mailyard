import { and, desc, eq, gt, isNull, lt, ne, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { apiKeys, mailboxes, mailboxPeople, members, sessions, settings } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { type Caller, isRevoked, ROOT, recordUse, type Scope } from "./apiKeys.ts"
import { customBrandSettings } from "./brand.ts"
import { randomToken, sha256 } from "./crypto.ts"
import { HOLDS_MAIL } from "./mailboxes.ts"
import { permissionsOf, ROLE_SCOPES, SEES_ALL_MAILBOXES } from "./permissions.ts"

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

export type SessionVia = "session-key" | "admin-key" | "session-member"

/** Why a session cookie was refused; every case answers `401 reason: "session-expired"`. */
export class SessionExpired extends Schema.TaggedError<SessionExpired>()("SessionExpired", {
  message: Schema.String,
  cause: Schema.Literals([
    "unknown",
    "ended",
    "expired",
    "key-revoked",
    "admin-key-changed",
    "member-removed",
  ]),
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

/**
 * Opens a session for an authenticated caller: a key, the ADMIN_KEY, or a person who has just used
 * a sign-in link or accepted an invite (HAL-3361). Returns the cookie's token, shown only here.
 */
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
    via: (caller.member ? "session-member" : admin ? "admin-key" : "session-key") as SessionVia,
    memberId: caller.member?.id ?? null,
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
  if (session.via === "session-member") {
    const member = yield* database
      .query("sessions.member", (db) =>
        db
          .select()
          .from(members)
          .where(eq(members.id, session.memberId ?? ""))
          .get(),
      )
      .pipe(Effect.orDie)
    if (!member || member.removedAt !== null)
      return yield* expired("member-removed", "You've been removed from this workspace.")
    caller = {
      keyId: member.id,
      kind: "secret",
      scopes: ROLE_SCOPES[member.role],
      sessionId: session.id,
      member: { id: member.id, role: member.role, email: member.email, name: member.name },
    }
    if (member.lastActiveAt === null || now - member.lastActiveAt > MINUTE)
      yield* database
        .query("members.touch", (db) =>
          db.update(members).set({ lastActiveAt: now }).where(eq(members.id, member.id)).run(),
        )
        .pipe(Effect.ignore)
  } else if (session.via === "admin-key") {
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
      purpose: key.purpose,
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

const WorkspaceSetting = Schema.Struct({
  id: Schema.String,
  /** Set when the workspace is claimed (HAL-3361); the brand's name stands in until then. */
  name: Schema.optionalKey(Schema.String),
  claimedBy: Schema.optionalKey(Schema.String),
  claimedAt: Schema.optionalKey(Schema.Number),
})
export type WorkspaceSetting = typeof WorkspaceSetting.Type

/** The workspace's stored record, minting its id on first read. */
export const workspaceSetting = Effect.fn("workspace.setting")(function* () {
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
  return setting._tag === "Some" ? setting.value : ({ id: "ws_default" } as WorkspaceSetting)
})

export const putWorkspaceSetting = Effect.fn("workspace.put")(function* (value: WorkspaceSetting) {
  const database = yield* Database
  const now = Date.now()
  yield* database.query("settings.workspace.put", (db) =>
    db
      .insert(settings)
      .values({ key: "workspace", value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run(),
  )
})

/**
 * The workspace this deployment is. One per deployment for now; its id is minted on first read and
 * kept in settings so it stays the same across deploys. Its name is the one given when it was
 * claimed (HAL-3361), else the brand's.
 */
export const currentWorkspace = Effect.fn("workspace.current")(function* (origin: string) {
  const setting = yield* workspaceSetting()
  const brand = yield* customBrandSettings()
  return {
    id: setting.id,
    name: setting.name ?? brand?.name ?? "Mailyard",
    logoUrl: brand?.logoUrl ?? null,
    url: origin,
    host: new URL(origin).host,
    claimed: setting.claimedAt !== undefined,
  }
})

/**
 * `GET /v1/me`: who the app is signed in as. A person (HAL-3361) brings `user`, `role` and the
 * mailboxes they can open; a key or the admin key has neither, and `key` names the key instead.
 */
export const describeCaller = Effect.fn("sessions.me")(function* (
  caller: Caller,
  origin: string,
  now = Date.now(),
) {
  const database = yield* Database
  const workspace = yield* currentWorkspace(origin)
  const admin = caller.keyId === ROOT.keyId
  const key =
    admin || caller.member
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
  const person = caller.member
    ? ((yield* database.query("members.me", (db) =>
        db.select().from(members).where(eq(members.id, caller.keyId)).get(),
      )) ?? null)
    : null
  // The mailboxes a person can open: every one for a role that sees them all, else theirs, with
  // their access in each (null where they read by role rather than by being given it).
  const given = caller.member
    ? yield* database.query("members.myMailboxes", (db) =>
        db
          .select({ id: mailboxes.id, address: mailboxes.address, access: mailboxPeople.role })
          .from(mailboxPeople)
          .innerJoin(mailboxes, eq(mailboxes.id, mailboxPeople.mailboxId))
          .where(eq(mailboxPeople.memberId, caller.keyId))
          .all(),
      )
    : []
  const everyone =
    caller.member && SEES_ALL_MAILBOXES.has(caller.member.role)
      ? yield* database.query("members.allMailboxes", (db) =>
          db
            .select({ id: mailboxes.id, address: mailboxes.address, kind: mailboxes.kind })
            .from(mailboxes)
            .all(),
        )
      : []
  const access = new Map(given.map((g) => [g.id, g.access]))
  const myMailboxes = caller.member
    ? SEES_ALL_MAILBOXES.has(caller.member.role)
      ? everyone
          .filter((m) => HOLDS_MAIL.has(m.kind))
          .map((m) => ({ id: m.id, address: m.address, access: access.get(m.id) ?? null }))
      : given.map((g) => ({ id: g.id, address: g.address, access: g.access as typeof g.access | null }))
    : null
  return {
    user: person
      ? { id: person.id, name: person.name, email: person.email, timeZone: person.timeZone }
      : null,
    workspace,
    role: caller.member?.role ?? null,
    via: (caller.member
      ? "session-member"
      : admin
        ? "admin-key"
        : caller.sessionId
          ? "session-key"
          : "api-key") as "session-member" | "admin-key" | "session-key" | "api-key",
    key,
    scopes: [...caller.scopes],
    permissions: permissionsOf(caller),
    mailboxes: myMailboxes,
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

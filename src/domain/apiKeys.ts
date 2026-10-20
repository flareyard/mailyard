import { and, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { apiKeys, apiKeyUsage, mailboxMembers } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database, queryIn } from "../services/Database.ts"
import { randomToken, sha256, timingSafeEqual } from "./crypto.ts"

export const Scope = Schema.Literals(["send", "track", "read", "admin"])
export type Scope = typeof Scope.Type

export interface Caller {
  readonly keyId: string
  readonly kind: "secret" | "public"
  readonly scopes: ReadonlyArray<Scope>
  /** `mcp` for an agent's key: its MCP reads are audited (HAL-3461). */
  readonly purpose?: "api" | "mcp" | undefined
  /** Set when the request came with a browser session cookie rather than a Bearer key (HAL-3358). */
  readonly sessionId?: string | undefined
  /**
   * Set when a person is signed in (HAL-3361): checked by role, not scopes. `keyId` is then the
   * member's id, so everything that records "who" records the person.
   */
  readonly member?:
    | {
        readonly id: string
        readonly role: "owner" | "admin" | "sender" | "agent" | "viewer"
        readonly email: string
        readonly name: string
      }
    | undefined
  /** Set when an MCP client connected with OAuth (HAL-3462): the grant behind its key. */
  readonly oauth?: { readonly grantId: string; readonly clientId: string } | undefined
}

/** The deploy-time ADMIN_KEY: everything, and the only way to mint the first API key. */
export const ROOT: Caller = { keyId: "root", kind: "secret", scopes: ["send", "track", "read", "admin"] }

const DEFAULT_SCOPES: Record<Caller["kind"], ReadonlyArray<Scope>> = {
  secret: ["send", "track", "read"],
  public: ["track"],
}

const HOUR = 3_600_000

/** Revoked now: a rotated key keeps working until its `revokedAt`, then stops. */
export const isRevoked = (revokedAt: number | null, now = Date.now()) =>
  revokedAt !== null && revokedAt <= now

/** A key that works now, as a SQL condition. */
export const activeKey = (now = Date.now()) => or(isNull(apiKeys.revokedAt), gt(apiKeys.revokedAt, now))

export class InvalidKey extends Schema.TaggedError<InvalidKey>()("InvalidKey", {
  reason: Schema.String,
  code: Schema.Literals(["missing", "format", "unknown", "revoked"]),
  revokedAt: Schema.optionalKey(Schema.Number),
}) {}

/** Resolves a bearer token to the caller, or fails. The key itself is never stored, only its hash. */
export const authenticate = Effect.fn("apiKeys.authenticate")(function* (token: string) {
  const { ADMIN_KEY } = yield* Bindings
  if (ADMIN_KEY && timingSafeEqual(token, ADMIN_KEY)) return ROOT
  if (!token.trim())
    return yield* new InvalidKey({
      code: "missing",
      reason: "Send your API key as Authorization: Bearer <key>.",
    })
  if (token.startsWith("oat_"))
    return yield* new InvalidKey({
      code: "format",
      reason: "OAuth access tokens only work on /mcp, the resource they were issued for.",
    })
  const kind = token.startsWith("sk_") ? "secret" : token.startsWith("pk_") ? "public" : undefined
  if (!kind)
    return yield* new InvalidKey({ code: "format", reason: "Keys start with sk_ (secret) or pk_ (public)." })
  const database = yield* Database
  const hash = yield* Effect.promise(() => sha256(token))
  const row = yield* database
    .query("apiKeys.find", (db) => db.select().from(apiKeys).where(eq(apiKeys.hash, hash)).get())
    .pipe(Effect.orDie)
  if (!row) return yield* new InvalidKey({ code: "unknown", reason: "No such key." })
  const now = Date.now()
  if (row.revokedAt !== null && isRevoked(row.revokedAt, now))
    return yield* new InvalidKey({
      code: "revoked",
      reason: "This key was revoked.",
      revokedAt: row.revokedAt,
    })
  yield* recordUse(row.id, row.lastUsedAt, now)
  return {
    keyId: row.id,
    kind: row.kind,
    scopes: row.scopes as ReadonlyArray<Scope>,
    purpose: row.purpose,
  } satisfies Caller
})

/**
 * Counts one request against a key: one written row per request, this hour's count, and `lastUsedAt`
 * at most once a minute. Shared by Bearer requests and browser sessions opened with the key.
 */
export const recordUse = Effect.fn("apiKeys.recordUse")(function* (
  keyId: string,
  lastUsedAt: number | null,
  now = Date.now(),
) {
  const database = yield* Database
  const touch = lastUsedAt === null || now - lastUsedAt > 60_000
  yield* database
    .query("apiKeys.touch", (db) => {
      const count = db
        .insert(apiKeyUsage)
        .values({ keyId, hour: Math.floor(now / HOUR), requests: 1 })
        .onConflictDoUpdate({
          target: [apiKeyUsage.keyId, apiKeyUsage.hour],
          set: { requests: sql`${apiKeyUsage.requests} + 1` },
        })
      const write: Promise<unknown> = touch
        ? db.batch([count, db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, keyId))])
        : count.run()
      return write
    })
    .pipe(Effect.ignore)
})

export const createKey = Effect.fn("apiKeys.create")(function* (input: {
  readonly name: string
  readonly kind: Caller["kind"]
  readonly scopes?: ReadonlyArray<Scope> | undefined
  readonly purpose?: "api" | "mcp" | undefined
  readonly createdBy: string
}) {
  const database = yield* Database
  const id = yield* (yield* Ids).next
  const key = `${input.kind === "secret" ? "sk" : "pk"}_${randomToken(24)}`
  const scopes = input.kind === "public" ? (["track"] as const) : (input.scopes ?? DEFAULT_SCOPES.secret)
  const row = {
    id,
    name: input.name,
    kind: input.kind,
    purpose: input.purpose ?? "api",
    prefix: key.slice(0, 10),
    hash: yield* Effect.promise(() => sha256(key)),
    scopes: [...scopes],
    createdBy: input.createdBy,
  }
  const saved = yield* database.query("apiKeys.insert", (db) =>
    db.insert(apiKeys).values(row).returning().get(),
  )
  return { key, record: saved }
})

/** Every key, newest first; with `purpose`, only those. A handful of rows, written by people. */
export const listKeys = Effect.fn("apiKeys.list")(function* (purpose?: "api" | "mcp") {
  const database = yield* Database
  return yield* database.query("apiKeys.list", (db) =>
    db
      .select()
      .from(apiKeys)
      .where(purpose ? eq(apiKeys.purpose, purpose) : undefined)
      .orderBy(desc(apiKeys.createdAt))
      .all(),
  )
})

/** Requests in the last 24 hours per key: the current hour and the 23 before it. */
export const requests24h = Effect.fn("apiKeys.usage")(function* (
  keyIds: ReadonlyArray<string>,
  now = Date.now(),
) {
  if (keyIds.length === 0) return new Map<string, number>()
  const rows = yield* queryIn("apiKeys.usage", [...keyIds], (db, chunk) =>
    db
      .select({ keyId: apiKeyUsage.keyId, n: sql<number>`sum(${apiKeyUsage.requests})` })
      .from(apiKeyUsage)
      .where(and(inArray(apiKeyUsage.keyId, chunk), gte(apiKeyUsage.hour, Math.floor(now / HOUR) - 23)))
      .groupBy(apiKeyUsage.keyId)
      .all(),
  )
  return new Map(rows.map((r) => [r.keyId, Number(r.n)]))
})

/** Hourly: usage older than 30 days goes. */
export const pruneKeyUsage = Effect.fn("apiKeys.pruneUsage")(function* (now = Date.now()) {
  const database = yield* Database
  yield* database.query("apiKeys.pruneUsage", (db) =>
    db
      .delete(apiKeyUsage)
      .where(lt(apiKeyUsage.hour, Math.floor(now / HOUR) - 30 * 24))
      .run(),
  )
})

export class KeyNotFound extends Schema.TaggedError<KeyNotFound>()("KeyNotFound", { id: Schema.String }) {}

/** A rotation's grace period, at most a week. */
export const MAX_GRACE_SECONDS = 7 * 86_400

/**
 * `POST /v1/api-keys/{id}/rotate`: a new key with the old one's name, kind, scopes, purpose and
 * mailbox memberships, returned once. The old key keeps working for `graceSeconds` (0 by default),
 * so a deploy can switch over, then stops.
 */
export const rotateKey = Effect.fn("apiKeys.rotate")(function* (
  id: string,
  graceSeconds: number,
  actor: string,
) {
  const database = yield* Database
  const now = Date.now()
  const old = yield* database.query("apiKeys.rotateFind", (db) =>
    db.select().from(apiKeys).where(eq(apiKeys.id, id)).get(),
  )
  if (!old || isRevoked(old.revokedAt, now)) return yield* new KeyNotFound({ id })
  const created = yield* createKey({
    name: old.name,
    kind: old.kind,
    scopes: old.scopes as ReadonlyArray<Scope>,
    purpose: old.purpose,
    createdBy: actor,
  })
  const members = yield* database.query("apiKeys.rotateMembers", (db) =>
    db.select().from(mailboxMembers).where(eq(mailboxMembers.apiKeyId, id)).all(),
  )
  const revokeAt = now + Math.min(Math.max(graceSeconds, 0), MAX_GRACE_SECONDS) * 1000
  yield* database.query("apiKeys.rotate", (db) =>
    db.batch([
      db.update(apiKeys).set({ revokedAt: revokeAt }).where(eq(apiKeys.id, id)),
      ...members.map((m) =>
        db
          .insert(mailboxMembers)
          .values({ mailboxId: m.mailboxId, apiKeyId: created.record.id, role: m.role })
          .onConflictDoNothing(),
      ),
    ]),
  )
  return { ...created, previous: { id, revokedAt: revokeAt } }
})

export const revokeKey = Effect.fn("apiKeys.revoke")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("apiKeys.revoke", (db) =>
    db.update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, id)).returning().get(),
  )
  return row
})

import { Ids } from "@flareyard/kit"
import { desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Bindings } from "../Bindings.ts"
import { apiKeys } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { randomToken, sha256, timingSafeEqual } from "./crypto.ts"

export const Scope = Schema.Literals(["send", "track", "read", "admin"])
export type Scope = typeof Scope.Type

export interface Caller {
  readonly keyId: string
  readonly kind: "secret" | "public"
  readonly scopes: ReadonlyArray<Scope>
}

/** The deploy-time ADMIN_KEY: everything, and the only way to mint the first API key. */
export const ROOT: Caller = { keyId: "root", kind: "secret", scopes: ["send", "track", "read", "admin"] }

const DEFAULT_SCOPES: Record<Caller["kind"], ReadonlyArray<Scope>> = {
  secret: ["send", "track", "read"],
  public: ["track"],
}

export class InvalidKey extends Schema.TaggedError<InvalidKey>()("InvalidKey", { reason: Schema.String }) {}

/** Resolves a bearer token to the caller, or fails. The key itself is never stored, only its hash. */
export const authenticate = Effect.fn("apiKeys.authenticate")(function* (token: string) {
  const { ADMIN_KEY } = yield* Bindings
  if (ADMIN_KEY && timingSafeEqual(token, ADMIN_KEY)) return ROOT
  const kind = token.startsWith("sk_") ? "secret" : token.startsWith("pk_") ? "public" : undefined
  if (!kind) return yield* new InvalidKey({ reason: "Keys start with sk_ (secret) or pk_ (public)." })
  const database = yield* Database
  const hash = yield* Effect.promise(() => sha256(token))
  const row = yield* database
    .query("apiKeys.find", (db) => db.select().from(apiKeys).where(eq(apiKeys.hash, hash)).get())
    .pipe(Effect.orDie)
  if (!row || row.revokedAt !== null) return yield* new InvalidKey({ reason: "Unknown or revoked key." })
  yield* database
    .query("apiKeys.touch", (db) =>
      db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id)).run(),
    )
    .pipe(Effect.ignore)
  return { keyId: row.id, kind: row.kind, scopes: row.scopes as ReadonlyArray<Scope> } satisfies Caller
})

export const createKey = Effect.fn("apiKeys.create")(function* (input: {
  readonly name: string
  readonly kind: Caller["kind"]
  readonly scopes?: ReadonlyArray<Scope> | undefined
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

export const listKeys = Effect.fn("apiKeys.list")(function* () {
  const database = yield* Database
  return yield* database.query("apiKeys.list", (db) =>
    db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all(),
  )
})

export const revokeKey = Effect.fn("apiKeys.revoke")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("apiKeys.revoke", (db) =>
    db.update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, id)).returning().get(),
  )
  return row
})

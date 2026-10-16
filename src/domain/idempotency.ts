import { and, eq, lt } from "drizzle-orm"
import { Effect } from "effect"
import { idempotencyKeys } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { sha256 } from "./crypto.ts"

const TTL_MS = 24 * 60 * 60 * 1000

export type Claim =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly status: number; readonly response: unknown }
  | { readonly kind: "conflict"; readonly reason: string }

/**
 * Claims an Idempotency-Key for this caller. A first use proceeds; a repeat of the same request
 * replays the stored response; the same key on a different request, or while the first is still
 * running, is a conflict.
 */
export const claim = Effect.fn("idempotency.claim")(function* (input: {
  readonly apiKeyId: string
  readonly key: string
  readonly route: string
  readonly body: unknown
}) {
  const database = yield* Database
  const now = Date.now()
  const requestHash = yield* Effect.promise(() => sha256(`${input.route}\n${JSON.stringify(input.body)}`))
  yield* database
    .query("idempotency.expire", (db) =>
      db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, now)).run(),
    )
    .pipe(Effect.ignore)
  const inserted = yield* database.query("idempotency.insert", (db) =>
    db
      .insert(idempotencyKeys)
      .values({
        apiKeyId: input.apiKeyId,
        key: input.key,
        route: input.route,
        requestHash,
        createdAt: now,
        expiresAt: now + TTL_MS,
      })
      .onConflictDoNothing()
      .returning()
      .get(),
  )
  if (inserted) return { kind: "new" } satisfies Claim as Claim
  const existing = yield* database.query("idempotency.find", (db) =>
    db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.apiKeyId, input.apiKeyId), eq(idempotencyKeys.key, input.key)))
      .get(),
  )
  if (!existing || existing.requestHash !== requestHash) {
    return {
      kind: "conflict",
      reason: "This Idempotency-Key was already used for a different request.",
    } as Claim
  }
  if (existing.status === null || existing.response === null) {
    return {
      kind: "conflict",
      reason: "A request with this Idempotency-Key is still being processed.",
    } as Claim
  }
  return { kind: "replay", status: existing.status, response: JSON.parse(existing.response) } as Claim
})

export const complete = Effect.fn("idempotency.complete")(function* (input: {
  readonly apiKeyId: string
  readonly key: string
  readonly status: number
  readonly response: unknown
}) {
  const database = yield* Database
  yield* database.query("idempotency.complete", (db) =>
    db
      .update(idempotencyKeys)
      .set({ status: input.status, response: JSON.stringify(input.response) })
      .where(and(eq(idempotencyKeys.apiKeyId, input.apiKeyId), eq(idempotencyKeys.key, input.key)))
      .run(),
  )
})

/** Releases a claim whose request failed, so the client can retry with the same key. */
export const release = Effect.fn("idempotency.release")(function* (apiKeyId: string, key: string) {
  const database = yield* Database
  yield* database.query("idempotency.release", (db) =>
    db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.apiKeyId, apiKeyId), eq(idempotencyKeys.key, key)))
      .run(),
  )
})

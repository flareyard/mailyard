import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { apiKeys, approvals, mailboxes } from "../db/schema.ts"
import { sendDraft } from "../mail/send.ts"
import { Database } from "../services/Database.ts"
import { countSends, settlePending } from "./agents.ts"
import { type Caller, isRevoked, type Scope } from "./apiKeys.ts"
import { recordAudit } from "./audit.ts"
import { sendTransactional, type TransactionalRequest } from "./outbox.ts"
import { emitSafely } from "./webhooks.ts"

/**
 * Deciding held sends (HAL-3460). Approving one sends it through the path it was held on, as the
 * key that asked: a draft waits the undo window like any send, so it can still be stopped. Reject
 * leaves a draft where it was, unsent.
 */

export class ApprovalNotFound extends Schema.TaggedError<ApprovalNotFound>()("ApprovalNotFound", {
  id: Schema.String,
}) {}
/** Already decided, or its key was revoked since (409). */
export class ApprovalClosed extends Schema.TaggedError<ApprovalClosed>()("ApprovalClosed", {
  reason: Schema.Literals(["decided", "key-revoked"]),
  message: Schema.String,
}) {}

const find = Effect.fn("approvals.find")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("approvals.get", (db) =>
    db.select().from(approvals).where(eq(approvals.id, id)).get(),
  )
  if (!row) return yield* new ApprovalNotFound({ id })
  return row
})

export const getApproval = find

/** Marks it decided, only if it's still pending, so two people deciding at once can't both win. */
const claim = Effect.fn("approvals.claim")(function* (
  id: string,
  status: "approved" | "rejected",
  by: string,
  reason: string | null,
  now = Date.now(),
) {
  const database = yield* Database
  const done = yield* database.query("approvals.claim", (db) =>
    db
      .update(approvals)
      .set({ status, decidedAt: now, decidedBy: by, reason })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
      .run(),
  )
  if ((done.meta.changes ?? 0) === 0)
    return yield* new ApprovalClosed({ reason: "decided", message: "Someone already decided this send." })
})

/** `POST /v1/approvals/{id}/approve`: sends it, as the key that asked. */
export const approveSend = Effect.fn("approvals.approve")(function* (decider: Caller, id: string) {
  const row = yield* find(id)
  if (row.status !== "pending")
    return yield* new ApprovalClosed({ reason: "decided", message: `This send was already ${row.status}.` })
  const database = yield* Database
  const key = yield* database.query("approvals.key", (db) =>
    db.select().from(apiKeys).where(eq(apiKeys.id, row.keyId)).get(),
  )
  if (!key || (key.revokedAt !== null && isRevoked(key.revokedAt)))
    return yield* new ApprovalClosed({
      reason: "key-revoked",
      message: "The key that asked was revoked, so its send can't go out. Reject it instead.",
    })
  yield* claim(id, "approved", decider.keyId, null)
  const asker: Caller = { keyId: key.id, kind: key.kind, scopes: key.scopes as ReadonlyArray<Scope> }
  const sent = yield* Effect.gen(function* () {
    if (row.kind === "transactional") {
      const emails = yield* sendTransactional(row.request as unknown as TransactionalRequest)
      yield* countSends(row.keyId, emails.length)
      return { emails: emails.map((e) => ({ id: e.email, to: e.contact.email, status: e.status })) }
    }
    const mailbox = yield* database.query("approvals.mailbox", (db) =>
      db
        .select({ address: mailboxes.address })
        .from(mailboxes)
        .where(eq(mailboxes.id, row.mailboxId ?? ""))
        .get(),
    )
    const options = row.request as {
      sendAt?: number
      undoSeconds?: number
      track?: { opens?: boolean; clicks?: boolean }
      origin?: string | null
    }
    const result = yield* sendDraft({
      caller: asker,
      mailboxId: row.mailboxId ?? "",
      mailboxAddress: mailbox?.address ?? "",
      draftId: row.draftId ?? "",
      sendAt: options.sendAt,
      undoSeconds: options.undoSeconds,
      track: options.track,
      origin: options.origin ?? null,
      approved: true,
    })
    yield* countSends(row.keyId, 1)
    return { sendAt: result.sendAt, undoUntil: result.undoUntil }
  }).pipe(
    // A send that fails now (the draft was deleted, the domain went down) is recorded on the approval.
    Effect.tapError((e) =>
      database
        .query("approvals.failed", (db) =>
          db
            .update(approvals)
            .set({ status: "failed", result: { error: (e as { message?: string }).message ?? String(e) } })
            .where(eq(approvals.id, id))
            .run(),
        )
        .pipe(Effect.ignore),
    ),
  )
  yield* database.query("approvals.result", (db) =>
    db.update(approvals).set({ result: sent }).where(eq(approvals.id, id)).run(),
  )
  yield* recordAudit({ actor: decider.keyId, action: "approval.approve", target: id, after: sent })
  yield* emitSafely("approval.approved", {
    approvalId: id,
    keyId: row.keyId,
    kind: row.kind,
    decidedBy: decider.keyId,
  })
  yield* settlePending()
  return yield* find(id)
})

/** `POST /v1/approvals/{id}/reject { reason? }`: nothing is sent; a held draft stays a draft. */
export const rejectSend = Effect.fn("approvals.reject")(function* (
  decider: Caller,
  id: string,
  reason: string | null,
) {
  const row = yield* find(id)
  if (row.status !== "pending")
    return yield* new ApprovalClosed({ reason: "decided", message: `This send was already ${row.status}.` })
  yield* claim(id, "rejected", decider.keyId, reason?.trim().slice(0, 500) || null)
  yield* recordAudit({ actor: decider.keyId, action: "approval.reject", target: id, after: { reason } })
  yield* emitSafely("approval.rejected", {
    approvalId: id,
    keyId: row.keyId,
    kind: row.kind,
    decidedBy: decider.keyId,
    reason,
  })
  yield* settlePending()
  return yield* find(id)
})

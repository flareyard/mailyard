import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
  type AgentInvalid,
  type AgentNotFound,
  createAgent,
  getAgent,
  limitsOf,
  listAgents,
  listApprovals,
  putLimits,
  removeAgent,
  sentToday,
  updateAgent,
} from "../domain/agents.ts"
import { type ApprovalClosed, approveSend, getApproval, rejectSend } from "../domain/approvals.ts"
import { Conflict, InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { infraDies, mailboxErrors } from "./addressHandlers.ts"
import { agentConflict, appContext, provideTo, requireScope } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

const notFound = (e: AgentNotFound) => Effect.fail(new NotFound({ message: `${e.id} not found.` }))
const invalid = (e: AgentInvalid) => Effect.fail(new InvalidRequest({ field: e.field, message: e.message }))
const closed = (e: ApprovalClosed) => Effect.fail(new Conflict({ reason: e.reason, message: e.message }))

/** Agents and any key's send limits (HAL-3460). */
export const AgentsHandlers = HttpApiBuilder.group(
  MailApi,
  "agents",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      create: p(({ payload, request }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "agents.manage")
          return yield* createAgent(caller, payload, originOf(request) ?? "https://localhost")
        }).pipe(
          Effect.catchTags({ AgentInvalid: invalid, AgentNotFound: notFound }),
          mailboxErrors,
          infraDies,
        ),
      ),
      list: p(() =>
        requireScope("admin", "agents.manage").pipe(
          Effect.andThen(listAgents()),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      get: p(({ params }) =>
        requireScope("admin", "agents.manage").pipe(
          Effect.andThen(getAgent(params.id)),
          Effect.catchTags({ AgentNotFound: notFound, DatabaseError: Effect.die }),
        ),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin", "agents.manage").pipe(
          Effect.flatMap((caller) => updateAgent(caller, params.id, payload)),
          Effect.catchTags({ AgentNotFound: notFound, AgentInvalid: invalid, DatabaseError: Effect.die }),
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin", "agents.manage").pipe(
          Effect.flatMap((caller) => removeAgent(caller, params.id)),
          Effect.catchTags({ AgentNotFound: notFound, DatabaseError: Effect.die }),
        ),
      ),
      getLimits: p(({ params }) =>
        Effect.gen(function* () {
          yield* requireScope("admin", "agents.manage")
          return { limits: yield* limitsOf(params.id), sentToday: yield* sentToday(params.id) }
        }).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
      putLimits: p(({ params, payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "agents.manage")
          const limits = yield* putLimits(params.id, payload.limits, caller.keyId)
          return { limits, sentToday: yield* sentToday(params.id) }
        }).pipe(
          Effect.catchTags({ AgentNotFound: notFound, AgentInvalid: invalid, DatabaseError: Effect.die }),
        ),
      ),
    })
  }),
)

/** Deciding held sends (HAL-3460). */
export const ApprovalsHandlers = HttpApiBuilder.group(
  MailApi,
  "approvals",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    const approvalNotFound = (e: { id: string }) =>
      Effect.fail(new NotFound({ message: `Approval ${e.id} not found.` }))
    return handlers.handleAll({
      list: p(({ query }) =>
        requireScope("admin", "approvals.manage").pipe(
          Effect.andThen(listApprovals(query.status)),
          Effect.map((approvals) => ({ approvals })),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      get: p(({ params }) =>
        requireScope("admin", "approvals.manage").pipe(
          Effect.andThen(getApproval(params.id)),
          Effect.catchTags({ ApprovalNotFound: approvalNotFound, DatabaseError: Effect.die }),
        ),
      ),
      approve: p(({ params }) =>
        requireScope("admin", "approvals.manage").pipe(
          Effect.flatMap((caller) => approveSend(caller, params.id)),
          Effect.catchTags({
            ApprovalNotFound: approvalNotFound,
            ApprovalClosed: closed,
            AgentLimited: (e) => Effect.fail(agentConflict(e)),
            SendInvalid: (e) => Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            SendBlocked: (e) => Effect.fail(new Conflict({ reason: e.reason, message: e.message })),
            SendRequestInvalid: (e) =>
              Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            TemplateMissing: (e) =>
              Effect.fail(new NotFound({ message: `Template ${e.template}: ${e.reason}.` })),
          }),
          Effect.catchTags({
            DatabaseError: Effect.die,
            BlobStoreError: Effect.die,
            TrackingKeyMissing: Effect.die,
            InvalidMessage: Effect.die,
            MailboxUnavailable: Effect.die,
            MailboxRefused: (e) => Effect.fail(new Conflict({ reason: "mailbox", message: e.message })),
          }),
        ),
      ),
      reject: p(({ params, payload }) =>
        requireScope("admin", "approvals.manage").pipe(
          Effect.flatMap((caller) => rejectSend(caller, params.id, payload?.reason ?? null)),
          Effect.catchTags({
            ApprovalNotFound: approvalNotFound,
            ApprovalClosed: closed,
            DatabaseError: Effect.die,
          }),
        ),
      ),
    })
  }),
)

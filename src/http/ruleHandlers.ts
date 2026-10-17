import { Effect } from "effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { type Access, requireMailbox } from "../mail/access.ts"
import { bodyTextOf } from "../mail/compose.ts"
import { callMailbox } from "../mail/rpc.ts"
import {
  createRule,
  deleteRule,
  listRules,
  listSenders,
  putSender,
  removeSender,
  reorderRules,
  testRules,
  updateRule,
} from "../rules/manage.ts"
import { MailApi, NotFound } from "./Api.ts"
import { CurrentCaller, Forbidden } from "./Auth.ts"
import { appContext, provideTo } from "./handlers.ts"
import { mailErrors } from "./mailHandlers.ts"

const access = (mailboxId: string, need: Access) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller
    return { caller, ...(yield* requireMailbox(caller, mailboxId, need)) }
  })

/**
 * Rules can forward a mailbox's mail elsewhere or post it to a webhook, so changing them takes the
 * mailbox's owner or an admin key. Any member may read them and tend the sender lists.
 */
const owner = (mailboxId: string) =>
  Effect.gen(function* () {
    const granted = yield* access(mailboxId, "write")
    if (granted.role !== "admin" && granted.role !== "owner") {
      return yield* new Forbidden({
        message: "Changing inbox rules takes the mailbox's owner or an admin key.",
      })
    }
    return granted
  })

export const RulesHandlers = HttpApiBuilder.group(
  MailApi,
  "rules",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return { rules: yield* listRules(params.id) }
        }).pipe(mailErrors),
      ),
      create: p(({ params, payload }) =>
        Effect.gen(function* () {
          const { caller } = yield* owner(params.id)
          return yield* createRule(params.id, payload, caller.keyId)
        }).pipe(mailErrors),
      ),
      update: p(({ params, payload }) =>
        Effect.gen(function* () {
          const { caller } = yield* owner(params.id)
          return yield* updateRule(params.id, params.ruleId, payload, caller.keyId)
        }).pipe(mailErrors),
      ),
      remove: p(({ params }) =>
        Effect.gen(function* () {
          const { caller } = yield* owner(params.id)
          return yield* deleteRule(params.id, params.ruleId, caller.keyId)
        }).pipe(mailErrors),
      ),
      reorder: p(({ params, payload }) =>
        Effect.gen(function* () {
          const { caller } = yield* owner(params.id)
          return { rules: yield* reorderRules(params.id, payload.ruleIds, caller.keyId) }
        }).pipe(mailErrors),
      ),
      test: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          const message = yield* callMailbox(params.id, (s) => s.message(payload.messageId))
          if (!message) return yield* new NotFound({ message: `Message ${payload.messageId} not found.` })
          return yield* testRules(params.id, message, yield* bodyTextOf(message))
        }).pipe(mailErrors),
      ),
      senders: p(({ params, query }) =>
        Effect.gen(function* () {
          yield* access(params.id, "read")
          return { senders: yield* listSenders(params.id, query.list) }
        }).pipe(mailErrors),
      ),
      addSender: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          return yield* putSender(params.id, payload.value, payload.list, "user")
        }).pipe(mailErrors),
      ),
      removeSender: p(({ params }) =>
        Effect.gen(function* () {
          yield* access(params.id, "write")
          return yield* removeSender(params.id, params.value)
        }).pipe(mailErrors),
      ),
    })
  }),
)

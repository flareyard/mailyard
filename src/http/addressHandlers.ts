import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { mailboxMembers } from "../db/schema.ts"
import {
  createDomain,
  type DomainConflict,
  type DomainInvalid,
  type DomainNotFound,
  deleteDomain,
  domainCandidates,
  fixDomain,
  getDomain,
  listDomains,
  recheckDomain,
  updateDomain,
} from "../domain/domains.ts"
import {
  createMailbox,
  deleteMailbox,
  getMailbox,
  identitiesFor,
  listMailboxes,
  type MailboxConflict,
  type MailboxInvalid,
  type MailboxNotFound,
  type RoutingRuleExists,
  setMembers,
  updateMailbox,
} from "../domain/mailboxes.ts"
import { Database, type DatabaseError } from "../services/Database.ts"
import type { MailboxUnavailable } from "../services/Mailboxes.ts"
import { Conflict, FixRefused, InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { CurrentCaller, Forbidden } from "./Auth.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"

type Infra = DatabaseError | MailboxUnavailable

/** Database and Durable Object failures are faults, not answers: they surface as 500s. */
const infraDies = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchIf(
      (e): e is Extract<E, Infra> =>
        typeof e === "object" &&
        e !== null &&
        "_tag" in e &&
        (e._tag === "DatabaseError" || e._tag === "MailboxUnavailable"),
      Effect.die,
    ),
  ) as Effect.Effect<A, Exclude<E, Infra>, R>

/** Maps each domain error to its HTTP error, leaving the rest: distributive, so only what can happen is listed. */
type DomainHttp<E> = E extends DomainNotFound
  ? NotFound
  : E extends DomainInvalid
    ? InvalidRequest
    : E extends DomainConflict
      ? Conflict
      : E
type MailboxHttp<E> = E extends MailboxNotFound
  ? NotFound
  : E extends MailboxInvalid
    ? InvalidRequest
    : E extends MailboxConflict | RoutingRuleExists
      ? Conflict
      : E

const tagOf = (e: unknown) => (typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : "")

const domainErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.mapError(self, (e) => {
    switch (tagOf(e)) {
      case "DomainNotFound":
        return new NotFound({ message: `Domain ${(e as DomainNotFound).id} not found.` })
      case "DomainInvalid":
        return new InvalidRequest({
          field: (e as DomainInvalid).field,
          message: (e as DomainInvalid).message,
        })
      case "DomainConflict":
        return new Conflict({ message: (e as DomainConflict).message })
      default:
        return e
    }
  }) as unknown as Effect.Effect<A, DomainHttp<E>, R>

const mailboxErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.mapError(self, (e) => {
    switch (tagOf(e)) {
      case "MailboxNotFound":
        return new NotFound({ message: `Mailbox ${(e as MailboxNotFound).id} not found.` })
      case "MailboxInvalid":
        return new InvalidRequest({
          field: (e as MailboxInvalid).field,
          message: (e as MailboxInvalid).message,
        })
      case "MailboxConflict":
        return new Conflict({ message: (e as MailboxConflict).message })
      case "RoutingRuleExists": {
        const r = e as RoutingRuleExists
        return new Conflict({
          message: r.message,
          reason: "routing-rule-exists",
          ruleDestination: r.ruleDestination,
          ruleAction: r.ruleAction,
          ruleId: r.ruleId,
        })
      }
      default:
        return e
    }
  }) as unknown as Effect.Effect<A, MailboxHttp<E>, R>

/** Admin keys may change any mailbox; a mailbox's owners may change its own settings, but not its targets. */
const requireAdminOrOwner = (mailboxId: string) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller
    if (caller.keyId === "root" || caller.scopes.includes("admin")) return caller
    const database = yield* Database
    const membership = yield* database
      .query("mailboxes.ownerCheck", (db) =>
        db
          .select({ role: mailboxMembers.role })
          .from(mailboxMembers)
          .where(and(eq(mailboxMembers.mailboxId, mailboxId), eq(mailboxMembers.apiKeyId, caller.keyId)))
          .get(),
      )
      .pipe(Effect.orDie)
    if (membership?.role !== "owner") {
      return yield* new Forbidden({
        message: 'Changing a mailbox needs the "admin" scope or ownership of it.',
      })
    }
    return caller
  })

export const DomainsHandlers = HttpApiBuilder.group(
  MailApi,
  "domains",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(() =>
        requireScope("read").pipe(
          Effect.andThen(listDomains()),
          Effect.map((domains) => ({ domains })),
          infraDies,
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => createDomain(payload, caller.keyId)),
          domainErrors,
          infraDies,
        ),
      ),
      get: p(({ params }) =>
        requireScope("read").pipe(Effect.andThen(getDomain(params.id)), domainErrors, infraDies),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => updateDomain(params.id, payload, caller.keyId)),
          domainErrors,
          infraDies,
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => deleteDomain(params.id, caller.keyId)),
          domainErrors,
          infraDies,
        ),
      ),
      recheck: p(({ params }) =>
        requireScope("admin").pipe(Effect.andThen(recheckDomain(params.id)), domainErrors, infraDies),
      ),
      fix: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => fixDomain(params.id, caller.keyId)),
          Effect.catchTag("DomainFixRefused", (e) =>
            Effect.fail(new FixRefused({ reason: e.reason, message: e.message })),
          ),
          domainErrors,
          infraDies,
        ),
      ),
      candidates: p(() => requireScope("read").pipe(Effect.andThen(domainCandidates()), infraDies)),
    })
  }),
)

export const MailboxesHandlers = HttpApiBuilder.group(
  MailApi,
  "mailboxes",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ query }) =>
        requireScope("read").pipe(
          Effect.andThen(listMailboxes({ domainId: query.domainId, kind: query.kind })),
          Effect.map((mailboxes) => ({ mailboxes })),
          infraDies,
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => createMailbox(payload, caller.keyId)),
          mailboxErrors,
          infraDies,
        ),
      ),
      get: p(({ params }) =>
        requireScope("read").pipe(Effect.andThen(getMailbox(params.id)), mailboxErrors, infraDies),
      ),
      update: p(({ params, payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireAdminOrOwner(params.id)
          if (payload.targets !== undefined && caller.keyId !== "root" && !caller.scopes.includes("admin")) {
            return yield* new Forbidden({
              message: 'Changing where an address delivers needs the "admin" scope.',
            })
          }
          return yield* updateMailbox(params.id, payload, caller.keyId)
        }).pipe(mailboxErrors, infraDies),
      ),
      setMembers: p(({ params, payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => setMembers(params.id, payload.members, caller.keyId)),
          mailboxErrors,
          infraDies,
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => deleteMailbox(params.id, caller.keyId)),
          mailboxErrors,
          infraDies,
        ),
      ),
    })
  }),
)

export const IdentitiesHandlers = HttpApiBuilder.group(
  MailApi,
  "identities",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(() =>
        requireScope("send").pipe(
          Effect.flatMap((caller) => identitiesFor(caller)),
          infraDies,
        ),
      ),
    })
  }),
)

import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { Bindings } from "../Bindings.ts"
import {
  acceptInvite,
  callerFor,
  claimWithLink,
  claimWorkspace,
  createInvite,
  describeInvite,
  getMember,
  listInvites,
  listMembers,
  redeemSignInLink,
  removeMember,
  requestSignInLink,
  revokeInvite,
  sendInvite,
  transferOwnership,
  updateMember,
} from "../domain/people.ts"
import { resolveSession, SESSION_COOKIE } from "../domain/sessions.ts"
import { Conflict, Gone, InvalidRequest, MailApi, NoSystemSender, NotFound } from "./Api.ts"
import { CurrentCaller, Forbidden } from "./Auth.ts"
import { appContext, provideTo, requireScope, sameOrigin, throttle } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"
import { crossSite, startSession } from "./sessionHandlers.ts"

/** The origin links in people's mail point at: the public origin, else this request's. */
const linkBase = (request: { readonly originalUrl: string }) => originOf(request) ?? "https://localhost"

type Tagged<T extends string> = { readonly _tag: T }

/** What each people-domain error becomes over HTTP. */
type PeopleHttp<E> =
  E extends Tagged<"PeopleInvalid">
    ? InvalidRequest
    : E extends Tagged<"MemberNotFound" | "InviteNotFound">
      ? NotFound
      : E extends Tagged<"InviteGone">
        ? Gone
        : E extends Tagged<"InviteEmailMismatch" | "PeopleConflict">
          ? Conflict
          : E extends Tagged<"OwnerProtected" | "PeopleForbidden">
            ? Forbidden
            : E extends Tagged<"SystemSenderMissing">
              ? NoSystemSender
              : E extends Tagged<"SignInLinkInvalid">
                ? InvalidRequest | Gone
                : E extends Tagged<"DatabaseError">
                  ? never
                  : E

const toHttp = (e: unknown) => {
  const err = e as {
    _tag: string
    field?: string
    id?: string
    reason?: string
    message?: string
    claimedBy?: string
    claimedAt?: number
  }
  const message = err.message ?? ""
  switch (err._tag) {
    case "PeopleInvalid":
      return new InvalidRequest({ field: err.field ?? "request", message })
    case "MemberNotFound":
      return new NotFound({ message: `Member ${err.id} not found.` })
    case "InviteNotFound":
      return new NotFound({ message: "No such invitation." })
    case "InviteGone":
      return new Gone({ reason: err.reason as "expired" | "used" | "revoked", message })
    case "InviteEmailMismatch":
      return new Conflict({ reason: "email-mismatch", message })
    case "PeopleConflict":
      return new Conflict({
        reason: err.reason ?? "conflict",
        message,
        ...(err.claimedBy !== undefined ? { claimedBy: err.claimedBy } : {}),
        ...(err.claimedAt !== undefined ? { claimedAt: err.claimedAt } : {}),
      })
    case "OwnerProtected":
      return new Forbidden({ message, reason: "owner" })
    case "PeopleForbidden":
      return new Forbidden({ message })
    case "SystemSenderMissing":
      return new NoSystemSender({ message })
    case "SignInLinkInvalid":
      return err.reason === "unknown"
        ? new InvalidRequest({ field: "token", message })
        : new Gone({ reason: err.reason as "expired" | "used", message })
    default:
      return e
  }
}

/** Maps the people domain's refusals to HTTP; database faults are 500s. */
const peopleErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchIf((e): e is E => (e as { _tag?: string })?._tag === "DatabaseError", Effect.die),
    Effect.mapError(toHttp),
  ) as unknown as Effect.Effect<A, PeopleHttp<E>, R>

/** Signing in with an emailed link (HAL-3361). */
export const SignInLinkHandlers = HttpApiBuilder.group(
  MailApi,
  "signInLink",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      request: p(({ payload, request }) =>
        Effect.gen(function* () {
          const { MAILYARD_PUBLIC_ORIGIN } = yield* Bindings
          if (request.headers.origin && !sameOrigin(request, MAILYARD_PUBLIC_ORIGIN))
            return yield* crossSite()
          // Every request counts against the address's limit: this one mails people.
          yield* throttle
          return yield* requestSignInLink(payload.email, linkBase(request))
        }).pipe(peopleErrors),
      ),
      verify: p(({ payload, request }) =>
        Effect.gen(function* () {
          const { MAILYARD_PUBLIC_ORIGIN } = yield* Bindings
          if (request.headers.origin && !sameOrigin(request, MAILYARD_PUBLIC_ORIGIN))
            return yield* crossSite()
          const member = yield* redeemSignInLink(payload.token).pipe(
            Effect.tapError(() => throttle.pipe(Effect.ignore)),
          )
          return yield* startSession(callerFor(member), request)
        }).pipe(peopleErrors),
      ),
      claimWithLink: p(({ payload, request }) =>
        Effect.gen(function* () {
          const { MAILYARD_PUBLIC_ORIGIN } = yield* Bindings
          if (request.headers.origin && !sameOrigin(request, MAILYARD_PUBLIC_ORIGIN))
            return yield* crossSite()
          const member = yield* claimWithLink(payload, linkBase(request)).pipe(
            Effect.tapError(() => throttle.pipe(Effect.ignore)),
          )
          return yield* startSession(callerFor(member), request)
        }).pipe(peopleErrors),
      ),
    })
  }),
)

/** An invitation as the invited person sees it. */
export const InviteLinkHandlers = HttpApiBuilder.group(
  MailApi,
  "inviteLink",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      describe: p(({ params }) => describeInvite(params.token).pipe(peopleErrors)),
      accept: p(({ params, payload, request }) =>
        Effect.gen(function* () {
          const { MAILYARD_PUBLIC_ORIGIN } = yield* Bindings
          if (!sameOrigin(request, MAILYARD_PUBLIC_ORIGIN)) return yield* crossSite()
          // Whoever is signed in already, if anyone: accepting as someone else is a mismatch.
          const cookie = request.cookies[SESSION_COOKIE]
          const signedIn = cookie
            ? yield* resolveSession(cookie).pipe(Effect.orElseSucceed(() => null))
            : null
          const member = yield* acceptInvite(params.token, { name: payload?.name }, signedIn)
          return yield* startSession(callerFor(member), request)
        }).pipe(peopleErrors),
      ),
    })
  }),
)

/** Members, invitations, claiming and handing on the workspace. */
export const PeopleHandlers = HttpApiBuilder.group(
  MailApi,
  "people",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      claim: p(({ payload, request }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller
          return yield* claimWorkspace(caller, payload, linkBase(request))
        }).pipe(peopleErrors),
      ),
      transfer: p(({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "workspace.owner")
          return yield* transferOwnership(caller, payload.memberId)
        }).pipe(peopleErrors),
      ),
      listMembers: p(() =>
        requireScope("admin", "members.manage").pipe(Effect.andThen(listMembers()), peopleErrors),
      ),
      getMember: p(({ params }) =>
        requireScope("admin", "members.manage").pipe(Effect.andThen(getMember(params.id)), peopleErrors),
      ),
      updateMember: p(({ params, payload }) =>
        requireScope("admin", "members.manage").pipe(
          Effect.flatMap((caller) => updateMember(caller, params.id, payload)),
          peopleErrors,
        ),
      ),
      removeMember: p(({ params }) =>
        requireScope("admin", "members.manage").pipe(
          Effect.flatMap((caller) => removeMember(caller, params.id)),
          peopleErrors,
        ),
      ),
      listInvites: p(() =>
        requireScope("admin", "members.manage").pipe(Effect.andThen(listInvites()), peopleErrors),
      ),
      createInvite: p(({ payload, request }) =>
        requireScope("admin", "members.manage").pipe(
          Effect.flatMap((caller) => createInvite(caller, payload, linkBase(request))),
          peopleErrors,
        ),
      ),
      sendInvite: p(({ params, request }) =>
        requireScope("admin", "members.manage").pipe(
          Effect.flatMap((caller) => sendInvite(caller, params.id, linkBase(request))),
          peopleErrors,
        ),
      ),
      resendInvite: p(({ params, request }) =>
        requireScope("admin", "members.manage").pipe(
          Effect.flatMap((caller) => sendInvite(caller, params.id, linkBase(request))),
          peopleErrors,
        ),
      ),
      revokeInvite: p(({ params }) =>
        requireScope("admin", "members.manage").pipe(
          Effect.flatMap((caller) => revokeInvite(caller, params.id)),
          peopleErrors,
        ),
      ),
    })
  }),
)

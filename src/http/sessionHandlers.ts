import * as Effect from "effect/Effect"
import * as HttpEffect from "effect/http/HttpEffect"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { Bindings } from "../Bindings.ts"
import { authenticate, type Caller } from "../domain/apiKeys.ts"
import { updateSelf } from "../domain/people.ts"
import { ROLE_SCOPES } from "../domain/permissions.ts"
import {
  clientOf,
  describeCaller,
  endOtherSessions,
  endSession,
  endSessionByToken,
  listSessions,
  openSession,
  SESSION_COOKIE,
  SESSION_MAX_MS,
} from "../domain/sessions.ts"
import { InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { CurrentCaller, Forbidden, Unauthorized } from "./Auth.ts"
import { appContext, clearSessionCookie, provideTo, sameOrigin, throttle } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

/**
 * Opens a browser session for a caller that has just proved who it is (a key, a sign-in link, an
 * accepted invitation), sets the cookie on the response, and answers like `GET /v1/me`.
 */
export const startSession = (caller: Caller, request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const { token, session } = yield* openSession(caller, clientOf(request.headers))
    yield* HttpEffect.appendPreResponseHandler((_req, response) =>
      Effect.orDie(
        HttpServerResponse.setCookie(response, SESSION_COOKIE, token, {
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          // The browser may keep it to the absolute cap; the server ends it sooner when idle.
          maxAge: `${Math.floor(SESSION_MAX_MS / 1000)} seconds`,
        }),
      ),
    )
    const signedIn: Caller = caller.member
      ? { ...caller, scopes: ROLE_SCOPES[caller.member.role], sessionId: session.id }
      : { ...caller, sessionId: session.id }
    return yield* describeCaller(signedIn, originOf(request) ?? "https://localhost")
  })

export const crossSite = () =>
  new Forbidden({
    message: "Sign-in and sign-out must come from this site. Reload the page and try again.",
    reason: "csrf",
  })

/** `POST /v1/session` and `DELETE /v1/session`: the web app signing in and out (HAL-3358). */
export const SessionHandlers = HttpApiBuilder.group(
  MailApi,
  "session",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      signIn: p(({ payload, request }) =>
        Effect.gen(function* () {
          // A form on another site can't sign someone in to an account of its choosing.
          const { MAILYARD_PUBLIC_ORIGIN } = yield* Bindings
          if (request.headers.origin && !sameOrigin(request, MAILYARD_PUBLIC_ORIGIN))
            return yield* crossSite()
          const caller = yield* authenticate(payload.key.trim()).pipe(
            Effect.catchTag("InvalidKey", (e) =>
              throttle.pipe(
                Effect.andThen(
                  new Unauthorized({
                    message: e.reason,
                    reason: e.code,
                    ...(e.revokedAt !== undefined ? { revokedAt: e.revokedAt } : {}),
                  }),
                ),
              ),
            ),
          )
          if (caller.kind === "public")
            return yield* new Forbidden({
              message:
                "Public keys (pk_) can only track events. Sign in with a secret key (sk_) that can read.",
              reason: "public-key",
              required: "read",
              scopes: [...caller.scopes],
            })
          if (!caller.scopes.includes("read"))
            return yield* new Forbidden({
              message: 'Opening the app needs a key with the "read" scope.',
              reason: "insufficient-scope",
              required: "read",
              scopes: [...caller.scopes],
            })
          return yield* startSession(caller, request)
        }).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
      signOut: p(({ request }) =>
        Effect.gen(function* () {
          const token = request.cookies[SESSION_COOKIE]
          if (token) {
            if (!sameOrigin(request, (yield* Bindings).MAILYARD_PUBLIC_ORIGIN)) return yield* crossSite()
            yield* endSessionByToken(token)
          }
          yield* clearSessionCookie
        }).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
    })
  }),
)

/** `GET /v1/me` and "Your sessions". */
export const MeHandlers = HttpApiBuilder.group(
  MailApi,
  "me",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      updateMe: p(({ payload, request }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller
          yield* updateSelf(caller, payload)
          return yield* describeCaller(caller, originOf(request) ?? "https://localhost")
        }).pipe(
          Effect.catchTags({
            PeopleForbidden: (e) => Effect.fail(new Forbidden({ message: e.message })),
            PeopleInvalid: (e) => Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            MemberNotFound: Effect.die,
            OwnerProtected: Effect.die,
            DatabaseError: Effect.die,
          }),
        ),
      ),
      me: p(({ request }) =>
        Effect.flatMap(CurrentCaller, (caller) =>
          describeCaller(caller, originOf(request) ?? "https://localhost"),
        ).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
      listSessions: p(() =>
        Effect.flatMap(CurrentCaller, (caller) =>
          Effect.map(listSessions(caller), (sessions) => ({ sessions })),
        ).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
      endOtherSessions: p(() =>
        Effect.flatMap(CurrentCaller, (caller) => endOtherSessions(caller)).pipe(
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      endSession: p(({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) =>
          endSession(caller, params.id).pipe(
            Effect.catchTag("SessionNotFound", (e) =>
              Effect.fail(new NotFound({ message: `Session ${e.id} not found.` })),
            ),
          ),
        ).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
    })
  }),
)

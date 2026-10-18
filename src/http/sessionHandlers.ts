import * as Effect from "effect/Effect"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { authenticate } from "../domain/apiKeys.ts"
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
import { MailApi, NotFound } from "./Api.ts"
import { CurrentCaller, Forbidden, Unauthorized } from "./Auth.ts"
import { appContext, clearSessionCookie, provideTo, sameOrigin, throttle } from "./handlers.ts"

const crossSite = () =>
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
          if (request.headers.origin && !sameOrigin(request)) return yield* crossSite()
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
          return yield* describeCaller({ ...caller, sessionId: session.id })
        }).pipe(Effect.catchTag("DatabaseError", Effect.die)),
      ),
      signOut: p(({ request }) =>
        Effect.gen(function* () {
          const token = request.cookies[SESSION_COOKIE]
          if (token) {
            if (!sameOrigin(request)) return yield* crossSite()
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
      me: p(() =>
        Effect.flatMap(CurrentCaller, (caller) => describeCaller(caller)).pipe(
          Effect.catchTag("DatabaseError", Effect.die),
        ),
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

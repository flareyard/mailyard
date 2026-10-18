import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
  getPreferences,
  listSubscriptions,
  putPreferences,
  sendTest,
  subscribe,
  unsubscribe,
  vapidKeys,
} from "../push/notifications.ts"
import { InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { infraDies } from "./addressHandlers.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"

/**
 * Web Push (HAL-3369). Anyone who reads mail can subscribe their own browsers; what each caller sees
 * and changes is only their own subscriptions and preferences.
 */
export const PushHandlers = HttpApiBuilder.group(
  MailApi,
  "push",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    const me = requireScope("read", "mail.read").pipe(Effect.map((caller) => caller.keyId))
    return handlers.handleAll({
      vapidKey: p(() =>
        me.pipe(
          Effect.andThen(vapidKeys()),
          Effect.map((k) => ({ publicKey: k.publicKey })),
          infraDies,
        ),
      ),
      subscriptions: p(() =>
        me.pipe(
          Effect.flatMap((owner) => listSubscriptions(owner)),
          Effect.map((subscriptions) => ({ subscriptions })),
          infraDies,
        ),
      ),
      subscribe: p(({ payload }) =>
        me.pipe(
          Effect.flatMap((owner) => subscribe(owner, payload)),
          Effect.catchTag("PushInvalid", (e) =>
            Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
          ),
          infraDies,
        ),
      ),
      unsubscribe: p(({ params }) =>
        me.pipe(
          Effect.flatMap((owner) => unsubscribe(owner, params.id)),
          Effect.catchTag("PushNotFound", (e) =>
            Effect.fail(new NotFound({ message: `Subscription ${e.id} not found.` })),
          ),
          infraDies,
        ),
      ),
      preferences: p(() =>
        me.pipe(
          Effect.flatMap((owner) => getPreferences(owner)),
          infraDies,
        ),
      ),
      putPreferences: p(({ payload }) =>
        me.pipe(
          Effect.flatMap((owner) => putPreferences(owner, payload)),
          infraDies,
        ),
      ),
      test: p(() =>
        me.pipe(
          Effect.flatMap((owner) => sendTest(owner)),
          infraDies,
        ),
      ),
    })
  }),
)

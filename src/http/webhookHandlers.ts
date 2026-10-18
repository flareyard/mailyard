import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listDeliveries,
  listEndpoints,
  replay,
  replayDead,
  rotateSecret,
  sendTest,
  updateEndpoint,
  WEBHOOK_EVENTS,
  type WebhookInvalid,
  type WebhookNotFound,
} from "../domain/webhooks.ts"
import type { DatabaseError } from "../services/Database.ts"
import { InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"

const notFound = <A, E, R>(self: Effect.Effect<A, E | WebhookNotFound, R>) =>
  Effect.catchTag(self, "WebhookNotFound", (e) =>
    Effect.fail(new NotFound({ message: `Webhook ${(e as WebhookNotFound).id} not found.` })),
  ) as Effect.Effect<A, Exclude<E, WebhookNotFound> | NotFound, R>

const invalid = <A, E, R>(self: Effect.Effect<A, E | WebhookInvalid, R>) =>
  Effect.catchTag(self, "WebhookInvalid", (e) =>
    Effect.fail(new InvalidRequest({ field: "webhook", message: (e as WebhookInvalid).message })),
  ) as Effect.Effect<A, Exclude<E, WebhookInvalid> | InvalidRequest, R>

const dbDies = <A, E, R>(self: Effect.Effect<A, E | DatabaseError, R>) =>
  Effect.catchTag(self, "DatabaseError", Effect.die) as Effect.Effect<A, Exclude<E, DatabaseError>, R>

/** Webhooks change where data goes, so managing them needs `admin`; reading the log needs `read`. */
export const WebhooksHandlers = HttpApiBuilder.group(
  MailApi,
  "webhooks",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(() =>
        requireScope("read", "settings.read").pipe(
          Effect.andThen(listEndpoints()),
          Effect.map((webhooks) => ({ webhooks, events: [...WEBHOOK_EVENTS] })),
          dbDies,
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin", "webhooks.manage").pipe(
          Effect.andThen(createEndpoint(payload)),
          invalid,
          dbDies,
        ),
      ),
      get: p(({ params }) =>
        requireScope("read", "settings.read").pipe(Effect.andThen(getEndpoint(params.id)), notFound, dbDies),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin", "webhooks.manage").pipe(
          Effect.andThen(updateEndpoint(params.id, payload)),
          notFound,
          invalid,
          dbDies,
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin", "webhooks.manage").pipe(
          Effect.andThen(deleteEndpoint(params.id)),
          notFound,
          dbDies,
        ),
      ),
      rotateSecret: p(({ params }) =>
        requireScope("admin", "webhooks.manage").pipe(
          Effect.andThen(rotateSecret(params.id)),
          notFound,
          dbDies,
        ),
      ),
      deliveries: p(({ params, query }) =>
        requireScope("read", "settings.read").pipe(
          Effect.andThen(
            listDeliveries(params.id, {
              status: query.status,
              cursor: query.cursor,
              limit: query.limit ?? 50,
            }),
          ),
          notFound,
          dbDies,
        ),
      ),
      replay: p(({ params }) =>
        requireScope("admin", "webhooks.manage").pipe(
          Effect.andThen(replay(params.id, params.deliveryId)),
          notFound,
          dbDies,
        ),
      ),
      replayAll: p(({ params }) =>
        requireScope("admin", "webhooks.manage").pipe(
          Effect.andThen(replayDead(params.id)),
          notFound,
          dbDies,
        ),
      ),
      test: p(({ params }) =>
        requireScope("admin", "webhooks.manage").pipe(Effect.andThen(sendTest(params.id)), notFound, dbDies),
      ),
    })
  }),
)

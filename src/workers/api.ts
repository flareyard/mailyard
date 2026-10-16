import { env } from "cloudflare:workers"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import type { Env } from "../Bindings.ts"
import { MailApi } from "../http/Api.ts"
import {
  ActionsHandlers,
  ApiKeyAuthLive,
  ApiKeysHandlers,
  MessagesHandlers,
  SystemHandlers,
} from "../http/handlers.ts"
import { SettingsHandlers, TemplatesHandlers } from "../http/templateHandlers.ts"
import { WebhooksHandlers } from "../http/webhookHandlers.ts"
import { appLayer } from "../layers.ts"
import { handleQueue } from "./queue.ts"

const Routes = HttpApiBuilder.layer(MailApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([
    SystemHandlers,
    ActionsHandlers,
    ApiKeysHandlers,
    MessagesHandlers,
    TemplatesHandlers,
    SettingsHandlers,
    WebhooksHandlers,
  ]),
  Layer.provide(ApiKeyAuthLive),
  Layer.provide(appLayer(env)),
  Layer.provide(HttpServer.layerServices),
)

// Built once per isolate; Workers reuse an isolate across requests.
const { handler } = HttpRouter.toWebHandler(Routes, { disableLogger: true })

export default {
  fetch: (request) => handler(request),
  queue: (batch, env) => handleQueue(batch, env),
} satisfies ExportedHandler<Env>

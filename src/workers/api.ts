import { env } from "cloudflare:workers"
import { Layer } from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import type { Env } from "../Bindings.ts"
import { MailApi } from "../http/Api.ts"
import {
  ActionsHandlers,
  ApiKeyAuthLive,
  ApiKeysHandlers,
  MessagesHandlers,
  SystemHandlers,
} from "../http/handlers.ts"
import { InboundHandlers } from "../http/inboundHandlers.ts"
import { InsightsHandlers } from "../http/insightHandlers.ts"
import { SettingsHandlers, TemplatesHandlers } from "../http/templateHandlers.ts"
import { WebhooksHandlers } from "../http/webhookHandlers.ts"
import { appLayer } from "../layers.ts"
import { handleEmail } from "./inbound.ts"
import { handleQueue } from "./queue.ts"

export { MailboxDO } from "../objects/MailboxDO.ts"

const Routes = HttpApiBuilder.layer(MailApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([
    SystemHandlers,
    ActionsHandlers,
    ApiKeysHandlers,
    MessagesHandlers,
    TemplatesHandlers,
    SettingsHandlers,
    WebhooksHandlers,
    InsightsHandlers,
    InboundHandlers,
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
  email: async (message, env) => {
    await handleEmail(message, env)
  },
} satisfies ExportedHandler<Env>

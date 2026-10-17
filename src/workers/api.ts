import { env } from "cloudflare:workers"
import { Layer } from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import type { Env } from "../Bindings.ts"
import { MailApi } from "../http/Api.ts"
import { DomainsHandlers, IdentitiesHandlers, MailboxesHandlers } from "../http/addressHandlers.ts"
import {
  ActionsHandlers,
  ApiKeyAuthLive,
  ApiKeysHandlers,
  MessagesHandlers,
  SystemHandlers,
} from "../http/handlers.ts"
import { InboundHandlers } from "../http/inboundHandlers.ts"
import { InsightsHandlers } from "../http/insightHandlers.ts"
import { MailHandlers } from "../http/mailHandlers.ts"
import { RulesHandlers } from "../http/ruleHandlers.ts"
import { SettingsHandlers, TemplatesHandlers } from "../http/templateHandlers.ts"
import { WebhooksHandlers } from "../http/webhookHandlers.ts"
import { appLayer } from "../layers.ts"
import {
  ATTACHMENT_PATH,
  FILE_PATH,
  handleAttachment,
  handleFile,
  handleRaw,
  handleUpload,
  RAW_PATH,
  UPLOAD_PATH,
} from "./files.ts"
import { handleEmail } from "./inbound.ts"
import { handleLive, LIVE_PATH } from "./live.ts"
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
    DomainsHandlers,
    MailboxesHandlers,
    IdentitiesHandlers,
    MailHandlers,
    RulesHandlers,
  ]),
  Layer.provide(ApiKeyAuthLive),
  Layer.provide(appLayer(env)),
  Layer.provide(HttpServer.layerServices),
)

// Built once per isolate; Workers reuse an isolate across requests.
const { handler } = HttpRouter.toWebHandler(Routes, { disableLogger: true })

export default {
  fetch: (request, env) => {
    // Routes that carry bytes or sockets rather than JSON sit beside the schema-first API.
    const path = new URL(request.url).pathname
    const d = (s: string | undefined) => decodeURIComponent(s ?? "")
    const live = LIVE_PATH.exec(path)
    if (live) return handleLive(request, env, d(live[1]))
    const upload = UPLOAD_PATH.exec(path)
    if (upload) return handleUpload(request, env, d(upload[1]))
    const raw = RAW_PATH.exec(path)
    if (raw && request.method === "GET") return handleRaw(request, env, d(raw[1]), d(raw[2]))
    const attachment = ATTACHMENT_PATH.exec(path)
    if (attachment && request.method === "GET")
      return handleAttachment(request, env, d(attachment[1]), d(attachment[2]), d(attachment[3]))
    const file = FILE_PATH.exec(path)
    if (file && request.method === "GET") return handleFile(request, env, d(file[1]))
    return handler(request)
  },
  queue: (batch, env) => handleQueue(batch, env),
  email: async (message, env) => {
    await handleEmail(message, env)
  },
} satisfies ExportedHandler<Env>

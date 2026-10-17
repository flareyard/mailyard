import { env } from "cloudflare:workers"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"
import { UNSUBSCRIBE_PATH } from "../domain/unsubscribe.ts"
import { MailApi } from "../http/Api.ts"
import { DomainsHandlers, IdentitiesHandlers, MailboxesHandlers } from "../http/addressHandlers.ts"
import {
  ContactsHandlers,
  FormsHandlers,
  SegmentsHandlers,
  TopicsHandlers,
} from "../http/audienceHandlers.ts"
import { CampaignsHandlers } from "../http/campaignHandlers.ts"
import {
  ActionsHandlers,
  ApiKeyAuthLive,
  ApiKeysHandlers,
  MessagesHandlers,
  SystemHandlers,
} from "../http/handlers.ts"
import { ImportsHandlers } from "../http/importHandlers.ts"
import { InboundHandlers } from "../http/inboundHandlers.ts"
import { InsightsHandlers } from "../http/insightHandlers.ts"
import { MailHandlers } from "../http/mailHandlers.ts"
import { RulesHandlers } from "../http/ruleHandlers.ts"
import { AlertsHandlers, SendingHandlers } from "../http/sendingHandlers.ts"
import { SettingsHandlers, TemplatesHandlers } from "../http/templateHandlers.ts"
import { TransfersHandlers } from "../http/transferHandlers.ts"
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
import { CONFIRM_PATH, FORM_SUBMIT_PATH, handleConfirm, handleFormSubmit } from "./public.ts"
import { handleQueue } from "./queue.ts"
import { handleScheduled } from "./scheduled.ts"
import { CLICK_PATH, handleClick, handleOpen, OPEN_PATH } from "./track.ts"
import { handleUnsubscribe } from "./unsubscribe.ts"
import { handleUploads, UPLOADS_PATH } from "./uploads.ts"

export { MailboxDO } from "../objects/MailboxDO.ts"
export { SendGovernorDO } from "../objects/SendGovernorDO.ts"
export { CampaignSendWorkflow } from "../workflows/campaign.ts"
export { ContactImportWorkflow } from "../workflows/contactImport.ts"
export { MailboxExportWorkflow, MailboxImportWorkflow } from "../workflows/mailbox.ts"

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
    TransfersHandlers,
    ContactsHandlers,
    TopicsHandlers,
    FormsHandlers,
    SegmentsHandlers,
    SendingHandlers,
    AlertsHandlers,
    CampaignsHandlers,
    ImportsHandlers,
  ]),
  Layer.provide(ApiKeyAuthLive),
  Layer.provide(appLayer(env)),
  Layer.provide(HttpServer.layerServices),
)

// Built once per isolate; Workers reuse an isolate across requests.
const { handler } = HttpRouter.toWebHandler(Routes, { disableLogger: true })

export default {
  fetch: (request, env, ctx) => {
    // Routes that carry bytes or sockets rather than JSON sit beside the schema-first API.
    const path = new URL(request.url).pathname
    const d = (s: string | undefined) => decodeURIComponent(s ?? "")
    const live = LIVE_PATH.exec(path)
    if (live) return handleLive(request, env, d(live[1]))
    if (UPLOADS_PATH.test(path)) return handleUploads(request, env)
    const upload = UPLOAD_PATH.exec(path)
    if (upload) return handleUpload(request, env, d(upload[1]))
    const raw = RAW_PATH.exec(path)
    if (raw && request.method === "GET") return handleRaw(request, env, d(raw[1]), d(raw[2]))
    const attachment = ATTACHMENT_PATH.exec(path)
    if (attachment && request.method === "GET")
      return handleAttachment(request, env, d(attachment[1]), d(attachment[2]), d(attachment[3]))
    const file = FILE_PATH.exec(path)
    if (file && request.method === "GET") return handleFile(request, env, d(file[1]))
    const confirm = CONFIRM_PATH.exec(path)
    if (confirm && request.method === "GET") return handleConfirm(env, d(confirm[1]))
    const open = OPEN_PATH.exec(path)
    if (open && request.method === "GET") return handleOpen(request, env, d(open[1]), ctx)
    const click = CLICK_PATH.exec(path)
    if (click && (request.method === "GET" || request.method === "HEAD"))
      return handleClick(request, env, d(click[1]))
    const unsubscribe = UNSUBSCRIBE_PATH.exec(path)
    if (unsubscribe) return handleUnsubscribe(request, env, d(unsubscribe[1]))
    const form = FORM_SUBMIT_PATH.exec(path)
    if (form) return handleFormSubmit(request, env, d(form[1]))
    return handler(request)
  },
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(handleScheduled(env))
  },
  email: async (message, env) => {
    await handleEmail(message, env)
  },
} satisfies ExportedHandler<Env>

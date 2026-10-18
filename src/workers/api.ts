import { env } from "cloudflare:workers"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"
import { VIEW_PATH } from "../campaigns/content.ts"
import { BRAND_LOGO_PATH } from "../domain/brand.ts"
import { UNSUBSCRIBE_PATH } from "../domain/unsubscribe.ts"
import { MailApi } from "../http/Api.ts"
import { DomainsHandlers, IdentitiesHandlers, MailboxesHandlers } from "../http/addressHandlers.ts"
import {
  ContactsHandlers,
  FormsHandlers,
  SegmentsHandlers,
  TopicsHandlers,
} from "../http/audienceHandlers.ts"
import { AutomationsHandlers, RunsHandlers } from "../http/automationHandlers.ts"
import { CampaignsHandlers } from "../http/campaignHandlers.ts"
import { ExportsHandlers } from "../http/exportHandlers.ts"
import { FilesHandlers } from "../http/filesHandlers.ts"
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
import { OverviewHandlers } from "../http/overviewHandlers.ts"
import { PublicFormsHandlers } from "../http/publicFormsHandlers.ts"
import { RulesHandlers } from "../http/ruleHandlers.ts"
import { SearchHandlers } from "../http/searchHandlers.ts"
import { AlertsHandlers, SendingHandlers } from "../http/sendingHandlers.ts"
import { SuppressionsHandlers } from "../http/suppressionHandlers.ts"
import { SettingsHandlers, TemplatesHandlers } from "../http/templateHandlers.ts"
import { TransfersHandlers } from "../http/transferHandlers.ts"
import { WebhooksHandlers } from "../http/webhookHandlers.ts"
import { appLayer } from "../layers.ts"
import { handleMcp, MCP_PATH } from "../mcp/handler.ts"
import {
  ATTACHMENT_PATH,
  FILE_PATH,
  handleAttachment,
  handleFile,
  handleMessageRaw,
  handleRaw,
  handleUpload,
  MESSAGE_RAW_PATH,
  RAW_PATH,
  UPLOAD_PATH,
} from "./files.ts"
import { handleEmail } from "./inbound.ts"
import { handleLive, LIVE_PATH } from "./live.ts"
import {
  CONFIRM_PATH,
  FORM_PAGE_PATH,
  FORM_SUBMIT_PATH,
  handleConfirm,
  handleFormPage,
  handleFormSubmit,
} from "./public.ts"
import { handleQueue } from "./queue.ts"
import { handleScheduled } from "./scheduled.ts"
import { handleAuditCsv, handleBrandLogo } from "./settingsFiles.ts"
import { handleStatsCsv, STATS_CSV_PATH } from "./statsCsv.ts"
import { CLICK_PATH, handleClick, handleOpen, OPEN_PATH } from "./track.ts"
import { handleRequestLink, handleUnsubscribe, REQUEST_LINK_PATH } from "./unsubscribe.ts"
import { handleUploads, UPLOADS_PATH } from "./uploads.ts"
import { handleView } from "./view.ts"

export { MailboxDO } from "../objects/MailboxDO.ts"
export { SendGovernorDO } from "../objects/SendGovernorDO.ts"
export { AutomationRunWorkflow } from "../workflows/automation.ts"
export { CampaignSendWorkflow } from "../workflows/campaign.ts"
export { ContactBulkWorkflow } from "../workflows/contactBulk.ts"
export { ContactExportWorkflow } from "../workflows/contactExport.ts"
export { ContactImportWorkflow } from "../workflows/contactImport.ts"
export { MailboxExportWorkflow, MailboxImportWorkflow } from "../workflows/mailbox.ts"
export { SuppressionImportWorkflow } from "../workflows/suppressionImport.ts"
export { WorkspaceExportWorkflow } from "../workflows/workspaceExport.ts"

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
    PublicFormsHandlers,
    FilesHandlers,
    SuppressionsHandlers,
    OverviewHandlers,
    SearchHandlers,
    ExportsHandlers,
    AutomationsHandlers,
    RunsHandlers,
  ]),
  Layer.provide(ApiKeyAuthLive),
  Layer.provide(appLayer(env)),
  Layer.provide(HttpServer.layerServices),
)

// Built once per isolate; Workers reuse an isolate across requests.
const { handler } = HttpRouter.toWebHandler(Routes, { disableLogger: true })

/** The Worker's routes: bytes and sockets beside the schema-first API. */
const route = (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> => {
  // Routes that carry bytes or sockets rather than JSON sit beside the schema-first API.
  const path = new URL(request.url).pathname
  if (path === MCP_PATH) return handleMcp(request, env)
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
  if (
    path === "/v1/audit" &&
    request.method === "GET" &&
    new URL(request.url).searchParams.get("format") === "csv"
  )
    return handleAuditCsv(request, env)
  const logo = BRAND_LOGO_PATH.exec(path)
  if (logo) return handleBrandLogo(request, env, logo[1] ?? "")
  const statsCsv = STATS_CSV_PATH.exec(path)
  if (statsCsv) return handleStatsCsv(request, env, statsCsv[1] ?? "")
  const messageRaw = MESSAGE_RAW_PATH.exec(path)
  if (messageRaw && request.method === "GET") return handleMessageRaw(request, env, d(messageRaw[1]))
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
  if (REQUEST_LINK_PATH.test(path)) return handleRequestLink(request, env)
  const view = VIEW_PATH.exec(path)
  if (view) return handleView(request, env, d(view[1]))
  const formPage = FORM_PAGE_PATH.exec(path)
  if (formPage) return handleFormPage(request, env, d(formPage[1]))
  const form = FORM_SUBMIT_PATH.exec(path)
  if (form) return handleFormSubmit(request, env, d(form[1]))
  return handler(request)
}

/**
 * Every response carries `x-request-id` (Cloudflare's ray id when there is one), and every error
 * body (`{ _tag, … }` from the API, `{ error }` from the raw routes) the same `requestId`, so a
 * person can quote it and the logs can find it.
 */
const withRequestId = async (request: Request, respond: () => Response | Promise<Response>) => {
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID()
  const response = await respond()
  // A WebSocket upgrade's response can't be rebuilt.
  if (response.status === 101 || response.webSocket) return response
  const headers = new Headers(response.headers)
  headers.set("x-request-id", requestId)
  if (response.status >= 400 && (headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (body && typeof body === "object") {
      if (response.status >= 500)
        console.error(
          `request ${requestId} failed with ${response.status}`,
          JSON.stringify(body).slice(0, 500),
        )
      headers.delete("content-length")
      return new Response(JSON.stringify({ ...body, requestId }), {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  fetch: (request, env, ctx) => withRequestId(request, () => route(request, env, ctx)),
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(handleScheduled(env))
  },
  email: async (message, env) => {
    await handleEmail(message, env)
  },
} satisfies ExportedHandler<Env>

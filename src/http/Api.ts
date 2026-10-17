import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as OpenApi from "effect/http-api/OpenApi"
import * as Schema from "effect/Schema"
import { RECIPIENT_FILTERS } from "../campaigns/report.ts"
import { Action as RuleAction, Condition as RuleCondition } from "../rules/engine.ts"
import { ApiKeyAuth, Forbidden } from "./Auth.ts"

export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  app: Schema.Literal("mailyard"),
  version: Schema.String,
  database: Schema.Literal("ok"),
})

export class Unhealthy extends Schema.TaggedError<Unhealthy>()(
  "Unhealthy",
  { database: Schema.Literal("unreachable") },
  { httpApiStatus: 503 },
) {}

/** The platform's health check calls this before it marks a deploy as running (manifest `health`). */
export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/healthz", { success: Health, error: Unhealthy }),
) {}

// ---------------------------------------------------------------------------------------------
// Plunk-compatible actions. Shapes measured from useplunk/plunk `apps/api/src/controllers/Actions.ts`
// (branch next, 2026-10-16), so the Plunk SDK works by changing only its base URL.
// ---------------------------------------------------------------------------------------------

const Email = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
const Named = Schema.Struct({ email: Email, name: Schema.optionalKey(Schema.String) })
const Recipient = Schema.Union([Email, Named])

export const SendPayload = Schema.Struct({
  to: Schema.Union([Recipient, Schema.NonEmptyArray(Recipient)]),
  subject: Schema.optionalKey(Schema.String),
  /** HTML body, with {{ placeholders }}. */
  body: Schema.optionalKey(Schema.String),
  subscribed: Schema.optionalKey(Schema.Boolean),
  /** Sender name, when `from` is a bare address. */
  name: Schema.optionalKey(Schema.String),
  from: Schema.optionalKey(Schema.Union([Email, Named])),
  reply: Schema.optionalKey(Email),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  template: Schema.optionalKey(Schema.String),
  /** Track opens and clicks on this send. Transactional mail is untracked unless asked. */
  track: Schema.optionalKey(
    Schema.Struct({ opens: Schema.optionalKey(Schema.Boolean), clicks: Schema.optionalKey(Schema.Boolean) }),
  ),
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        filename: Schema.NonEmptyString,
        /** Base64. */
        content: Schema.String,
        contentType: Schema.NonEmptyString,
      }),
    ),
  ),
})
export type SendPayload = typeof SendPayload.Type

export const SendResponse = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({
    emails: Schema.Array(
      Schema.Struct({
        contact: Schema.Struct({ id: Schema.String, email: Schema.String }),
        email: Schema.String,
        /** Mailyard addition: sent, deferred (queued for retry), failed or rejected. */
        status: Schema.String,
      }),
    ),
    timestamp: Schema.String,
  }),
})

export const TrackPayload = Schema.Struct({
  event: Schema.NonEmptyString,
  email: Email,
  subscribed: Schema.optionalKey(Schema.Boolean),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

export const TrackResponse = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({ contact: Schema.String, event: Schema.String, timestamp: Schema.String }),
})

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { field: Schema.String, message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class Unprocessable extends Schema.TaggedError<Unprocessable>()(
  "Unprocessable",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

const IdempotencyHeader = {
  "idempotency-key": Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
}

export class ActionsApi extends HttpApiGroup.make("actions")
  .add(
    HttpApiEndpoint.post("send", "/v1/send", {
      headers: IdempotencyHeader,
      payload: SendPayload,
      success: SendResponse,
      error: [InvalidRequest, NotFound, IdempotencyConflict, Unprocessable, Forbidden],
    }),
    HttpApiEndpoint.post("track", "/v1/track", {
      headers: IdempotencyHeader,
      payload: TrackPayload,
      success: TrackResponse,
      error: [InvalidRequest, IdempotencyConflict, Forbidden],
    }),
  )
  .middleware(ApiKeyAuth)
  .annotateMerge(
    OpenApi.annotations({ title: "Actions", description: "Send and track, compatible with Plunk." }),
  ) {}

// ---------------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------------

const Scope = Schema.Literals(["send", "track", "read", "admin"])

export const ApiKeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["secret", "public"]),
  prefix: Schema.String,
  scopes: Schema.Array(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.Number),
  revokedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
})

export class ApiKeysApi extends HttpApiGroup.make("apiKeys")
  .add(
    HttpApiEndpoint.get("list", "/v1/api-keys", {
      success: Schema.Struct({ keys: Schema.Array(ApiKeySummary) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/api-keys", {
      payload: Schema.Struct({
        name: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
        kind: Schema.Literals(["secret", "public"]),
        scopes: Schema.optionalKey(Schema.Array(Scope)),
      }),
      /** `key` is returned once, here, and never again. */
      success: Schema.Struct({ key: Schema.String, apiKey: ApiKeySummary }),
      error: Forbidden,
    }),
    HttpApiEndpoint.delete("revoke", "/v1/api-keys/:id", {
      params: { id: Schema.String },
      success: ApiKeySummary,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Message log
// ---------------------------------------------------------------------------------------------

export const MessageStatus = Schema.Literals([
  "queued",
  "sent",
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
])

export const MessageSummary = Schema.Struct({
  id: Schema.String,
  stream: Schema.String,
  recipient: Schema.String,
  sender: Schema.String,
  subject: Schema.String,
  status: MessageStatus,
  bounceType: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  cfMessageId: Schema.NullOr(Schema.String),
  templateId: Schema.NullOr(Schema.String),
  apiKeyId: Schema.NullOr(Schema.String),
  campaignId: Schema.NullOr(Schema.String),
  tracked: Schema.Boolean,
  firstOpenedAt: Schema.NullOr(Schema.Number),
  firstClickedAt: Schema.NullOr(Schema.Number),
  opens: Schema.Number,
  clicks: Schema.Number,
  /** Opens and clicks that looked like machines: privacy proxies, link scanners. */
  machineOpens: Schema.Number,
  machineClicks: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
})

export const MessageDetail = Schema.Struct({
  ...MessageSummary.fields,
  smtpResponse: Schema.NullOr(Schema.String),
  rendered: Schema.NullOr(
    Schema.Struct({
      from: Schema.String,
      to: Schema.Array(Schema.String),
      subject: Schema.String,
      html: Schema.NullOr(Schema.String),
      text: Schema.NullOr(Schema.String),
      attachments: Schema.Array(
        Schema.Struct({ filename: Schema.String, type: Schema.String, size: Schema.Number }),
      ),
    }),
  ),
})

export class MessagesApi extends HttpApiGroup.make("messages")
  .add(
    HttpApiEndpoint.get("list", "/v1/messages", {
      query: {
        status: Schema.optionalKey(MessageStatus),
        recipient: Schema.optionalKey(Schema.String),
        cursor: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
        ),
      },
      success: Schema.Struct({
        messages: Schema.Array(MessageSummary),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/messages/:id", {
      params: { id: Schema.String },
      success: MessageDetail,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Templates and brand
// ---------------------------------------------------------------------------------------------

const TemplateKind = Schema.Literals(["html", "blocks"])
const Variables = Schema.Struct({ used: Schema.Array(Schema.String), required: Schema.Array(Schema.String) })

export const TemplateSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: TemplateKind,
  publishedVersion: Schema.NullOr(Schema.Number),
  latestVersion: Schema.Number,
  hasUnpublishedChanges: Schema.Boolean,
  archived: Schema.Boolean,
  updatedAt: Schema.Number,
  createdAt: Schema.Number,
})

export const TemplateDetail = Schema.Struct({
  ...TemplateSummary.fields,
  latest: Schema.NullOr(
    Schema.Struct({
      version: Schema.Number,
      subject: Schema.String,
      source: Schema.String,
      text: Schema.NullOr(Schema.String),
      publishedAt: Schema.NullOr(Schema.Number),
      variables: Variables,
    }),
  ),
  versions: Schema.Array(
    Schema.Struct({
      version: Schema.Number,
      subject: Schema.String,
      publishedAt: Schema.NullOr(Schema.Number),
      createdBy: Schema.NullOr(Schema.String),
      createdAt: Schema.Number,
    }),
  ),
})

export const RenderResult = Schema.Struct({
  subject: Schema.String,
  html: Schema.String,
  text: Schema.String,
  size: Schema.Number,
  /** Email Service's 5 MiB limit, before attachments. */
  withinLimit: Schema.Boolean,
  variables: Schema.Struct({ ...Variables.fields, missing: Schema.Array(Schema.String) }),
})

const TemplateBody = {
  subject: Schema.String.check(Schema.isMaxLength(998)),
  /** HTML for `html` templates; the blocks document as JSON text for `blocks` templates. */
  source: Schema.String,
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
}

const RenderData = Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))

export class TemplatesApi extends HttpApiGroup.make("templates")
  .add(
    HttpApiEndpoint.get("list", "/v1/templates", {
      query: { archived: Schema.optionalKey(Schema.Literals(["true", "false"])) },
      success: Schema.Struct({ templates: Schema.Array(TemplateSummary) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/templates", {
      payload: Schema.Struct({
        name: Schema.NonEmptyString.check(Schema.isMaxLength(120)),
        kind: TemplateKind,
        ...TemplateBody,
        publish: Schema.optionalKey(Schema.Boolean),
      }),
      success: TemplateDetail,
      error: [Forbidden, InvalidRequest, NotFound],
    }),
    HttpApiEndpoint.get("get", "/v1/templates/:id", {
      params: { id: Schema.String },
      success: TemplateDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.put("saveDraft", "/v1/templates/:id/draft", {
      params: { id: Schema.String },
      payload: Schema.Struct(TemplateBody),
      success: TemplateDetail,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("publish", "/v1/templates/:id/publish", {
      params: { id: Schema.String },
      success: TemplateDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("rollback", "/v1/templates/:id/rollback", {
      params: { id: Schema.String },
      payload: Schema.Struct({ version: Schema.Int.check(Schema.isGreaterThan(0)) }),
      success: TemplateDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.delete("archive", "/v1/templates/:id", {
      params: { id: Schema.String },
      success: TemplateDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("render", "/v1/templates/:id/render", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        data: RenderData,
        /** `published` (default), `latest` (the draft), or a version number. */
        version: Schema.optionalKey(Schema.Union([Schema.Literals(["published", "latest"]), Schema.Int])),
      }),
      success: RenderResult,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("preview", "/v1/templates/preview", {
      payload: Schema.Struct({ kind: TemplateKind, ...TemplateBody, data: RenderData }),
      success: RenderResult,
      error: [Forbidden, InvalidRequest],
    }),
  )
  .middleware(ApiKeyAuth) {}

export const BrandSettingsSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  siteUrl: Schema.String,
  tagline: Schema.String,
  logoUrl: Schema.optionalKey(Schema.String),
  fontsHref: Schema.optionalKey(Schema.String),
  colors: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  fonts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})

export class SettingsApi extends HttpApiGroup.make("settings")
  .add(
    HttpApiEndpoint.get("getBrand", "/v1/settings/brand", { success: BrandSettingsSchema, error: Forbidden }),
    HttpApiEndpoint.put("putBrand", "/v1/settings/brand", {
      payload: Schema.Unknown,
      success: BrandSettingsSchema,
      error: [Forbidden, InvalidRequest],
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Webhooks (Standard Webhooks signatures)
// ---------------------------------------------------------------------------------------------

export const WebhookEndpoint = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  events: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  lastSuccessAt: Schema.NullOr(Schema.Number),
  lastFailureAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const DeliveryStatus = Schema.Literals(["pending", "succeeded", "retrying", "dead"])

export const WebhookDelivery = Schema.Struct({
  id: Schema.String,
  eventId: Schema.String,
  eventType: Schema.String,
  status: DeliveryStatus,
  attempts: Schema.Number,
  lastStatusCode: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String),
  lastDurationMs: Schema.NullOr(Schema.Number),
  lastAttemptAt: Schema.NullOr(Schema.Number),
  nextAttemptAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  payload: Schema.Unknown,
})

const WithSecret = Schema.Struct({
  endpoint: WebhookEndpoint,
  /** `whsec_…`, shown here once. Verify signatures with any Standard Webhooks library. */
  secret: Schema.String,
})

export class WebhooksApi extends HttpApiGroup.make("webhooks")
  .add(
    HttpApiEndpoint.get("list", "/v1/webhooks", {
      success: Schema.Struct({
        webhooks: Schema.Array(WebhookEndpoint),
        events: Schema.Array(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/webhooks", {
      payload: Schema.Struct({
        url: Schema.String,
        description: Schema.optionalKey(Schema.String),
        events: Schema.NonEmptyArray(Schema.String),
      }),
      success: WithSecret,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/webhooks/:id", {
      params: { id: Schema.String },
      success: WebhookEndpoint,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/webhooks/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        url: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        events: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
        enabled: Schema.optionalKey(Schema.Boolean),
      }),
      success: WebhookEndpoint,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/webhooks/:id", {
      params: { id: Schema.String },
      success: WebhookEndpoint,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("rotateSecret", "/v1/webhooks/:id/rotate-secret", {
      params: { id: Schema.String },
      success: WithSecret,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("deliveries", "/v1/webhooks/:id/deliveries", {
      params: { id: Schema.String },
      query: {
        status: Schema.optionalKey(DeliveryStatus),
        cursor: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
        ),
      },
      success: Schema.Struct({
        deliveries: Schema.Array(WebhookDelivery),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("replay", "/v1/webhooks/:id/deliveries/:deliveryId/replay", {
      params: { id: Schema.String, deliveryId: Schema.String },
      success: Schema.Struct({ id: Schema.String, status: DeliveryStatus }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("test", "/v1/webhooks/:id/test", {
      params: { id: Schema.String },
      success: Schema.Struct({ deliveryId: Schema.String, eventId: Schema.String }),
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Insights: what the Overview screen shows (docs/email-ui.html#overview)
// ---------------------------------------------------------------------------------------------

const Range = Schema.Literals(["24h", "7d", "30d"])
const Num = Schema.Number
const NullableNum = Schema.NullOr(Schema.Number)

export const Totals = Schema.Struct({
  sent: Num,
  delivered: Num,
  deferred: Num,
  bouncedHard: Num,
  bouncedSoft: Num,
  complained: Num,
  rejected: Num,
  failed: Num,
})

export const Rates = Schema.Struct({
  /** True under the minimum volume; the rates are then null rather than misleading. */
  insufficientData: Schema.Boolean,
  minimumSends: Num,
  bounceRate: NullableNum,
  complaintRate: NullableNum,
  rejectionRate: NullableNum,
  deliveryRate: NullableNum,
})

const ThresholdSchema = Schema.Struct({ warning_at: Num, at_risk_at: Num, minimum_denominator: Num })
const Level = Schema.Literals(["ok", "warning", "at-risk", "insufficient-data"])

export class InsightsApi extends HttpApiGroup.make("insights")
  .add(
    HttpApiEndpoint.get("health", "/v1/health", {
      success: Schema.Struct({
        status: Schema.Literals(["ok", "warn", "fail"]),
        checks: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            status: Schema.Literals(["ok", "warn", "fail", "unknown"]),
            detail: Schema.String,
          }),
        ),
        checkedAt: Schema.String,
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("usage", "/v1/usage", {
      success: Schema.Struct({
        today: Schema.Struct({
          sent: Num,
          quota: NullableNum,
          remaining: NullableNum,
          overQuota: Schema.NullOr(Schema.Boolean),
          resetsAt: Schema.NullOr(Schema.String),
          source: Schema.Literals(["cloudflare", "cloudflare-unreachable", "not-connected"]),
        }),
        month: Schema.Struct({
          from: Schema.String,
          billed: Num,
          included: Num,
          overage: Num,
          costUsd: Num,
          projectedBilled: Num,
          projectedCostUsd: Num,
        }),
        pricing: Schema.Struct({ includedPerMonth: Num, usdPerThousand: Num, measuredAt: Schema.String }),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("forecast", "/v1/usage/forecast", {
      query: {
        recipients: Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 10_000_000 })),
      },
      success: Schema.Union([
        Schema.Struct({ recipients: Num, possible: Schema.Literal(false), reason: Schema.String }),
        Schema.Struct({
          recipients: Num,
          possible: Schema.Literal(true),
          quota: Num,
          sendableToday: Num,
          additionalDays: Num,
          finishesBy: Schema.NullOr(Schema.String),
          cost: Schema.Struct({ billedAfter: Num, extraUsd: Num }),
        }),
      ]),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("delivery", "/v1/stats/delivery", {
      query: { range: Schema.optionalKey(Range) },
      success: Schema.Struct({ range: Range, from: Schema.String, totals: Totals, rates: Rates }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("volume", "/v1/stats/volume", {
      query: { range: Schema.optionalKey(Range) },
      success: Schema.Struct({
        range: Range,
        days: Schema.Array(
          Schema.Struct({ day: Schema.String, byStream: Schema.Record(Schema.String, Num) }),
        ),
        streams: Schema.Array(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("providers", "/v1/stats/providers", {
      query: { range: Schema.optionalKey(Range) },
      success: Schema.Struct({
        range: Range,
        providers: Schema.Array(
          Schema.Struct({
            provider: Schema.String,
            delivered: Num,
            deferred: Num,
            bounced: Num,
            complained: Num,
            total: Num,
          }),
        ),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("reputation", "/v1/reputation", {
      success: Schema.Struct({
        status: Schema.NullOr(Schema.String),
        statusSince: Schema.NullOr(Schema.String),
        graceStartedAt: Schema.NullOr(Schema.String),
        evaluatedAt: Schema.NullOr(Schema.String),
        source: Schema.Literals(["cloudflare", "not-connected"]),
        policySource: Schema.Literals(["account", "measured-2026-10-16"]),
        policy: Schema.Struct({
          customer_bounce: ThresholdSchema,
          complaint: ThresholdSchema,
          spam_rejection: ThresholdSchema,
          suspension_after_hours: Num,
        }),
        window: Schema.Literal("30d"),
        totals: Totals,
        rates: Rates,
        levels: Schema.Struct({ bounce: Level, complaint: Level, spamRejection: Level }),
      }),
      error: Forbidden,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Inbound ledger: every message Email Routing handed us, and whether it reached its mailboxes
// ---------------------------------------------------------------------------------------------

const InboundStatus = Schema.Literals(["received", "filed", "rejected", "held", "failed", "consumed"])

export const InboundMessage = Schema.Struct({
  id: Schema.String,
  status: InboundStatus,
  envelopeFrom: Schema.String,
  envelopeTo: Schema.String,
  messageId: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
  fromAddress: Schema.NullOr(Schema.String),
  size: Schema.Number,
  sha256: Schema.String,
  via: Schema.NullOr(Schema.Literals(["mailbox", "alias", "group", "catch_all"])),
  tag: Schema.NullOr(Schema.String),
  mailboxIds: Schema.Array(Schema.String),
  deliveredTo: Schema.Array(Schema.String),
  attempts: Schema.Number,
  error: Schema.NullOr(Schema.String),
  receivedAt: Schema.Number,
  filedAt: Schema.NullOr(Schema.Number),
})

export class InboundApi extends HttpApiGroup.make("inbound")
  .add(
    HttpApiEndpoint.get("list", "/v1/inbound", {
      query: {
        status: Schema.optionalKey(InboundStatus),
        cursor: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
        ),
      },
      success: Schema.Struct({
        messages: Schema.Array(InboundMessage),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/inbound/:id", {
      params: { id: Schema.String },
      success: InboundMessage,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("reprocess", "/v1/inbound/:id/reprocess", {
      params: { id: Schema.String },
      success: InboundMessage,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Domains, mailboxes and identities (docs/email-ui.html: Domain detail, Mailboxes and addresses)
// ---------------------------------------------------------------------------------------------

const CheckStatus = Schema.Literals(["pass", "warn", "fail", "error"])
const CatchAll = Schema.Literals(["bounce", "keep"])

export const RecordCheckSchema = Schema.Struct({
  id: Schema.Literals(["mx", "spf", "dkim", "dmarc", "bounce-mx", "bounce-spf", "bounce-dkim"]),
  purpose: Schema.Literals(["receiving", "sending"]),
  name: Schema.String,
  type: Schema.Literals(["MX", "TXT", "CNAME"]),
  expected: Schema.String,
  actual: Schema.Array(Schema.String),
  status: CheckStatus,
  detail: Schema.String,
})

export const DomainSummarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  zoneId: Schema.NullOr(Schema.String),
  receiving: Schema.Boolean,
  sending: Schema.Boolean,
  catchAll: CatchAll,
  mailboxCount: Schema.Number,
  lastCheckedAt: Schema.NullOr(Schema.Number),
  checkStatus: Schema.NullOr(CheckStatus),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const MailboxKindSchema = Schema.Literals(["user", "shared", "group", "alias", "catch_all"])

export const DomainDetailSchema = Schema.Struct({
  ...DomainSummarySchema.fields,
  checks: Schema.Array(RecordCheckSchema),
  expectedRecords: Schema.Array(
    Schema.Struct({
      purpose: Schema.String,
      type: Schema.Literals(["MX", "TXT", "CNAME"]),
      name: Schema.String,
      value: Schema.String,
    }),
  ),
  mailboxes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      address: Schema.String,
      kind: MailboxKindSchema,
      displayName: Schema.NullOr(Schema.String),
    }),
  ),
})

const SignatureSchema = Schema.Struct({ text: Schema.String, html: Schema.NullOr(Schema.String) })
const AutoReplySchema = Schema.Struct({
  enabled: Schema.Boolean,
  subject: Schema.String.check(Schema.isMaxLength(998)),
  body: Schema.String.check(Schema.isMaxLength(20_000)),
  startsAt: Schema.NullOr(Schema.Number),
  endsAt: Schema.NullOr(Schema.Number),
})
const ForwardingSchema = Schema.Struct({
  enabled: Schema.Boolean,
  to: Schema.Array(Schema.String),
  keepCopy: Schema.Boolean,
})
const MemberRoleSchema = Schema.Literals(["owner", "member", "viewer"])

export const MailboxSummarySchema = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  domainId: Schema.String,
  kind: MailboxKindSchema,
  displayName: Schema.NullOr(Schema.String),
  holdsMail: Schema.Boolean,
  targetIds: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

export const MailboxDetailSchema = Schema.Struct({
  ...MailboxSummarySchema.fields,
  targets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      address: Schema.NullOr(Schema.String),
      kind: Schema.NullOr(MailboxKindSchema),
    }),
  ),
  signature: Schema.NullOr(SignatureSchema),
  autoReply: Schema.NullOr(AutoReplySchema),
  forwarding: Schema.NullOr(ForwardingSchema),
  members: Schema.Array(
    Schema.Struct({
      apiKeyId: Schema.String,
      name: Schema.String,
      role: MemberRoleSchema,
      revoked: Schema.Boolean,
    }),
  ),
  /** Messages held; null for aliases and groups, which hold none. */
  messageCount: Schema.NullOr(Schema.Number),
  lastExport: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      status: Schema.Literals(["pending", "running", "complete", "failed"]),
      format: Schema.Literals(["mbox", "eml-zip", "both"]),
      messageCount: Schema.Number,
      size: Schema.Number,
      createdAt: Schema.Number,
      completedAt: Schema.NullOr(Schema.Number),
    }),
  ),
})

export class DomainsApi extends HttpApiGroup.make("domains")
  .add(
    HttpApiEndpoint.get("list", "/v1/domains", {
      success: Schema.Struct({ domains: Schema.Array(DomainSummarySchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/domains", {
      payload: Schema.Struct({
        name: Schema.String,
        receiving: Schema.optionalKey(Schema.Boolean),
        sending: Schema.optionalKey(Schema.Boolean),
        catchAll: Schema.optionalKey(CatchAll),
        zoneId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: DomainDetailSchema,
      error: [Forbidden, NotFound, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.get("get", "/v1/domains/:id", {
      params: { id: Schema.String },
      success: DomainDetailSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/domains/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        receiving: Schema.optionalKey(Schema.Boolean),
        sending: Schema.optionalKey(Schema.Boolean),
        catchAll: Schema.optionalKey(CatchAll),
        zoneId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: DomainDetailSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/domains/:id", {
      params: { id: Schema.String },
      success: DomainSummarySchema,
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("recheck", "/v1/domains/:id/recheck", {
      params: { id: Schema.String },
      success: DomainDetailSchema,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

const MailboxSettings = {
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  signature: Schema.optionalKey(Schema.NullOr(SignatureSchema)),
  autoReply: Schema.optionalKey(Schema.NullOr(AutoReplySchema)),
  forwarding: Schema.optionalKey(Schema.NullOr(ForwardingSchema)),
}

export class MailboxesApi extends HttpApiGroup.make("mailboxes")
  .add(
    HttpApiEndpoint.get("list", "/v1/mailboxes", {
      query: { domainId: Schema.optionalKey(Schema.String), kind: Schema.optionalKey(MailboxKindSchema) },
      success: Schema.Struct({ mailboxes: Schema.Array(MailboxSummarySchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/mailboxes", {
      payload: Schema.Struct({
        address: Schema.String,
        kind: MailboxKindSchema,
        targets: Schema.optionalKey(Schema.Array(Schema.String)),
        ...MailboxSettings,
      }),
      success: MailboxDetailSchema,
      error: [Forbidden, NotFound, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.get("get", "/v1/mailboxes/:id", {
      params: { id: Schema.String },
      success: MailboxDetailSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/mailboxes/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        targets: Schema.optionalKey(Schema.Array(Schema.String)),
        ...MailboxSettings,
      }),
      success: MailboxDetailSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.put("setMembers", "/v1/mailboxes/:id/members", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        members: Schema.Array(Schema.Struct({ apiKeyId: Schema.String, role: MemberRoleSchema })),
      }),
      success: MailboxDetailSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/mailboxes/:id", {
      params: { id: Schema.String },
      success: MailboxSummarySchema,
      error: [Forbidden, NotFound, Conflict],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class IdentitiesApi extends HttpApiGroup.make("identities")
  .add(
    HttpApiEndpoint.get("list", "/v1/identities", {
      success: Schema.Struct({
        identities: Schema.Array(
          Schema.Struct({
            address: Schema.String,
            displayName: Schema.NullOr(Schema.String),
            mailboxId: Schema.String,
            kind: MailboxKindSchema,
            via: Schema.Literals(["admin", "member", "alias"]),
          }),
        ),
        /** Domains on which this key may send as any address (root and admin keys). */
        anyAddressOn: Schema.Array(Schema.String),
      }),
      error: Forbidden,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Mail: folders, threads, messages, labels, drafts and sending (docs/email-ui.html: Mail)
// ---------------------------------------------------------------------------------------------

const FolderSchema = Schema.Literals(["inbox", "archive", "sent", "spam", "trash", "snoozed"])
const PartySchema = Schema.Struct({ name: Schema.NullOr(Schema.String), address: Schema.String })
const AuthVerdictSchema = Schema.NullOr(Schema.String)

export const ThreadSchema = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  snippet: Schema.String,
  latestMessageId: Schema.String,
  messageCount: Schema.Number,
  unreadCount: Schema.Number,
  starred: Schema.Boolean,
  hasAttachments: Schema.Boolean,
  participants: Schema.Array(PartySchema),
  folders: Schema.Array(FolderSchema),
  labelIds: Schema.Array(Schema.String),
  firstAt: Schema.Number,
  lastAt: Schema.Number,
  sortAt: Schema.Number,
  snoozedUntil: Schema.NullOr(Schema.Number),
  assignee: Schema.NullOr(Schema.String),
})

const AttachmentSchema = Schema.Struct({
  id: Schema.String,
  filename: Schema.NullOr(Schema.String),
  mimeType: Schema.String,
  disposition: Schema.NullOr(Schema.String),
  contentId: Schema.NullOr(Schema.String),
  related: Schema.Boolean,
  size: Schema.Number,
  sha256: Schema.String,
})

export const MessageSchema = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  folder: FolderSchema,
  seen: Schema.Boolean,
  starred: Schema.Boolean,
  answered: Schema.Boolean,
  labelIds: Schema.Array(Schema.String),
  receivedAt: Schema.Number,
  envelopeFrom: Schema.String,
  envelopeTo: Schema.String,
  via: Schema.String,
  tag: Schema.NullOr(Schema.String),
  size: Schema.Number,
  messageId: Schema.NullOr(Schema.String),
  inReplyTo: Schema.NullOr(Schema.String),
  references: Schema.Array(Schema.String),
  subject: Schema.String,
  date: Schema.NullOr(Schema.Number),
  from: Schema.NullOr(PartySchema),
  replyTo: Schema.Array(PartySchema),
  to: Schema.Array(PartySchema),
  cc: Schema.Array(PartySchema),
  snippet: Schema.String,
  hasHtml: Schema.Boolean,
  automated: Schema.Boolean,
  listId: Schema.NullOr(Schema.String),
  listUnsubscribe: Schema.NullOr(Schema.String),
  auth: Schema.Struct({
    source: Schema.String,
    spf: AuthVerdictSchema,
    dmarc: AuthVerdictSchema,
    dkim: Schema.Array(
      Schema.Struct({
        result: Schema.String,
        domain: Schema.NullOr(Schema.String),
        selector: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  attachments: Schema.Array(AttachmentSchema),
  /** The spam check's score at delivery and its reasons; null for mail this mailbox sent. */
  spamScore: Schema.NullOr(Schema.Number),
  spamReasons: Schema.Array(Schema.Struct({ rule: Schema.String, points: Schema.Number })),
  rulesMatched: Schema.Array(Schema.String),
})

export const MessageDetailSchema = Schema.Struct({
  ...MessageSchema.fields,
  body: Schema.Struct({ text: Schema.String, html: Schema.NullOr(Schema.String) }),
  /** Signed links that work without a key for an hour: for <img> tags and download buttons. */
  rawUrl: Schema.String,
  attachmentUrls: Schema.Record(Schema.String, Schema.String),
})

const DraftAttachmentSchema = Schema.Struct({
  key: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
})
const ReplyModeSchema = Schema.Literals(["reply", "replyAll", "forward"])

export const DraftSchema = Schema.Struct({
  id: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  inReplyTo: Schema.NullOr(Schema.String),
  references: Schema.Array(Schema.String),
  from: Schema.NullOr(Schema.String),
  to: Schema.Array(PartySchema),
  cc: Schema.Array(PartySchema),
  bcc: Schema.Array(PartySchema),
  subject: Schema.String,
  bodyText: Schema.String,
  bodyHtml: Schema.NullOr(Schema.String),
  attachments: Schema.Array(DraftAttachmentSchema),
  status: Schema.Literals(["draft", "scheduled", "due"]),
  sendAt: Schema.NullOr(Schema.Number),
  replyMode: Schema.NullOr(ReplyModeSchema),
  sourceMessageId: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

export const LabelSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  threads: Schema.Number,
  unreadThreads: Schema.Number,
  createdAt: Schema.Number,
})

const FolderCountSchema = Schema.Struct({
  folder: Schema.Literals(["inbox", "archive", "sent", "spam", "trash", "snoozed", "drafts"]),
  threads: Schema.Number,
  unreadThreads: Schema.Number,
})

const PartyInput = Schema.Struct({
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  address: Schema.String,
})

const DraftFields = {
  from: Schema.optionalKey(Schema.NullOr(Schema.String)),
  to: Schema.optionalKey(Schema.Array(PartyInput)),
  cc: Schema.optionalKey(Schema.Array(PartyInput)),
  bcc: Schema.optionalKey(Schema.Array(PartyInput)),
  subject: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(998))),
  bodyText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000_000))),
  bodyHtml: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000_000)))),
  attachments: Schema.optionalKey(Schema.Array(DraftAttachmentSchema)),
}

export const BULK_ACTIONS = [
  "archive",
  "inbox",
  "trash",
  "delete",
  "spam",
  "notSpam",
  "read",
  "unread",
  "star",
  "unstar",
  "label",
  "unlabel",
  "move",
  "snooze",
  "unsnooze",
  "assign",
] as const

const MailboxParam = { id: Schema.String }
const Limit = Schema.optionalKey(
  Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
)
const MailErrors = [Forbidden, NotFound, InvalidRequest, Conflict] as const

export class MailApiGroup extends HttpApiGroup.make("mail")
  .add(
    HttpApiEndpoint.get("folders", "/v1/mailboxes/:id/folders", {
      params: MailboxParam,
      success: Schema.Struct({ folders: Schema.Array(FolderCountSchema), labels: Schema.Array(LabelSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("emptyFolder", "/v1/mailboxes/:id/folders/:folder/empty", {
      params: { id: Schema.String, folder: Schema.Literals(["trash", "spam"]) },
      success: Schema.Struct({ purged: Schema.Number }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("threads", "/v1/mailboxes/:id/threads", {
      params: MailboxParam,
      query: {
        folder: Schema.optionalKey(FolderSchema),
        labelId: Schema.optionalKey(Schema.String),
        unread: Schema.optionalKey(Schema.Literals(["true", "false"])),
        starred: Schema.optionalKey(Schema.Literals(["true", "false"])),
        assignee: Schema.optionalKey(Schema.String),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        threads: Schema.Array(ThreadSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("thread", "/v1/mailboxes/:id/threads/:threadId", {
      params: { id: Schema.String, threadId: Schema.String },
      success: Schema.Struct({
        thread: ThreadSchema,
        messages: Schema.Array(MessageSchema),
        drafts: Schema.Array(DraftSchema),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("bulk", "/v1/mailboxes/:id/threads/bulk", {
      params: MailboxParam,
      payload: Schema.Struct({
        threadIds: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
        action: Schema.Literals(BULK_ACTIONS),
        labelId: Schema.optionalKey(Schema.String),
        folder: Schema.optionalKey(FolderSchema),
        until: Schema.optionalKey(Schema.Number),
        assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: Schema.Struct({ updated: Schema.Number }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("search", "/v1/mailboxes/:id/search", {
      params: MailboxParam,
      query: { q: Schema.String, limit: Limit },
      success: Schema.Struct({
        hits: Schema.Array(
          Schema.Struct({
            messageId: Schema.String,
            threadId: Schema.String,
            folder: FolderSchema,
            from: Schema.NullOr(PartySchema),
            receivedAt: Schema.Number,
            subject: Schema.String,
            excerpt: Schema.String,
            rank: Schema.Number,
          }),
        ),
        threads: Schema.Array(ThreadSchema),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("message", "/v1/mailboxes/:id/messages/:messageId", {
      params: { id: Schema.String, messageId: Schema.String },
      success: MessageDetailSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.patch("updateMessage", "/v1/mailboxes/:id/messages/:messageId", {
      params: { id: Schema.String, messageId: Schema.String },
      payload: Schema.Struct({
        seen: Schema.optionalKey(Schema.Boolean),
        starred: Schema.optionalKey(Schema.Boolean),
        folder: Schema.optionalKey(FolderSchema),
        addLabels: Schema.optionalKey(Schema.Array(Schema.String)),
        removeLabels: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      success: MessageSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.get("labels", "/v1/mailboxes/:id/labels", {
      params: MailboxParam,
      success: Schema.Struct({ labels: Schema.Array(LabelSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("createLabel", "/v1/mailboxes/:id/labels", {
      params: MailboxParam,
      payload: Schema.Struct({
        name: Schema.String,
        color: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: LabelSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.patch("updateLabel", "/v1/mailboxes/:id/labels/:labelId", {
      params: { id: Schema.String, labelId: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        color: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: LabelSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("deleteLabel", "/v1/mailboxes/:id/labels/:labelId", {
      params: { id: Schema.String, labelId: Schema.String },
      success: Schema.Struct({ deleted: Schema.String }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("drafts", "/v1/mailboxes/:id/drafts", {
      params: MailboxParam,
      query: { status: Schema.optionalKey(Schema.Literals(["draft", "scheduled", "due"])), limit: Limit },
      success: Schema.Struct({ drafts: Schema.Array(DraftSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("createDraft", "/v1/mailboxes/:id/drafts", {
      params: MailboxParam,
      payload: Schema.Struct({
        /** Start from a message in this mailbox: a reply, a reply to all, or a forward. */
        replyTo: Schema.optionalKey(Schema.Struct({ messageId: Schema.String, mode: ReplyModeSchema })),
        threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        ...DraftFields,
      }),
      success: DraftSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.get("draft", "/v1/mailboxes/:id/drafts/:draftId", {
      params: { id: Schema.String, draftId: Schema.String },
      success: DraftSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.patch("updateDraft", "/v1/mailboxes/:id/drafts/:draftId", {
      params: { id: Schema.String, draftId: Schema.String },
      payload: Schema.Struct(DraftFields),
      success: DraftSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("deleteDraft", "/v1/mailboxes/:id/drafts/:draftId", {
      params: { id: Schema.String, draftId: Schema.String },
      success: Schema.Struct({ deleted: Schema.String }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("send", "/v1/mailboxes/:id/drafts/:draftId/send", {
      params: { id: Schema.String, draftId: Schema.String },
      payload: Schema.Struct({
        sendAt: Schema.optionalKey(Schema.Number),
        /** How long the send can be undone, when it goes now: 0 to 30 s, else the account's default. */
        undoSeconds: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
      }),
      success: Schema.Struct({
        draft: DraftSchema,
        sendAt: Schema.Number,
        undoUntil: Schema.NullOr(Schema.Number),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("cancelSend", "/v1/mailboxes/:id/drafts/:draftId/cancel", {
      params: { id: Schema.String, draftId: Schema.String },
      success: DraftSchema,
      error: MailErrors,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Inbox rules and sender lists (docs/email-ui.html: Rules)
// ---------------------------------------------------------------------------------------------

export const RuleSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  match: Schema.Literals(["all", "any"]),
  conditions: Schema.Array(RuleCondition),
  actions: Schema.Array(RuleAction),
  stop: Schema.Boolean,
  position: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const SenderSchema = Schema.Struct({
  value: Schema.String,
  list: Schema.Literals(["allow", "block"]),
  source: Schema.Literals(["user", "not_spam", "spam"]),
  createdAt: Schema.optionalKey(Schema.Number),
})

const RuleFields = {
  name: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  match: Schema.optionalKey(Schema.Literals(["all", "any"])),
  conditions: Schema.Array(RuleCondition),
  actions: Schema.Array(RuleAction),
  stop: Schema.optionalKey(Schema.Boolean),
}

export class RulesApi extends HttpApiGroup.make("rules")
  .add(
    HttpApiEndpoint.get("list", "/v1/mailboxes/:id/rules", {
      params: { id: Schema.String },
      success: Schema.Struct({ rules: Schema.Array(RuleSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("create", "/v1/mailboxes/:id/rules", {
      params: { id: Schema.String },
      payload: Schema.Struct(RuleFields),
      success: RuleSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.patch("update", "/v1/mailboxes/:id/rules/:ruleId", {
      params: { id: Schema.String, ruleId: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        enabled: Schema.optionalKey(Schema.Boolean),
        match: Schema.optionalKey(Schema.Literals(["all", "any"])),
        conditions: Schema.optionalKey(Schema.Array(RuleCondition)),
        actions: Schema.optionalKey(Schema.Array(RuleAction)),
        stop: Schema.optionalKey(Schema.Boolean),
      }),
      success: RuleSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("remove", "/v1/mailboxes/:id/rules/:ruleId", {
      params: { id: Schema.String, ruleId: Schema.String },
      success: Schema.Struct({ deleted: Schema.String }),
      error: MailErrors,
    }),
    HttpApiEndpoint.put("reorder", "/v1/mailboxes/:id/rules/order", {
      params: { id: Schema.String },
      payload: Schema.Struct({ ruleIds: Schema.Array(Schema.String) }),
      success: Schema.Struct({ rules: Schema.Array(RuleSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("test", "/v1/mailboxes/:id/rules/test", {
      params: { id: Schema.String },
      payload: Schema.Struct({ messageId: Schema.String }),
      success: Schema.Struct({
        matched: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
        outcome: Schema.Unknown,
        authScore: Schema.Struct({
          score: Schema.Number,
          reasons: Schema.Array(Schema.Struct({ rule: Schema.String, points: Schema.Number })),
        }),
        filedWith: Schema.Unknown,
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("senders", "/v1/mailboxes/:id/senders", {
      params: { id: Schema.String },
      query: { list: Schema.optionalKey(Schema.Literals(["allow", "block"])) },
      success: Schema.Struct({ senders: Schema.Array(SenderSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("addSender", "/v1/mailboxes/:id/senders", {
      params: { id: Schema.String },
      payload: Schema.Struct({ value: Schema.String, list: Schema.Literals(["allow", "block"]) }),
      success: SenderSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("removeSender", "/v1/mailboxes/:id/senders/:value", {
      params: { id: Schema.String, value: Schema.String },
      success: Schema.Struct({ removed: Schema.String }),
      error: MailErrors,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Imports and exports (docs/email-ui.html: Import mailbox, Export)
// ---------------------------------------------------------------------------------------------

const ImportFolderSchema = Schema.Struct({
  name: Schema.String,
  folder: Schema.String,
  label: Schema.NullOr(Schema.String),
  uidValidity: Schema.NullOr(Schema.Number),
  source: Schema.Number,
  imported: Schema.Number,
  duplicates: Schema.Number,
  failed: Schema.Number,
  skipped: Schema.optionalKey(Schema.Number),
  lastUid: Schema.Number,
  batches: Schema.Number,
  batchesDone: Schema.Number,
})

export const ImportSchema = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["imap", "mbox"]),
  mode: Schema.Literals(["full", "catchup"]),
  host: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  username: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "running", "complete", "failed", "cancelled"]),
  error: Schema.NullOr(Schema.String),
  folders: Schema.Array(ImportFolderSchema),
  totals: Schema.Struct({
    source: Schema.Number,
    imported: Schema.Number,
    duplicates: Schema.Number,
    failed: Schema.Number,
    skipped: Schema.Number,
  }),
  accountedFor: Schema.Boolean,
  credentialsHeld: Schema.Boolean,
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
})

export const ExportSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["pending", "running", "complete", "failed"]),
  format: Schema.Literals(["mbox", "eml-zip", "both"]),
  messageCount: Schema.Number,
  size: Schema.Number,
  zipSize: Schema.Number,
  error: Schema.NullOr(Schema.String),
  /** Signed links valid for a week; null until the export is complete. */
  downloads: Schema.Struct({ mbox: Schema.NullOr(Schema.String), zip: Schema.NullOr(Schema.String) }),
  createdAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
})

export class TransfersApi extends HttpApiGroup.make("transfers")
  .add(
    HttpApiEndpoint.post("createImport", "/v1/mailboxes/:id/imports", {
      params: { id: Schema.String },
      payload: Schema.Union([
        Schema.Struct({
          source: Schema.Literal("imap"),
          host: Schema.String,
          port: Schema.optionalKey(Schema.Number),
          username: Schema.String,
          password: Schema.String,
          folders: Schema.optionalKey(Schema.Array(Schema.String)),
          mode: Schema.optionalKey(Schema.Literals(["full", "catchup"])),
        }),
        Schema.Struct({
          source: Schema.Literal("mbox"),
          uploadKey: Schema.optionalKey(Schema.String),
          exportId: Schema.optionalKey(Schema.String),
        }),
      ]),
      success: ImportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.get("imports", "/v1/mailboxes/:id/imports", {
      params: { id: Schema.String },
      success: Schema.Struct({ imports: Schema.Array(ImportSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("import", "/v1/mailboxes/:id/imports/:importId", {
      params: { id: Schema.String, importId: Schema.String },
      success: ImportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.post("cancelImport", "/v1/mailboxes/:id/imports/:importId/cancel", {
      params: { id: Schema.String, importId: Schema.String },
      success: ImportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.post("createExport", "/v1/mailboxes/:id/exports", {
      params: { id: Schema.String },
      success: ExportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.get("exports", "/v1/mailboxes/:id/exports", {
      params: { id: Schema.String },
      success: Schema.Struct({ exports: Schema.Array(ExportSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("export", "/v1/mailboxes/:id/exports/:exportId", {
      params: { id: Schema.String, exportId: Schema.String },
      success: ExportSchema,
      error: MailErrors,
    }),
  )
  .middleware(ApiKeyAuth) {}

/** Mailyard's HTTP API. The UI contract (docs/plans/email-ui.html#contract) grows here, group by group. */
// Audience: contacts, topics and signup forms (docs/email-ui.html: Contacts list, Contact detail)

const ContactStatusSchema = Schema.Literals([
  "subscribed",
  "unconfirmed",
  "unsubscribed",
  "bounced",
  "complained",
  "suppressed",
])
const SubscriptionStateSchema = Schema.Literals(["subscribed", "unconfirmed", "unsubscribed"])
const EngagementSchema = Schema.Literals(["active", "cooling", "dormant"])
const Fields = Schema.Record(Schema.String, Schema.Unknown)

export const ContactSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  status: ContactStatusSchema,
  fields: Fields,
  topics: Schema.Array(
    Schema.Struct({ topicId: Schema.String, name: Schema.String, state: SubscriptionStateSchema }),
  ),
  engagement: EngagementSchema,
  lastActivityAt: Schema.NullOr(Schema.Number),
  lastEventAt: Schema.NullOr(Schema.Number),
  lastOpenedAt: Schema.NullOr(Schema.Number),
  lastClickedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
})

const TimelineItemSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("event"),
    id: Schema.String,
    at: Schema.Number,
    name: Schema.String,
    data: Schema.NullOr(Fields),
  }),
  Schema.Struct({
    kind: Schema.Literal("message"),
    id: Schema.String,
    at: Schema.Number,
    stream: Schema.String,
    subject: Schema.String,
    status: Schema.String,
    bounceType: Schema.NullOr(Schema.String),
    campaignId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("subscription"),
    id: Schema.String,
    at: Schema.Number,
    topicId: Schema.String,
    topic: Schema.String,
    from: Schema.NullOr(SubscriptionStateSchema),
    to: SubscriptionStateSchema,
    source: Schema.String,
  }),
])

export const TopicSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  doubleOptIn: Schema.Boolean,
  sender: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  subscribers: Schema.Number,
  createdAt: Schema.Number,
})

export const FormSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  topicIds: Schema.Array(Schema.String),
  fields: Schema.Array(Schema.String),
  redirectUrl: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  turnstileSiteKey: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  createdAt: Schema.Number,
})

export class ContactsApi extends HttpApiGroup.make("contacts")
  .add(
    HttpApiEndpoint.get("list", "/v1/contacts", {
      query: {
        q: Schema.optionalKey(Schema.String),
        status: Schema.optionalKey(ContactStatusSchema),
        topicId: Schema.optionalKey(Schema.String),
        engagement: Schema.optionalKey(EngagementSchema),
        /** A saved segment's rules. */
        segmentId: Schema.optionalKey(Schema.String),
        /** `key:op:value`, as a segment field rule; repeat it to AND several. */
        field: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
        /** `[!]name[:days]`: did (or with `!` didn't) the event, within the last `days`. */
        event: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
        sort: Schema.optionalKey(
          Schema.Literals([
            "createdAt",
            "-createdAt",
            "email",
            "-email",
            "lastActivityAt",
            "-lastActivityAt",
          ]),
        ),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        contacts: Schema.Array(ContactSchema),
        /** Every contact in the account, and those matching the filters. */
        total: Schema.Number,
        count: Schema.Number,
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, InvalidRequest, NotFound],
    }),
    HttpApiEndpoint.post("create", "/v1/contacts", {
      payload: Schema.Struct({
        email: Schema.String,
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        fields: Schema.optionalKey(Fields),
        status: Schema.optionalKey(Schema.Literals(["subscribed", "unsubscribed"])),
      }),
      success: ContactSchema,
      error: [Forbidden, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.get("get", "/v1/contacts/:id", {
      params: { id: Schema.String },
      success: ContactSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/contacts/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        /** Merged into the contact's fields; a null value removes that field. */
        fields: Schema.optionalKey(Fields),
        status: Schema.optionalKey(Schema.Literals(["subscribed", "unsubscribed"])),
      }),
      success: ContactSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/contacts/:id", {
      params: { id: Schema.String },
      success: Schema.Struct({ id: Schema.String, deleted: Schema.Boolean }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("timeline", "/v1/contacts/:id/timeline", {
      params: { id: Schema.String },
      query: { cursor: Schema.optionalKey(Schema.String), limit: Limit },
      success: Schema.Struct({
        items: Schema.Array(TimelineItemSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.put("setTopic", "/v1/contacts/:id/topics/:topicId", {
      params: { id: Schema.String, topicId: Schema.String },
      payload: Schema.Struct({
        state: Schema.Literals(["subscribed", "unsubscribed"]),
        /** Consent was collected elsewhere: skip the topic's double opt-in mail. */
        confirmed: Schema.optionalKey(Schema.Boolean),
      }),
      success: Schema.Struct({
        contact: ContactSchema,
        state: SubscriptionStateSchema,
        confirmationSent: Schema.Boolean,
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("bulk", "/v1/contacts/bulk", {
      payload: Schema.Struct({
        ids: Schema.Array(Schema.String),
        action: Schema.Union([
          Schema.Struct({
            action: Schema.Literal("addTopic"),
            topicId: Schema.String,
            confirmed: Schema.optionalKey(Schema.Boolean),
          }),
          Schema.Struct({ action: Schema.Literal("removeTopic"), topicId: Schema.String }),
          Schema.Struct({
            action: Schema.Literal("setStatus"),
            status: Schema.Literals(["subscribed", "unsubscribed"]),
          }),
          Schema.Struct({ action: Schema.Literal("delete") }),
        ]),
      }),
      success: Schema.Struct({
        updated: Schema.Number,
        skipped: Schema.Number,
        errors: Schema.Array(Schema.Struct({ id: Schema.String, message: Schema.String })),
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("export", "/v1/contacts/:id/export", {
      params: { id: Schema.String },
      success: Schema.Struct({
        exportedAt: Schema.String,
        contact: Fields,
        subscriptions: Schema.Array(Fields),
        subscriptionChanges: Schema.Array(Fields),
        events: Schema.Array(Fields),
        messages: Schema.Array(Fields),
        suppression: Schema.NullOr(Fields),
      }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("preferencesLink", "/v1/contacts/:id/preferences-link", {
      params: { id: Schema.String },
      /** Ties the link (and its one-click) to one topic; without it, the link manages every topic. */
      query: { topicId: Schema.optionalKey(Schema.String) },
      success: Schema.Struct({ url: Schema.String }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("erase", "/v1/contacts/:id/erase", {
      params: { id: Schema.String },
      success: Schema.Struct({ id: Schema.String, erased: Schema.Boolean, messagesScrubbed: Schema.Number }),
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class TopicsApi extends HttpApiGroup.make("topics")
  .add(
    HttpApiEndpoint.get("list", "/v1/topics", {
      success: Schema.Struct({ topics: Schema.Array(TopicSchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/topics", {
      payload: Schema.Struct({
        name: Schema.String,
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        doubleOptIn: Schema.optionalKey(Schema.Boolean),
        sender: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: TopicSchema,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/topics/:id", {
      params: { id: Schema.String },
      success: TopicSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/topics/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        doubleOptIn: Schema.optionalKey(Schema.Boolean),
        sender: Schema.optionalKey(Schema.NullOr(Schema.String)),
        archived: Schema.optionalKey(Schema.Boolean),
      }),
      success: TopicSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class FormsApi extends HttpApiGroup.make("forms")
  .add(
    HttpApiEndpoint.get("list", "/v1/forms", {
      success: Schema.Struct({ forms: Schema.Array(FormSchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/forms", {
      payload: Schema.Struct({
        name: Schema.String,
        topicIds: Schema.Array(Schema.String),
        fields: Schema.optionalKey(Schema.Array(Schema.String)),
        redirectUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        turnstileSiteKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: FormSchema,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/forms/:id", {
      params: { id: Schema.String },
      success: FormSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/forms/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        topicIds: Schema.optionalKey(Schema.Array(Schema.String)),
        fields: Schema.optionalKey(Schema.Array(Schema.String)),
        redirectUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        turnstileSiteKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
        archived: Schema.optionalKey(Schema.Boolean),
      }),
      success: FormSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    /** The hosted page's address and a snippet to paste into another site, which posts to submit. */
    HttpApiEndpoint.get("embed", "/v1/forms/:id/embed", {
      params: { id: Schema.String },
      success: Schema.Struct({ pageUrl: Schema.String, html: Schema.String }),
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// Segments: saved audiences as a rule tree (docs/email-ui.html: Segment builder)

export const SegmentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The rule tree (src/segments/rules.ts); its shape is validated on save. */
  filter: Schema.Unknown,
  count: Schema.NullOr(Schema.Number),
  countedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
})

export class SegmentsApi extends HttpApiGroup.make("segments")
  .add(
    HttpApiEndpoint.get("list", "/v1/segments", {
      success: Schema.Struct({ segments: Schema.Array(SegmentSchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("preview", "/v1/segments/preview", {
      payload: Schema.Struct({ filter: Schema.Unknown }),
      success: Schema.Struct({
        count: Schema.Number,
        sample: Schema.Array(ContactSchema),
        /** The condition it runs over `contacts`, with `?` for each of `params`. */
        sql: Schema.String,
        params: Schema.Array(Schema.Unknown),
      }),
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.post("create", "/v1/segments", {
      payload: Schema.Struct({ name: Schema.String, filter: Schema.Unknown }),
      success: SegmentSchema,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/segments/:id", {
      params: { id: Schema.String },
      success: SegmentSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/segments/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        filter: Schema.optionalKey(Schema.Unknown),
      }),
      success: SegmentSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/segments/:id", {
      params: { id: Schema.String },
      success: Schema.Struct({ id: Schema.String, deleted: Schema.Boolean }),
      error: [Forbidden, NotFound, Conflict],
    }),
  )
  .middleware(ApiKeyAuth) {}

// Sending pace and alerts (docs/email-ui.html: Usage, Overview "needs you")

const ProviderCounts = Schema.Struct({
  gmail: Schema.Number,
  microsoft: Schema.Number,
  yahoo: Schema.Number,
  apple: Schema.Number,
  other: Schema.Number,
})
const Rate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const GovernorConfigSchema = Schema.Struct({
  dailyQuota: Schema.NullOr(Count),
  fallbackQuota: Count,
  transactionalReserve: Rate,
  providerPerMinute: ProviderCounts,
  warmup: Schema.Struct({
    enabled: Schema.Boolean,
    start: Count,
    factor: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    maxBounceRate: Rate,
    maxComplaintRate: Rate,
  }),
  establishedDomains: Schema.Array(Schema.String),
  pause: Schema.Struct({ bounceRate: Rate, minOutcomes: Count, complaintRate: Rate, minComplaints: Count }),
})

const GovernorPatchSchema = Schema.Struct({
  dailyQuota: Schema.optionalKey(Schema.NullOr(Count)),
  fallbackQuota: Schema.optionalKey(Count),
  transactionalReserve: Schema.optionalKey(Rate),
  providerPerMinute: Schema.optionalKey(
    Schema.Struct({
      gmail: Schema.optionalKey(Count),
      microsoft: Schema.optionalKey(Count),
      yahoo: Schema.optionalKey(Count),
      apple: Schema.optionalKey(Count),
      other: Schema.optionalKey(Count),
    }),
  ),
  warmup: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      start: Schema.optionalKey(Count),
      factor: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
      maxBounceRate: Schema.optionalKey(Rate),
      maxComplaintRate: Schema.optionalKey(Rate),
    }),
  ),
  establishedDomains: Schema.optionalKey(Schema.Array(Schema.String)),
  pause: Schema.optionalKey(
    Schema.Struct({
      bounceRate: Schema.optionalKey(Rate),
      minOutcomes: Schema.optionalKey(Count),
      complaintRate: Schema.optionalKey(Rate),
      minComplaints: Schema.optionalKey(Count),
    }),
  ),
})

export const GovernorOverviewSchema = Schema.Struct({
  day: Schema.String,
  quota: Schema.Number,
  quotaSource: Schema.Literals(["configured", "cloudflare", "fallback"]),
  sent: Schema.Struct({
    transactional: Schema.Number,
    campaign: Schema.Number,
    automation: Schema.Number,
    mailbox: Schema.Number,
  }),
  bulkRemaining: Schema.Number,
  transactionalReserve: Schema.Number,
  resetsAt: Schema.Number,
  providerThisMinute: ProviderCounts,
  warming: Schema.Array(
    Schema.Struct({
      domain: Schema.String,
      warmingSince: Schema.String,
      day: Schema.Number,
      cap: Schema.Number,
      sentToday: Schema.Number,
    }),
  ),
  config: GovernorConfigSchema,
})

export class GovernorUnreachable extends Schema.TaggedError<GovernorUnreachable>()(
  "GovernorUnreachable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export class SendingApi extends HttpApiGroup.make("sending")
  .add(
    HttpApiEndpoint.get("governor", "/v1/sending/governor", {
      success: GovernorOverviewSchema,
      error: [Forbidden, GovernorUnreachable],
    }),
    /** Whether each sending domain's delivery events reach Mailyard (subscription and ledger). */
    HttpApiEndpoint.get("events", "/v1/sending/events", {
      success: Schema.Struct({
        domains: Schema.Array(
          Schema.Struct({
            domain: Schema.String,
            subscribed: Schema.NullOr(Schema.Boolean),
            withEvents: Schema.Number,
            silent: Schema.Number,
            status: Schema.Literals(["ok", "warn", "unknown"]),
            detail: Schema.String,
          }),
        ),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("getSettings", "/v1/settings/sending", {
      success: GovernorConfigSchema,
      error: [Forbidden, GovernorUnreachable],
    }),
    HttpApiEndpoint.put("putSettings", "/v1/settings/sending", {
      payload: GovernorPatchSchema,
      success: GovernorConfigSchema,
      error: [Forbidden, GovernorUnreachable],
    }),
  )
  .middleware(ApiKeyAuth) {}

export const AlertSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  severity: Schema.Literals(["info", "warning", "critical"]),
  title: Schema.String,
  detail: Schema.String,
  subject: Schema.NullOr(Schema.Struct({ type: Schema.String, id: Schema.String })),
  createdAt: Schema.Number,
  resolvedAt: Schema.NullOr(Schema.Number),
  resolvedBy: Schema.NullOr(Schema.String),
})

export class AlertsApi extends HttpApiGroup.make("alerts")
  .add(
    HttpApiEndpoint.get("list", "/v1/alerts", {
      query: {
        status: Schema.optionalKey(Schema.Literals(["open", "resolved", "all"])),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({ alerts: Schema.Array(AlertSchema), nextCursor: Schema.NullOr(Schema.String) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("resolve", "/v1/alerts/:id/resolve", {
      params: { id: Schema.String },
      success: AlertSchema,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// Campaigns (docs/email-ui.html: Campaigns list, Campaign editor)

const CampaignStatusSchema = Schema.Literals(["draft", "scheduled", "sending", "paused", "sent", "cancelled"])
const AbSchema = Schema.Struct({
  percent: Schema.Number,
  waitHours: Schema.Number,
  metric: Schema.Literals(["clicks", "opens"]),
})

export const CampaignSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: CampaignStatusSchema,
  segmentId: Schema.NullOr(Schema.String),
  topicId: Schema.NullOr(Schema.String),
  templateId: Schema.NullOr(Schema.String),
  templateVersion: Schema.NullOr(Schema.Number),
  bodyHtml: Schema.NullOr(Schema.String),
  bodyText: Schema.NullOr(Schema.String),
  fromAddress: Schema.String,
  replyTo: Schema.NullOr(Schema.String),
  subject: Schema.String,
  subjectB: Schema.NullOr(Schema.String),
  preheader: Schema.NullOr(Schema.String),
  ab: Schema.NullOr(AbSchema),
  trackOpens: Schema.Boolean,
  trackClicks: Schema.Boolean,
  sendAt: Schema.NullOr(Schema.Number),
  audienceSize: Schema.NullOr(Schema.Number),
  pausedReason: Schema.NullOr(Schema.String),
  abWinner: Schema.NullOr(Schema.Literals(["a", "b"])),
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
})

const CampaignReportSchema = Schema.Struct({
  campaignId: Schema.String,
  status: CampaignStatusSchema,
  audience: Count,
  sent: Count,
  delivered: Count,
  pending: Count,
  tracked: Schema.Boolean,
  opened: Count,
  machineOnlyOpens: Count,
  machineOpenShare: Schema.Number,
  clicked: Count,
  replied: Count,
  unsubscribed: Count,
  bounced: Schema.Struct({ hard: Count, soft: Count }),
  complained: Count,
  failed: Count,
  rates: Schema.Struct({
    delivery: Schema.Number,
    open: Schema.Number,
    click: Schema.Number,
    clickToOpen: Schema.Number,
    bounce: Schema.Number,
    complaint: Schema.Number,
    unsubscribe: Schema.Number,
  }),
  providers: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      sent: Count,
      delivered: Count,
      bounced: Count,
      complained: Count,
      opened: Count,
    }),
  ),
  links: Schema.Array(Schema.Struct({ url: Schema.String, clicks: Count, machineClicks: Count })),
  activity: Schema.Array(Schema.Struct({ hour: Count, opens: Count, clicks: Count })),
  ab: Schema.NullOr(
    Schema.Struct({
      metric: Schema.Literals(["clicks", "opens"]),
      winner: Schema.NullOr(Schema.Literals(["a", "b"])),
      variants: Schema.Array(
        Schema.Struct({
          variant: Schema.Literals(["a", "b"]),
          subject: Schema.String,
          sent: Count,
          opened: Count,
          clicked: Count,
        }),
      ),
    }),
  ),
})

const CampaignRecipientSchema = Schema.Struct({
  messageId: Schema.String,
  contactId: Schema.NullOr(Schema.String),
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  status: Schema.String,
  bounceType: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  variant: Schema.NullOr(Schema.String),
  openedAt: Schema.NullOr(Schema.Number),
  clickedAt: Schema.NullOr(Schema.Number),
  opens: Count,
  clicks: Count,
  machineOpens: Count,
  unsubscribed: Schema.Boolean,
  sentAt: Schema.Number,
})

const CampaignFields = {
  segmentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  topicId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  templateId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bodyHtml: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bodyText: Schema.optionalKey(Schema.NullOr(Schema.String)),
  replyTo: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subjectB: Schema.optionalKey(Schema.NullOr(Schema.String)),
  preheader: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  ab: Schema.optionalKey(Schema.NullOr(AbSchema)),
  trackOpens: Schema.optionalKey(Schema.Boolean),
  trackClicks: Schema.optionalKey(Schema.Boolean),
}

const CheckSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["pass", "warn", "fail"]),
  title: Schema.String,
  detail: Schema.String,
})

const ComplianceSchema = Schema.Struct({
  postalAddress: Schema.NullOr(Schema.String),
  linkAllowlist: Schema.Array(Schema.String),
  seedAddresses: Schema.Array(Schema.String),
  trackingOrigin: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const ContactImportSchema = Schema.Struct({
  id: Schema.String,
  uploadId: Schema.String,
  status: Schema.Literals(["queued", "running", "completed", "failed"]),
  mapping: Schema.Record(Schema.String, Schema.String),
  topicIds: Schema.Array(Schema.String),
  onConflict: Schema.Literals(["update", "skip"]),
  defaultStatus: Schema.Literals(["subscribed", "unsubscribed"]),
  headers: Schema.NullOr(Schema.Array(Schema.String)),
  rows: Schema.Number,
  created: Schema.Number,
  updated: Schema.Number,
  skipped: Schema.Number,
  invalid: Schema.Number,
  duplicates: Schema.Number,
  suppressed: Schema.Number,
  errors: Schema.Array(Schema.Struct({ line: Schema.Number, message: Schema.String })),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
})

/** Contact CSV imports. The file goes up first, as the body of `POST /v1/uploads?filename=` (50 MiB). */
export class ImportsApi extends HttpApiGroup.make("imports")
  .add(
    HttpApiEndpoint.post("contacts", "/v1/imports/contacts", {
      payload: Schema.Struct({
        uploadId: Schema.String,
        /** Column header → `email`, `name`, `status`, `fields.<name>` or `ignore`. */
        mapping: Schema.Record(Schema.String, Schema.String),
        topicIds: Schema.optionalKey(Schema.Array(Schema.String)),
        /** An address that's already a contact: merge the row into it, or leave it alone. */
        onConflict: Schema.optionalKey(Schema.Literals(["update", "skip"])),
        /** New contacts' status when the file has no status column (or the cell is empty). */
        defaultStatus: Schema.optionalKey(Schema.Literals(["subscribed", "unsubscribed"])),
      }),
      success: ContactImportSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("list", "/v1/imports", {
      query: { cursor: Schema.optionalKey(Schema.String), limit: Limit },
      success: Schema.Struct({
        imports: Schema.Array(ContactImportSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/imports/:id", {
      params: { id: Schema.String },
      success: ContactImportSchema,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

const ContactExportSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("contacts"),
  status: Schema.Literals(["running", "completed", "failed"]),
  rows: Schema.Number,
  fields: Schema.Array(Schema.String),
  filename: Schema.String,
  /** A signed link to the CSV, good for a day; null until it's written. */
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
})

/** CSV exports of the contacts list, with the list's filters. */
export class ExportsApi extends HttpApiGroup.make("exports")
  .add(
    HttpApiEndpoint.post("create", "/v1/exports", {
      payload: Schema.Struct({
        kind: Schema.Literal("contacts"),
        filter: Schema.optionalKey(
          Schema.Struct({
            q: Schema.optionalKey(Schema.String),
            status: Schema.optionalKey(ContactStatusSchema),
            topicId: Schema.optionalKey(Schema.String),
            engagement: Schema.optionalKey(EngagementSchema),
            segmentId: Schema.optionalKey(Schema.String),
            field: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
            event: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
          }),
        ),
        /** Custom fields to add as columns, in this order. */
        fields: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      success: ContactExportSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("list", "/v1/exports", {
      query: { cursor: Schema.optionalKey(Schema.String), limit: Limit },
      success: Schema.Struct({
        exports: Schema.Array(ContactExportSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/exports/:id", {
      params: { id: Schema.String },
      success: ContactExportSchema,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class CampaignsApi extends HttpApiGroup.make("campaigns")
  .add(
    HttpApiEndpoint.get("list", "/v1/campaigns", {
      query: {
        status: Schema.optionalKey(Schema.Union([CampaignStatusSchema, Schema.Literal("active")])),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        campaigns: Schema.Array(CampaignSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/campaigns", {
      payload: Schema.Struct({
        name: Schema.String,
        fromAddress: Schema.String,
        subject: Schema.String,
        ...CampaignFields,
      }),
      success: CampaignSchema,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/campaigns/:id", {
      params: { id: Schema.String },
      success: CampaignSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/campaigns/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        fromAddress: Schema.optionalKey(Schema.String),
        subject: Schema.optionalKey(Schema.String),
        ...CampaignFields,
      }),
      success: CampaignSchema,
      error: [Forbidden, NotFound, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.delete("remove", "/v1/campaigns/:id", {
      params: { id: Schema.String },
      success: Schema.Struct({ id: Schema.String, deleted: Schema.Boolean }),
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("render", "/v1/campaigns/:id/render", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        contactId: Schema.optionalKey(Schema.String),
        variant: Schema.optionalKey(Schema.Literals(["a", "b"])),
      }),
      success: Schema.Struct({
        subject: Schema.String,
        html: Schema.String,
        text: Schema.String,
        headers: Schema.Record(Schema.String, Schema.String),
        size: Schema.Number,
        /** Mailyard added the unsubscribe footer because the content had no such link. */
        footerAdded: Schema.Boolean,
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("test", "/v1/campaigns/:id/test", {
      params: { id: Schema.String },
      payload: Schema.Struct({ to: Schema.optionalKey(Schema.Array(Schema.String)) }),
      success: Schema.Struct({
        sent: Schema.Array(
          Schema.Struct({ email: Schema.String, messageId: Schema.String, status: Schema.String }),
        ),
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("checks", "/v1/campaigns/:id/checks", {
      params: { id: Schema.String },
      success: Schema.Struct({ ready: Schema.Boolean, checks: Schema.Array(CheckSchema) }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("audiencePreview", "/v1/campaigns/:id/audience/preview", {
      params: { id: Schema.String },
      success: Schema.Struct({
        matching: Schema.Number,
        sendable: Schema.Number,
        excluded: Schema.Struct({
          blocked: Schema.Number,
          unsubscribed: Schema.Number,
          unconfirmed: Schema.Number,
          notOnTopic: Schema.Number,
        }),
      }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("schedule", "/v1/campaigns/:id/schedule", {
      params: { id: Schema.String },
      /** When to start; now when absent. */
      payload: Schema.Struct({ sendAt: Schema.optionalKey(Schema.Number) }),
      success: CampaignSchema,
      error: [Forbidden, NotFound, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.post("pause", "/v1/campaigns/:id/pause", {
      params: { id: Schema.String },
      success: CampaignSchema,
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("resume", "/v1/campaigns/:id/resume", {
      params: { id: Schema.String },
      success: CampaignSchema,
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("cancel", "/v1/campaigns/:id/cancel", {
      params: { id: Schema.String },
      success: CampaignSchema,
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.get("pace", "/v1/campaigns/:id/pace", {
      params: { id: Schema.String },
      success: Schema.Struct({
        paused: Schema.Boolean,
        reason: Schema.NullOr(Schema.String),
        sent: Schema.Number,
        delivered: Schema.Number,
        bounced: Schema.Number,
        complained: Schema.Number,
        remaining: Schema.Number,
        eta: Schema.Struct({ days: Schema.NullOr(Schema.Number), at: Schema.NullOr(Schema.Number) }),
      }),
      error: [Forbidden, NotFound, GovernorUnreachable],
    }),
    HttpApiEndpoint.get("report", "/v1/campaigns/:id/report", {
      params: { id: Schema.String },
      success: CampaignReportSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("recipients", "/v1/campaigns/:id/recipients", {
      params: { id: Schema.String },
      query: {
        status: Schema.optionalKey(Schema.Literals(RECIPIENT_FILTERS)),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        recipients: Schema.Array(CampaignRecipientSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, NotFound],
    }),
    /** A draft for the people who received this campaign and didn't open it. */
    HttpApiEndpoint.post("resendNonOpeners", "/v1/campaigns/:id/resend-non-openers", {
      params: { id: Schema.String },
      success: CampaignSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("getCompliance", "/v1/settings/compliance", {
      success: ComplianceSchema,
      error: Forbidden,
    }),
    HttpApiEndpoint.put("putCompliance", "/v1/settings/compliance", {
      payload: Schema.Struct({
        postalAddress: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
        linkAllowlist: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+\.[a-z]{2,}$/i))),
        seedAddresses: Schema.Array(
          Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
        ).check(Schema.isMaxLength(5)),
        trackingOrigin: Schema.optionalKey(
          Schema.NullOr(Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9.-]+$/i))),
        ),
      }),
      success: ComplianceSchema,
      error: [Forbidden, InvalidRequest],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class MailApi extends HttpApi.make("mailyard")
  .add(SystemApi)
  .add(ActionsApi)
  .add(ApiKeysApi)
  .add(MessagesApi)
  .add(TemplatesApi)
  .add(SettingsApi)
  .add(WebhooksApi)
  .add(InsightsApi)
  .add(InboundApi)
  .add(DomainsApi)
  .add(MailboxesApi)
  .add(IdentitiesApi)
  .add(MailApiGroup)
  .add(RulesApi)
  .add(TransfersApi)
  .add(ContactsApi)
  .add(TopicsApi)
  .add(FormsApi)
  .add(SegmentsApi)
  .add(SendingApi)
  .add(AlertsApi)
  .add(CampaignsApi)
  .add(ImportsApi)
  .add(ExportsApi)
  .annotateMerge(OpenApi.annotations({ title: "Mailyard API" })) {}

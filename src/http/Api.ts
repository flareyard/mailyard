import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { ApiKeyAuth, Forbidden } from "./Auth.ts"

export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  app: Schema.Literal("mailflare"),
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
        /** Mailflare addition: sent, deferred (queued for retry), failed or rejected. */
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

/** Mailflare's HTTP API. The UI contract (docs/plans/email-ui.html#contract) grows here, group by group. */
export class MailApi extends HttpApi.make("mailflare")
  .add(SystemApi)
  .add(ActionsApi)
  .add(ApiKeysApi)
  .add(MessagesApi)
  .add(TemplatesApi)
  .add(SettingsApi)
  .annotateMerge(OpenApi.annotations({ title: "Mailflare API" })) {}
